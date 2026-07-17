'use strict';

/**
 * Cryptography helpers. ALL of this runs server-side only.
 *
 *  - Passwords: scrypt with a random per-password salt (no plaintext stored).
 *  - Secrets (API keys, tokens): AES-256-GCM authenticated encryption.
 *    The 256-bit key comes from config.masterKey (env var / local secrets file),
 *    never from the database. A DB dump therefore reveals only ciphertext.
 */

const crypto = require('crypto');
const config = require('./config');

const MASTER = Buffer.from(config.masterKey, 'hex');

/* ----------------------------- Passwords ----------------------------- */

function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derived = crypto.scryptSync(String(password), salt, 64);
  return `scrypt$${salt.toString('hex')}$${derived.toString('hex')}`;
}

function verifyPassword(password, stored) {
  try {
    const [scheme, saltHex, hashHex] = String(stored).split('$');
    if (scheme !== 'scrypt') return false;
    const salt = Buffer.from(saltHex, 'hex');
    const expected = Buffer.from(hashHex, 'hex');
    const derived = crypto.scryptSync(String(password), salt, expected.length);
    return crypto.timingSafeEqual(expected, derived);
  } catch (_) {
    return false;
  }
}

/* ------------------------ Secret encryption -------------------------- */

// Returns a compact string "v1:ivHex:tagHex:cipherHex" or '' for empty input.
function encrypt(plaintext) {
  if (plaintext === undefined || plaintext === null || plaintext === '') return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${enc.toString('hex')}`;
}

function decrypt(payload) {
  if (!payload) return '';
  try {
    const [ver, ivHex, tagHex, dataHex] = String(payload).split(':');
    if (ver !== 'v1') return '';
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const data = Buffer.from(dataHex, 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(data), decipher.final()]);
    return dec.toString('utf8');
  } catch (_) {
    return '';
  }
}

/* --------------------------- Display mask ---------------------------- */

// Never returns the real secret; shows a safe hint like "sk-ant-••••3f9a".
function maskSecret(plaintext) {
  if (!plaintext) return '';
  const s = String(plaintext);
  if (s.length <= 8) return '••••••••';
  const head = s.slice(0, 6);
  const tail = s.slice(-4);
  return `${head}••••${tail}`;
}

// Random URL-safe token / temporary password.
function randomToken(bytes = 12) {
  return crypto.randomBytes(bytes).toString('base64url');
}

module.exports = {
  hashPassword,
  verifyPassword,
  encrypt,
  decrypt,
  maskSecret,
  randomToken,
};
