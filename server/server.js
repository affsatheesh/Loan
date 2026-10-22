'use strict';
const http = require('node:http'); const fs = require('node:fs'); const path = require('node:path');
const H = require('./http'); require('./routes_core'); require('./routes_ops');

const PUBLIC = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json', '.ico': 'image/x-icon', '.png': 'image/png', '.webmanifest': 'application/manifest+json' };
const SEC = { 'x-content-type-options': 'nosniff', 'x-frame-options': 'SAMEORIGIN', 'referrer-policy': 'no-referrer',
  'content-security-policy': "default-src 'self'; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; script-src 'self'; frame-src 'self' blob:; object-src 'self' blob:; frame-ancestors 'self'" };

function readBody(req, limit = 12 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', c => { n += c.length; if (n > limit) { reject(new H.ApiError(413, 'Request too large.')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { if (!n) return resolve({}); try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { reject(new H.ApiError(400, 'Invalid JSON.')); } });
    req.on('error', reject);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x'); const secure = process.env.HS_SECURE_COOKIE === '1';
  res.sendRaw = (status, buf, type, extra = {}) => { res.writeHead(status, { 'content-type': type, 'content-length': buf.length, ...SEC, ...extra }); res.end(buf); res._done = true; };
  res.setCookie = t => res.setHeader('set-cookie', `hs_session=${t}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${H.SESSION_MS / 1000}${secure ? '; Secure' : ''}`);
  res.clearCookie = () => res.setHeader('set-cookie', `hs_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0${secure ? '; Secure' : ''}`);
  const json = (status, obj) => res.sendRaw(status, Buffer.from(JSON.stringify(obj)), 'application/json; charset=utf-8', { 'cache-control': 'no-store' });

  if (url.pathname.startsWith('/api/')) {
    try {
      const r = H.routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) throw H.notFound('Unknown endpoint');
      if (req.method !== 'GET' && req.headers['x-requested-with'] !== 'hsfinance') throw H.forbidden('Missing request header.'); // CSRF guard
      const m = url.pathname.match(r.re); const params = {}; r.keys.forEach((k, i) => params[k] = decodeURIComponent(m[i + 1]));
      let user = null;
      if (!r.opts.public) {
        user = H.userFromReq(req); if (!user) throw new H.ApiError(401, 'Your session has expired. Please log in again.');
        if (!r.opts.roles.includes(user.role)) throw H.forbidden();
        if (user.must_change && !r.opts.allowMustChange && url.pathname !== '/api/me') throw new H.ApiError(403, 'You must change your temporary password first.');
      }
      const body = req.method === 'GET' ? {} : await readBody(req);
      const out = await r.handler({ req, res, user, params, query: Object.fromEntries(url.searchParams), body });
      if (!res._done) json(200, out ?? { ok: true });
    } catch (e) {
      if (res._done) return;
      if (e instanceof H.ApiError) return json(e.status, { error: e.message });
      console.error('Unhandled error:', e); json(500, { error: 'Something went wrong on the server. Nothing was saved.' });
    }
    return;
  }
  // static
  let p = url.pathname === '/' ? '/index.html' : url.pathname; const file = path.normalize(path.join(PUBLIC, p));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return res.sendRaw(404, Buffer.from('Not found'), 'text/plain');
  res.sendRaw(200, fs.readFileSync(file), MIME[path.extname(file)] || 'application/octet-stream', { 'cache-control': 'no-cache' });
}
const server = http.createServer((req, res) => { handle(req, res).catch(e => { console.error(e); try { res.statusCode = 500; res.end('error'); } catch {} }); });
module.exports = { server };
if (require.main === module) {
  const port = Number(process.env.PORT) || 3000, host = process.env.HOST || '127.0.0.1';
  server.listen(port, host, () => console.log(`HS Small Finance running at http://${host}:${port}${process.env.DEMO_MODE === '1' ? '  [DEMO MODE: OTP codes are shown on screen]' : ''}`));
}
