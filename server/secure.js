'use strict';
// AES-256-GCM field encryption for identity numbers (PAN, voter ID, Aadhaar) stored in the database.
const crypto = require('node:crypto'); const fs = require('node:fs'); const path = require('node:path');
const { DATA_DIR } = require('./db');
function loadKey() {
  if (process.env.HS_ENC_KEY) return crypto.createHash('sha256').update(process.env.HS_ENC_KEY).digest();
  const p = path.join(DATA_DIR, '.enckey');
  if (!fs.existsSync(p)) fs.writeFileSync(p, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(p, 'utf8').trim(), 'hex');
}
const KEY = loadKey();
function enc(text) {
  if (text == null || text === '') return null;
  const iv = crypto.randomBytes(12); const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([c.update(String(text), 'utf8'), c.final()]);
  return ['enc1', iv.toString('hex'), c.getAuthTag().toString('hex'), ct.toString('hex')].join(':');
}
function dec(v) {
  if (!v) return null; if (!String(v).startsWith('enc1:')) return v;
  const [, iv, tag, ct] = v.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'hex')); d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(ct, 'hex')), d.final()]).toString('utf8');
}
module.exports = { enc, dec };
