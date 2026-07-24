// Boot-time configuration, loaded from .env and validated. The app refuses to
// start on invalid crypto config rather than failing mid-publish (doc 01 §6).
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { ensureEnv } from './scripts/ensure-env.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..');

function loadDotEnv() {
  ensureEnv();
  const p = resolve(appRoot, '.env');
  if (!existsSync(p)) return;
  const text = readFileSync(p, 'utf8');
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadDotEnv();

function req(name) {
  const v = process.env[name];
  if (!v || v.trim() === '') {
    console.error(`\n[config] FATAL: ${name} is required but missing.`);
    console.error('[config] Delete app/.env and reinstall, or set the value manually.\n');
    process.exit(1);
  }
  return v;
}

export const config = {
  env: process.env.NODE_ENV || 'development',
  port: Number(process.env.API_PORT || 3001),
  webUrl: process.env.WEB_URL || 'http://localhost:3001',
  appRoot,
  dataDir: resolve(appRoot, 'server', 'data'),
  publicDir: resolve(appRoot, 'server', 'public'),

  masterKek: req('MASTER_KEK'),
  jwtAccessSecret: req('JWT_ACCESS_SECRET'),
  jwtRefreshSecret: req('JWT_REFRESH_SECRET'),

  bootstrap: {
    username: process.env.BOOTSTRAP_ADMIN_USERNAME || 'admin',
    password: process.env.BOOTSTRAP_ADMIN_PASSWORD || 'golu9588',
    recoveryEmail: process.env.BOOTSTRAP_ADMIN_RECOVERY_EMAIL || '',
  },

  oauth: {
    meta: { id: process.env.META_APP_ID || '', secret: process.env.META_APP_SECRET || '' },
    linkedin: { id: process.env.LINKEDIN_CLIENT_ID || '', secret: process.env.LINKEDIN_CLIENT_SECRET || '' },
    google: { id: process.env.GOOGLE_CLIENT_ID || '', secret: process.env.GOOGLE_CLIENT_SECRET || '' },
  },
};

// Validate that crypto keys decode to 32 bytes — a truncated key is a silent
// footgun that only shows up when the first secret fails to decrypt.
for (const k of ['masterKek', 'jwtAccessSecret', 'jwtRefreshSecret']) {
  const bytes = Buffer.from(config[k], 'base64');
  if (bytes.length < 32) {
    console.error(`[config] FATAL: ${k} must be at least 32 bytes (got ${bytes.length}).`);
    process.exit(1);
  }
}
