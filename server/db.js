'use strict';
// Netlify Database (Postgres). The schema lives in db/schema.ts; migrations in netlify/database/migrations are
// applied by Netlify at deploy time. SQL in the route files keeps SQLite-style `?` placeholders; q converts them.
const { AsyncLocalStorage } = require('node:async_hooks');

// bigint (int8) and numeric (SUM of bigint) come back from Postgres as strings; amounts here are paise and
// timestamps are epoch ms, both well inside Number's safe range.
const toNum = v => (v == null ? v : Number(v));
const PARSERS = { 20: toNum, 1700: toNum };
const types = { getTypeParser: (oid, format) => PARSERS[oid] || require('pg').types.getTypeParser(oid, format) };

let pool = null;
function getPool() {
  if (!pool) pool = require('@netlify/database').getDatabase().pool;
  return pool;
}
function setPool(p) { pool = p; } // used by tests to run against an in-process Postgres

const txClient = new AsyncLocalStorage();
const NO_ID = new Set(['sessions', 'counters']);
function prepare(sql, params) {
  let n = 0; let text = sql.replace(/\?/g, () => '$' + ++n);
  const m = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(text);
  if (m && !NO_ID.has(m[1]) && !/\bRETURNING\b/i.test(text)) text += ' RETURNING id';
  const values = params.map(v => (typeof v === 'number' && Number.isNaN(v) ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v === undefined ? null : v));
  return { text, values, types };
}
async function exec(sql, params) { return (txClient.getStore() || getPool()).query(prepare(sql, params)); }

const q = {
  all: async (sql, ...p) => (await exec(sql, p)).rows,
  get: async (sql, ...p) => (await exec(sql, p)).rows[0],
  run: async (sql, ...p) => { const r = await exec(sql, p); return { changes: r.rowCount, lastInsertRowid: r.rows[0]?.id }; },
};
// One transaction at a time, like SQLite's BEGIN IMMEDIATE: every money/status change is serialized.
async function tx(fn) {
  if (txClient.getStore()) return fn();
  const client = await getPool().connect();
  try {
    await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(7311)');
    const r = await txClient.run(client, fn);
    await client.query('COMMIT'); return r;
  } catch (e) { try { await client.query('ROLLBACK'); } catch (_) {} throw e; } finally { client.release(); }
}
async function nextRef(prefix, name = prefix) {
  const { value } = await q.get('INSERT INTO counters(name,value) VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=counters.value+1 RETURNING value', name);
  return `${prefix}-${new Date().getFullYear()}-${String(value).padStart(5, '0')}`;
}
async function audit(userId, action, entity, entityId, detail) {
  await q.run('INSERT INTO audit(user_id,action,entity,entity_id,detail,at) VALUES(?,?,?,?,?,?)',
    userId ?? null, action, entity ?? null, entityId == null ? null : String(entityId), detail ? String(detail).slice(0, 2000) : null, Date.now());
}
async function notify(userIds, type, title, body, entity, entityId) {
  for (const uid of [...new Set([].concat(userIds).filter(Boolean))])
    await q.run('INSERT INTO notifications(user_id,type,title,body,entity,entity_id,created_at) VALUES(?,?,?,?,?,?,?)',
      uid, type, title, body ?? null, entity ?? null, entityId ?? null, Date.now());
}
async function notifyRole(role, type, title, body, entity, entityId) {
  await notify((await q.all("SELECT id FROM users WHERE role=? AND status='ACTIVE'", role)).map(u => u.id), type, title, body, entity, entityId);
}
module.exports = { q, tx, nextRef, audit, notify, notifyRole, setPool, getPool, PARSERS };
