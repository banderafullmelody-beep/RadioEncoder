# RadioEncoder Gateway v2
Recibe audio WebM/Opus del navegador por WebSocket, lo convierte a MP3 con ffmpeg y lo envía a Zeno FM.

## Render
- Build: `npm install` · Start: `npm start`
- Variables de entorno (Settings > Environment):
  - `GATEWAY_TOKEN`: clave que escribirás también en la consola (recomendado).
  - `ALLOWED_ORIGINS`: tu sitio, ej. `https://tusitio.com` (separa varios con coma).
  - `ALLOWED_HOSTS`: por defecto `link.zeno.fm`.
  - `MP3_BITRATE`: opcional, por defecto `128k`.
- Comprobación: abre `https://radioencoder.onrender.com/health` y debe decir `ok`.
