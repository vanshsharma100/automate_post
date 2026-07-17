'use strict';

/**
 * Central configuration + secret bootstrap.
 *
 * SECURITY: The two server-only secrets below (MASTER_KEY for AES encryption,
 * SESSION_SECRET for signed cookies) come from environment variables in
 * production. For zero-setup local development, if they are not present we
 * generate strong random values ONCE and persist them to data/.secrets.json
 * (git-ignored). They are never sent to the browser and never stored in the DB.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, '..', 'data');
const SECRETS_FILE = path.join(DATA_DIR, '.secrets.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadOrCreateLocalSecrets() {
  ensureDataDir();
  let stored = {};
  if (fs.existsSync(SECRETS_FILE)) {
    try {
      stored = JSON.parse(fs.readFileSync(SECRETS_FILE, 'utf8'));
    } catch (_) {
      stored = {};
    }
  }
  let changed = false;
  if (!stored.MASTER_KEY) {
    stored.MASTER_KEY = crypto.randomBytes(32).toString('hex'); // 256-bit key
    changed = true;
  }
  if (!stored.SESSION_SECRET) {
    stored.SESSION_SECRET = crypto.randomBytes(48).toString('hex');
    changed = true;
  }
  if (changed) {
    fs.writeFileSync(SECRETS_FILE, JSON.stringify(stored, null, 2), { mode: 0o600 });
  }
  return stored;
}

const local = loadOrCreateLocalSecrets();

const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  nodeEnv: process.env.NODE_ENV || 'development',
  // Prefer environment variables (production). Fall back to local generated file.
  masterKey: process.env.MASTER_KEY || local.MASTER_KEY,
  sessionSecret: process.env.SESSION_SECRET || local.SESSION_SECRET,
  dataDir: DATA_DIR,
  // Default recovery email (editable in Settings). Requested by the owner.
  defaultRecoveryEmail: 'vansh76840405@gmail.com',
  // Default admin credentials created on first run (change after first login).
  defaultAdminUser: 'admin',
  defaultAdminPass: 'ChangeMe@123',
};

if (Buffer.from(config.masterKey, 'hex').length !== 32) {
  throw new Error('MASTER_KEY must be 32 bytes (64 hex chars).');
}

module.exports = config;
