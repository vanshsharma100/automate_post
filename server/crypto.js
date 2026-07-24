// Crypto services (doc 01 §7, doc 08 §4).
//
// Envelope encryption: MASTER_KEK (env) wraps a per-tenant DEK; the DEK wraps
// individual secrets (provider API keys, OAuth tokens, Shopify tokens). All
// AES-256-GCM with a random 96-bit IV and an auth tag stored alongside.
//
// Passwords: Argon2id is the production choice (doc 08 §2). To keep this build
// installable with zero native modules we use Node's built-in scrypt, which is
// a sound memory-hard KDF. The record is versioned ("scrypt$...") so a later
// migration to argon2 is a drop-in.
//
// Tokens: minimal JWT (HS256) implemented on node:crypto — no external lib.
import crypto from 'node:crypto';
import { config } from './config.js';

const ALG = 'aes-256-gcm';

function kekBytes() {
  return Buffer.from(config.masterKek, 'base64').subarray(0, 32);
}

function encryptWithKey(keyBytes, plaintext) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, keyBytes, iv);
  const ct = Buffer.concat([cipher.update(Buffer.from(String(plaintext), 'utf8')), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

function decryptWithKey(keyBytes, packed) {
  if (typeof packed !== 'string' || !packed.startsWith('v1:')) {
    throw new Error('bad ciphertext format');
  }
  const [, ivB64, tagB64, ctB64] = packed.split(':');
  const iv = Buffer.from(ivB64, 'base64');
  const tag = Buffer.from(tagB64, 'base64');
  const ct = Buffer.from(ctB64, 'base64');
  const decipher = crypto.createDecipheriv(ALG, keyBytes, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

// ── Per-tenant DEK lifecycle ────────────────────────────────────────────────
export function generateWrappedDek() {
  const dek = crypto.randomBytes(32);
  return encryptWithKey(kekBytes(), dek.toString('base64'));
}

function unwrapDek(dataKeyEncrypted) {
  const dekB64 = decryptWithKey(kekBytes(), dataKeyEncrypted);
  return Buffer.from(dekB64, 'base64');
}

// Encrypt/decrypt a tenant-scoped secret using that tenant's DEK.
export function encryptSecret(tenant, plaintext) {
  if (plaintext == null || plaintext === '') return null;
  const dek = unwrapDek(tenant.dataKeyEncrypted);
  return encryptWithKey(dek, plaintext);
}

export function decryptSecret(tenant, packed) {
  if (!packed) return null;
  const dek = unwrapDek(tenant.dataKeyEncrypted);
  return decryptWithKey(dek, packed);
}

// Re-wrap every tenant DEK under a freshly rotated KEK without touching the
// ciphertext rows (doc 08 §4). Used by the crypto:rotate CLI.
export function rewrapDek(oldKekB64, dataKeyEncrypted) {
  const oldKek = Buffer.from(oldKekB64, 'base64').subarray(0, 32);
  const dekB64 = decryptWithKey(oldKek, dataKeyEncrypted);
  return encryptWithKey(kekBytes(), dekB64);
}

// ── Password hashing (scrypt) ───────────────────────────────────────────────
export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const N = 16384, r = 8, p = 1, keylen = 64;
  const derived = crypto.scryptSync(String(password), salt, keylen, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${derived.toString('base64')}`;
}

export function verifyPassword(password, stored) {
  try {
    if (!stored || !stored.startsWith('scrypt$')) return false;
    const [, N, r, p, saltB64, hashB64] = stored.split('$');
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    const derived = crypto.scryptSync(String(password), salt, expected.length, {
      N: Number(N), r: Number(r), p: Number(p),
    });
    return crypto.timingSafeEqual(derived, expected);
  } catch {
    return false;
  }
}

// ── Minimal JWT (HS256) ─────────────────────────────────────────────────────
function b64url(buf) {
  return Buffer.from(buf).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}
function b64urlJson(obj) {
  return b64url(JSON.stringify(obj));
}
function fromB64url(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

export function signJwt(payload, { secret, expiresInSec }) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + expiresInSec };
  const head = b64urlJson(header);
  const claims = b64urlJson(body);
  const data = `${head}.${claims}`;
  const sig = b64url(crypto.createHmac('sha256', secret).update(data).digest());
  return `${data}.${sig}`;
}

export function verifyJwt(token, secret) {
  try {
    const [head, claims, sig] = String(token).split('.');
    if (!head || !claims || !sig) return null;
    const data = `${head}.${claims}`;
    const expected = b64url(crypto.createHmac('sha256', secret).update(data).digest());
    const a = Buffer.from(sig), b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const payload = JSON.parse(fromB64url(claims).toString('utf8'));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

export const accessToken = {
  sign: (payload) => signJwt(payload, { secret: config.jwtAccessSecret, expiresInSec: 15 * 60 }),
  verify: (t) => verifyJwt(t, config.jwtAccessSecret),
};

// ── Ids and misc ─────────────────────────────────────────────────────────────
const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';
export function cuid(prefix = 'c') {
  const rand = crypto.randomBytes(12);
  let out = '';
  for (const byte of rand) out += ALPHABET[byte % ALPHABET.length];
  return `${prefix}_${Date.now().toString(36)}${out}`;
}

export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

export function sha256(input) {
  return crypto.createHash('sha256').update(input).digest('hex');
}

export function hmac(secret, data) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

// First 7 + last 4 of a secret, for safe display (doc 08 §4).
export function keyPreview(secret) {
  if (!secret) return '';
  const s = String(secret);
  if (s.length <= 12) return `${s.slice(0, 3)}…`;
  return `${s.slice(0, 7)}…${s.slice(-4)}`;
}
