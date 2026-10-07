import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, chmodSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

export const ROOT = path.dirname(fileURLToPath(import.meta.url));
export const TABLE = JSON.parse(readFileSync(path.join(ROOT, 'tabela.json'), 'utf8'));
export const hash = text => createHash('sha256').update(text).digest('hex');
export const token = () => randomBytes(32).toString('hex');
const derive = promisify(scrypt);
export async function passwordHash(password) {
  const salt = randomBytes(16).toString('hex');
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function passwordMatches(password, stored) {
  const [, salt, expected] = stored.split(':');
  const key = await derive(password, salt, 64, { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const other = Buffer.from(expected, 'hex');
  return key.length === other.length && timingSafeEqual(key, other);
}
export function validPassword(value) {
  return typeof value === 'string' && value.length >= 8 && value.length <= 128 && !/[\u0000-\u001f]/.test(value) && /[a-z]/.test(value) && /[A-Z]/.test(value) && /[0-9]/.test(value);
}
export function openStore(dataDir = process.env.DATA_DIR || path.join(ROOT, 'data')) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const filename = path.join(dataDir, 'filadavez.sqlite');
  const db = new DatabaseSync(filename, { timeout: 5000 });
  try { chmodSync(filename, 0o600); } catch { /* Windows */ }
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY, login TEXT UNIQUE NOT NULL, email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL, nome TEXT NOT NULL, pais TEXT NOT NULL,
      documento TEXT NOT NULL, telefone TEXT NOT NULL, nivel TEXT NOT NULL,
      sponsor_id TEXT REFERENCES users(id), role TEXT NOT NULL DEFAULT 'member',
      pix_tipo TEXT NOT NULL DEFAULT '', pix_chave TEXT NOT NULL DEFAULT '', titular TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sessions (
      digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), nivel TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK(amount_cents>0), status TEXT NOT NULL CHECK(status='pending'),
      created_at INTEGER NOT NULL, UNIQUE(user_id,nivel)
    );
    CREATE TABLE IF NOT EXISTS recovery_requests (
      user_id TEXT PRIMARY KEY REFERENCES users(id), requested_at INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending'
    );
    CREATE TABLE IF NOT EXISTS resets (
      digest TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS limits (
      key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, action TEXT NOT NULL, created_at INTEGER NOT NULL
    );`);
  return db;
}
export function transaction(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const value = fn(); db.exec('COMMIT'); return value; }
  catch (error) { db.exec('ROLLBACK'); throw error; }
}
export function publicUser(db, row) {
  const sponsor = row.sponsor_id ? db.prepare('SELECT login FROM users WHERE id=?').get(row.sponsor_id)?.login : null;
  return { id: row.id, login: row.login, email: row.email, nome: row.nome, pais: row.pais,
    documento: row.documento, telefone: row.telefone, nivel: row.nivel, sponsor,
    role: row.role, pixTipo: row.pix_tipo, pixChave: row.pix_chave, titular: row.titular,
    status: 'pending', createdAt: row.created_at };
}
export function issueReset(db, email, appURL) {
  const user = db.prepare('SELECT id FROM users WHERE email=? OR login=?').get(email.toLowerCase(), email.toLowerCase());
  if (!user) throw new Error('Conta não encontrada.');
  const value = token();
  transaction(db, () => {
    db.prepare('DELETE FROM resets WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO resets VALUES(?,?,?)').run(hash(value), user.id, Date.now() + 30 * 60 * 1000);
    db.prepare("UPDATE recovery_requests SET status='link_created' WHERE user_id=?").run(user.id);
    db.prepare('INSERT INTO audit(user_id,action,created_at) VALUES(?,?,?)').run(user.id,'reset_link_created',Date.now());
  });
  return `${appURL}/recuperar.html#token=${value}`;
}
