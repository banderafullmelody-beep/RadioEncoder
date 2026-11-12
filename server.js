'use strict';
const http = require('http');
const net = require('net');
const { spawn } = require('child_process');
const { WebSocketServer } = require('ws');
const ffmpegPath = require('ffmpeg-static');

const PORT = process.env.PORT || 8080;
const TOKEN = process.env.GATEWAY_TOKEN || '';
const ORIGINS = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const HOSTS = (process.env.ALLOWED_HOSTS || 'link.zeno.fm').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const BITRATE = process.env.MP3_BITRATE || '128k';
const MAX_RETRIES = 8;

// Que un error suelto nunca tumbe el servidor (ERR_SOCKET_CLOSED, EPIPE, etc.)
process.on('uncaughtException', e => console.error('uncaught:', e.message));
process.on('unhandledRejection', e => console.error('unhandled:', e && e.message));

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); return res.end('ok'); }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server, maxPayload: 1 << 20 });

wss.on('connection', (ws, req) => {
  const origin = req.headers.origin || '';
  if (ORIGINS.length && !ORIGINS.includes(origin)) { ws.close(1008, 'origen no permitido'); return; }
  const send = o => { if (ws.readyState === 1) ws.send(JSON.stringify(o)); };
  let cfg = null, ff = null, sock = null, retries = 0, timer = null, closed = false, live = false, ready = false;
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  function stopAll() {
    closed = true; ready = false; clearTimeout(timer);
    if (ff) { try { ff.stdin.destroy(); ff.kill('SIGKILL'); } catch {} ff = null; }
    if (sock) { sock.destroy(); sock = null; }
  }

  // WebM/Opus del navegador -> MP3 (formato que acepta Zeno FM)
  function startFfmpeg() {
    if (ff) { try { ff.kill('SIGKILL'); } catch {} }
    const me = spawn(ffmpegPath, ['-loglevel', 'error', '-i', 'pipe:0', '-vn', '-c:a', 'libmp3lame', '-b:a', BITRATE, '-ar', '44100', '-ac', '2', '-f', 'mp3', 'pipe:1'], { stdio: ['pipe', 'pipe', 'pipe'] });
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
    const mine = net.connect(cfg.port, cfg.host);
    sock = mine;
    let buf = '';
    mine.setNoDelay(true);
    mine.on('connect', () => {
      const auth = Buffer.from(cfg.user + ':' + cfg.password).toString('base64');
      mine.write('SOURCE ' + cfg.mount + ' HTTP/1.0\r\nAuthorization: Basic ' + auth + '\r\nUser-Agent: RadioEncoder/2.0\r\nContent-Type: audio/mpeg\r\nice-name: La Voz Perú\r\n\r\n');
    });
    mine.on('data', d => {
      if (live) return;
      buf += d.toString('latin1');
      if (!buf.includes('\r\n')) return;
      const line = buf.split('\r\n')[0];
      if (/\s200\s/.test(line + ' ')) { live = true; retries = 0; send({ type: 'status', state: 'live' }); }
      else {
        const fatal = /\s(401|403)\s/.test(line);
        send({ type: 'error', message: 'Zeno FM respondió: ' + line.slice(0, 80), fatal });
        if (fatal) { stopAll(); ws.close(); } else mine.destroy();
      }
    });
    mine.on('error', e => send({ type: 'status', state: 'retry', attempt: retries + 1, error: e.message }));
    mine.on('close', () => {
      if (sock === mine) sock = null;
      live = false;
      if (closed) return;
      if (++retries > MAX_RETRIES) { send({ type: 'error', message: 'No se pudo conectar a Zeno FM tras varios intentos.', fatal: true }); stopAll(); ws.close(); return; }
      send({ type: 'status', state: 'retry', attempt: retries });
      timer = setTimeout(connectIce, Math.min(15000, 1000 * 2 ** retries));
    });
  }

  ws.on('message', (data, isBinary) => {
    if (isBinary) { if (ready && ff && ff.stdin.writable) ff.stdin.write(data); return; }
    let m; try { m = JSON.parse(data.toString()); } catch { return; }
    if (m.type === 'start') {
      if (TOKEN && m.token !== TOKEN) { send({ type: 'error', message: 'Token del gateway incorrecto.', fatal: true }); ws.close(); return; }
      const port = Number(m.port), host = String(m.host || '').trim().toLowerCase(), mount = String(m.mount || '').trim();
      if (!HOSTS.includes(host)) { send({ type: 'error', message: 'Servidor no permitido por el gateway (ALLOWED_HOSTS).', fatal: true }); return; }
      if (!(port > 0 && port < 65536) || !/^\/[\w\-./]+$/.test(mount) || !m.password) { send({ type: 'error', message: 'Datos incompletos: puerto, mount (empieza con /) y contraseña.', fatal: true }); return; }
      cfg = { host, port, mount, user: String(m.user || 'source').slice(0, 60), password: String(m.password) };
      connectIce();
    } else if (m.type === 'sync') { if (cfg) { ready = true; startFfmpeg(); } }
    else if (m.type === 'stop') { stopAll(); ws.close(); }
  });
  ws.on('close', stopAll);
  ws.on('error', stopAll);
});

// Mantiene viva la conexión en Render y descarta clientes muertos
setInterval(() => wss.clients.forEach(c => { if (!c.isAlive) return c.terminate(); c.isAlive = false; c.ping(); }), 25000);
server.listen(PORT, () => console.log('Gateway escuchando en el puerto ' + PORT));
