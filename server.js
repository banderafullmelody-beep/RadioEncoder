'use strict';
const http = require('http'), net = require('net'), tls = require('tls'), dns = require('dns').promises;
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const ffmpegPath = require('ffmpeg-static');

const list = v => (v || '').split(',').map(s => s.trim()).filter(Boolean);
const PORT = process.env.PORT || 8080;
const TOKEN = process.env.GATEWAY_TOKEN || '';
const ORIGINS = list(process.env.ALLOWED_ORIGINS);
const HOSTS = list(process.env.ALLOWED_HOSTS).map(s => s.toLowerCase());   // opcional: vacío = cualquier servidor público
const DEF_BR = process.env.MP3_BITRATE || '128k';
const MAX_STREAMS = +process.env.MAX_STREAMS || 3;
const PER_IP = +process.env.MAX_PER_IP || 1;
const MAX_RETRIES = 8;
const BR = ['64k', '96k', '128k', '192k'];
const PROTOS = ['icecast', 'icecast-put', 'shoutcast1', 'shoutcast2'];
const BAD_PORTS = new Set([22, 23, 25, 53, 110, 143, 445, 465, 587, 993, 995, 3306, 3389, 5432, 6379, 9200, 11211, 27017]);

process.on('uncaughtException', e => console.error('uncaught:', e.message));
process.on('unhandledRejection', e => console.error('unhandled:', e && e.message));

// Evita que el gateway sea usado para atacar redes internas
function isPrivate(ip) {
  if (ip.startsWith('::ffff:')) ip = ip.slice(7);
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const x = ip.toLowerCase();
  return x === '::1' || x === '::' || /^f[cd]/.test(x) || /^fe[89ab]/.test(x);
}
async function resolvePublic(host) {
  if (net.isIP(host)) { if (isPrivate(host)) throw new Error('Dirección no permitida'); return [host]; }
  const r = await dns.lookup(host, { all: true });
  if (!r.length || r.some(a => isPrivate(a.address))) throw new Error('El servidor no es público o no se pudo resolver');
  return r.sort((a, b) => a.family - b.family).map(a => a.address);   // IPv4 primero: Render no sale por IPv6
}

let total = 0;
const perIp = new Map();

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.length && !ORIGINS.includes(origin)) { ws.close(1008, 'origen no permitido'); return; }
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  let cfg = null, ff = null, sock = null, retries = 0, timer = null, closed = false, live = false, ready = false, counted = false, lastErr = '';
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  function stopAll() {
    closed = true; ready = false; clearTimeout(timer);
    if (ff) { try { ff.stdin.destroy(); ff.kill('SIGKILL'); } catch {} ff = null; }
    if (sock) { sock.destroy(); sock = null; }
    if (counted) { counted = false; total--; perIp.set(ip, Math.max(0, (perIp.get(ip) || 1) - 1)); }
  }

  function startFfmpeg() {
    if (ff) { try { ff.kill('SIGKILL'); } catch {} }
    const me = spawn(ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', cfg.br, '-ar', '44100', '-ac', '2', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    ff = me;
    me.stdin.on('error', () => {});
    me.stderr.on('data', d => console.error('ffmpeg:', String(d).trim().slice(0, 200)));
    me.stdout.on('data', chunk => { if (live && sock && sock.writable && !sock.destroyed) sock.write(chunk); });
    me.on('exit', () => { if (ff === me && !closed) { ff = null; ready = false; send({ type: 'need_header' }); } });
  }

  function connectIce() {
    if (closed) return;
    live = false;
    send({ type: 'status', state: 'connecting' });
    const opts = { host: cfg.ips[retries % cfg.ips.length], port: cfg.port };
    console.log('Conectando a', opts.host + ':' + opts.port, cfg.proto);
    const mine = cfg.tls ? tls.connect({ ...opts, servername: cfg.host }) : net.connect(opts);
    sock = mine;
    let buf = '', sent = false;
    mine.setTimeout(15000, () => { lastErr = 'tiempo de espera agotado'; mine.destroy(); });
    const goLive = () => { mine.setTimeout(0); console.log('Conectado al servidor de streaming'); live = true; retries = 0; send({ type: 'status', state: 'live' }); };
    const fail = (line, fatal) => {
      send({ type: 'error', message: 'El servidor respondió: ' + line.slice(0, 80), fatal });
      if (fatal) { stopAll(); ws.close(); } else mine.destroy();
    };
    const hello = () => {
      if (sent) return; sent = true;
      const b64 = Buffer.from(cfg.user + ':' + cfg.password).toString('base64');
      const ice = 'ice-name: ' + cfg.name + '\r\n';
      if (cfg.proto === 'icecast') mine.write('SOURCE ' + cfg.mount + ' HTTP/1.0\r\nAuthorization: Basic ' + b64 + '\r\nUser-Agent: RadioEncoder/3.0\r\nContent-Type: audio/mpeg\r\n' + ice + '\r\n');
      else if (cfg.proto === 'icecast-put') mine.write('PUT ' + cfg.mount + ' HTTP/1.1\r\nHost: ' + cfg.host + ':' + cfg.port + '\r\nAuthorization: Basic ' + b64 + '\r\nUser-Agent: RadioEncoder/3.0\r\nContent-Type: audio/mpeg\r\n' + ice + 'Expect: 100-continue\r\n\r\n');
      else mine.write(cfg.password + (cfg.proto === 'shoutcast2' ? ':#' + cfg.sid : '') + '\r\n');
    };
    mine.on(cfg.tls ? 'secureConnect' : 'connect', hello);
    mine.setNoDelay && mine.setNoDelay(true);
    mine.on('data', d => {
      if (live) return;
      buf += d.toString('latin1');
      if (!buf.includes('\n')) return;
      const line = buf.split(/\r?\n/)[0];
      console.log('Respuesta del servidor:', line.slice(0, 80));
      if (cfg.proto.startsWith('shoutcast')) {
        if (/^OK/i.test(line)) { mine.write('icy-name:' + cfg.name + '\r\nicy-pub:0\r\nicy-br:' + parseInt(cfg.br) + '\r\ncontent-type:audio/mpeg\r\n\r\n'); goLive(); }
        else fail(line, true);
      } else if (/\s(100|200)\s/.test(line + ' ')) goLive();
      else fail(line, /\s(401|403)\s/.test(line));
    });
    mine.on('error', e => { lastErr = e.code || e.message; console.error('Socket:', lastErr); send({ type: 'status', state: 'retry', attempt: retries + 1, error: lastErr }); });
    mine.on('close', () => {
      if (sock === mine) sock = null;
      live = false;
      if (closed) return;
      if (++retries > MAX_RETRIES) { send({ type: 'error', message: 'No se pudo conectar al servidor de streaming' + (lastErr ? ' (' + lastErr + ')' : '') + ' tras varios intentos.', fatal: true }); stopAll(); ws.close(); return; }
      send({ type: 'status', state: 'retry', attempt: retries });
      timer = setTimeout(connectIce, Math.min(15000, 1000 * 2 ** retries));
    });
  }

  async function handle(data, isBinary) {
    if (isBinary) { if (ready && ff && ff.stdin.writable) ff.stdin.write(data); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'start') {
      if (cfg) return;
      const bad = msg => { send({ type: 'error', message: msg, fatal: true }); };
      if (TOKEN && m.token !== TOKEN) { bad('Token del gateway incorrecto.'); ws.close(); return; }
      const proto = PROTOS.includes(m.proto) ? m.proto : 'icecast';
      const port = Number(m.port), host = String(m.host || '').trim().toLowerCase();
      let mount = String(m.mount || '').replace(/[\s\u200B-\u200D\uFEFF]/g, '');
      if (/^[a-z]+:\/\//i.test(mount)) { try { mount = new URL(mount).pathname; } catch {} }
      if (mount && mount[0] !== '/') mount = '/' + mount;
      if (!host || !/^[a-z0-9.\-:]+$/.test(host)) return bad('Servidor no válido.');
      if (HOSTS.length && !HOSTS.includes(host)) return bad('Este gateway no permite ese servidor.');
      if (!(port > 0 && port < 65536) || BAD_PORTS.has(port)) return bad('Puerto no válido.');
      if (!proto.startsWith('shoutcast') && !/^\/[\w\-./]+$/.test(mount)) return bad('El mount debe empezar con / (ej: /stream).');
      if (!m.password) return bad('Falta la contraseña.');
      if (total >= MAX_STREAMS || (perIp.get(ip) || 0) >= PER_IP) return bad('El gateway está ocupado. Intenta más tarde.');
      let addr;
      try { addr = await resolvePublic(host); } catch (e) { return bad(e.message); }
      if (closed || cfg) return;
      total++; counted = true; perIp.set(ip, (perIp.get(ip) || 0) + 1);
      cfg = { proto, host, ips: addr, port, mount, tls: !!m.tls, sid: Math.max(1, Math.min(99, parseInt(m.sid) || 1)), user: String(m.user || 'source').replace(/[\r\n:]/g, '').slice(0, 60) || 'source',
        password: String(m.password).replace(/[\r\n]/g, ''), br: BR.includes(m.bitrate) ? m.bitrate : DEF_BR,
        name: String(m.name || 'Radio').replace(/[^\w \-.áéíóúñÁÉÍÓÚÑ]/g, '').slice(0, 60) || 'Radio' };
      connectIce();
    } else if (m.type === 'sync') { if (cfg) { ready = true; console.log('Audio recibido: iniciando conversión'); startFfmpeg(); } }
    else if (m.type === 'stop') { stopAll(); ws.close(); }
  }
  // Los mensajes se procesan uno tras otro: así 'sync' y el audio nunca se adelantan a 'start'
  let queue = Promise.resolve();
  ws.on('message', (d, b) => { queue = queue.then(() => handle(d, b)).catch(e => console.error('mensaje:', e && e.message)); });
  ws.on('close', stopAll);
  ws.on('error', stopAll);
});

setInterval(() => wss.clients.forEach(c => { if (!c.isAlive) return c.terminate(); c.isAlive = false; c.ping(); }), 25000);
server.listen(PORT, () => console.log('Gateway escuchando en el puerto ' + PORT));
