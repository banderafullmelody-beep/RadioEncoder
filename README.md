# RadioEncoder Gateway v3
Recibe audio del navegador por WebSocket, lo convierte a MP3 con ffmpeg y lo envía a cualquier servidor Icecast o Shoutcast.
Cada usuario escribe sus propios datos de conexión en la consola; el gateway no los guarda.

## Protocolos
`icecast` (SOURCE, el más común, p. ej. Zeno FM), `icecast-put` (Icecast 2.4+), `shoutcast1`, `shoutcast2` (con SID). Opción TLS para servidores con conexión segura.

## Render
- Build: `npm install` · Start: `npm start`
- Variables de entorno:
  - `ALLOWED_ORIGINS`: dirección(es) de tu sitio con la consola, ej. `https://tusitio.com` (recomendado: sin esto cualquiera puede usar tu gateway).
  - `GATEWAY_TOKEN`: clave opcional, la misma que se escribe en la consola.
  - `MAX_STREAMS` (por defecto 3) y `MAX_PER_IP` (por defecto 1): límites para no saturar el plan gratuito.
  - `ALLOWED_HOSTS`: opcional; si lo defines, solo se permiten esos servidores (ej. `link.zeno.fm`).
  - `MP3_BITRATE`: por defecto `128k`.
- Seguridad: se bloquean IPs privadas/locales y puertos sensibles.
- Comprobación: `https://TU-GATEWAY.onrender.com/health` debe decir `ok`.
