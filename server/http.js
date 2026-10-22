'use strict';
const crypto = require('node:crypto');
const { q } = require('./db');

class ApiError extends Error { constructor(status, message) { super(message); this.status = status; } }
const bad = m => new ApiError(400, m), forbidden = m => new ApiError(403, m || 'You do not have permission to do that.'),
  notFound = m => new ApiError(404, m || 'Not found'), conflict = m => new ApiError(409, m);

const routes = [];
function route(method, pattern, opts, handler) {
  if (typeof opts === 'function') { handler = opts; opts = {}; }
  const keys = []; const re = new RegExp('^' + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  routes.push({ method, re, keys, opts, handler });
}

// ---------- passwords & sessions ----------
const SESSION_MS = 8 * 3600 * 1000;
function hashPassword(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function verifyPassword(pw, salt, hash) {
  const a = Buffer.from(crypto.scryptSync(pw, salt, 64).toString('hex')); const b = Buffer.from(hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function checkPasswordStrength(pw) {
  if (typeof pw !== 'string' || pw.length < 8) return 'Password must be at least 8 characters.';
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return 'Password must contain letters and numbers.';
  return null;
}
const sha = t => crypto.createHash('sha256').update(t).digest('hex');
async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  await q.run('INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)', sha(token), userId, Date.now() + SESSION_MS);
  return token;
}
function parseCookies(h) {
  const o = {}; for (const part of (h || '').split(';')) { const i = part.indexOf('='); if (i > 0) o[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } return o;
}
async function userFromReq(req) {
  const t = parseCookies(req.headers.cookie).hs_session; if (!t) return null;
  const s = await q.get('SELECT * FROM sessions WHERE token_hash=?', sha(t));
  if (!s) return null;
  if (s.expires_at < Date.now()) { await q.run('DELETE FROM sessions WHERE token_hash=?', s.token_hash); return null; }
  const u = await q.get('SELECT * FROM users WHERE id=?', s.user_id);
  if (!u || u.status !== 'ACTIVE') return null; // deactivated users lose access immediately
  req.sessionHash = s.token_hash; return u;
}
async function destroySession(req) { if (req.sessionHash) await q.run('DELETE FROM sessions WHERE token_hash=?', req.sessionHash); }
function publicUser(u) {
  return { id: u.id, code: u.code, username: u.username, name: u.name, role: u.role, mobile: u.mobile, email: u.email,
    status: u.status, mustChange: !!u.must_change, customerId: u.customer_id };
}

// ---------- file storage (random ids; never user-supplied names) ----------
// Netlify Blobs on Netlify; a plain folder when HS_FILES_DIR is set (tests and offline runs).
const fs = require('node:fs'); const path = require('node:path');
const ALLOWED = { 'image/jpeg': [[0xFF, 0xD8, 0xFF]], 'image/png': [[0x89, 0x50, 0x4E, 0x47]], 'application/pdf': [[0x25, 0x50, 0x44, 0x46]],
  'image/webp': [[0x52, 0x49, 0x46, 0x46]] };
const MAX_FILE = 4 * 1024 * 1024; // Netlify Functions accept request bodies up to 6 MB; base64 adds a third
const fileStore = () => require('@netlify/blobs').getStore({ name: 'hs-files', consistency: 'strong' });
async function saveFile(dataUrlOrB64, mime) {
  if (!ALLOWED[mime]) throw bad('File type not allowed. Use JPG, PNG, WEBP or PDF.');
  const b64 = String(dataUrlOrB64 || '').replace(/^data:[^,]*,/, '');
  const buf = Buffer.from(b64, 'base64');
  if (!buf.length) throw bad('File is empty or unreadable.');
  if (buf.length > MAX_FILE) throw bad('File is larger than 4 MB.');
  if (!ALLOWED[mime].some(sig => sig.every((b, i) => buf[i] === b))) throw bad('File content does not match its type; it may be corrupted.');
  const id = crypto.randomUUID();
  if (process.env.HS_FILES_DIR) { fs.mkdirSync(process.env.HS_FILES_DIR, { recursive: true }); fs.writeFileSync(path.join(process.env.HS_FILES_DIR, id), buf); }
  else if (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL) await q.run('INSERT INTO hs_file_objects(id,data) VALUES(?,?)', id, buf);
  else await fileStore().set(id, buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
  return { id, size: buf.length };
}
async function readFile(id) {
  if (!/^[0-9a-f-]{36}$/.test(id)) throw notFound();
  if (process.env.HS_FILES_DIR) {
    const p = path.join(process.env.HS_FILES_DIR, id); if (!fs.existsSync(p)) throw notFound('File missing');
    return fs.readFileSync(p);
  }
  if (process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL) {
    const row = await q.get('SELECT data FROM hs_file_objects WHERE id=?', id);
    if (!row) throw notFound('File missing');
    return Buffer.from(row.data);
  }
  const data = await fileStore().get(id, { type: 'arrayBuffer' }); if (!data) throw notFound('File missing');
  return Buffer.from(data);
}

module.exports = { ApiError, bad, forbidden, notFound, conflict, routes, route, hashPassword, verifyPassword, checkPasswordStrength,
  createSession, userFromReq, destroySession, publicUser, saveFile, readFile, SESSION_MS };
