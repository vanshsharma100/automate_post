// Ensures a .env exists with strong crypto secrets before first boot.
// Runs on `npm install` (postinstall) and is also called defensively at startup.
import { existsSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const appRoot = resolve(__dirname, '..', '..');
const envPath = resolve(appRoot, '.env');
const examplePath = resolve(appRoot, '.env.example');

function b64(n) {
  return randomBytes(n).toString('base64');
}

export function ensureEnv() {
  if (!existsSync(envPath)) {
    if (existsSync(examplePath)) copyFileSync(examplePath, envPath);
    else writeFileSync(envPath, '');
  }
  let text = readFileSync(envPath, 'utf8');
  const secrets = {
    MASTER_KEK: () => b64(32),
    JWT_ACCESS_SECRET: () => b64(32),
    JWT_REFRESH_SECRET: () => b64(32),
  };
  let changed = false;
  for (const [key, gen] of Object.entries(secrets)) {
    const re = new RegExp(`^${key}=(.*)$`, 'm');
    const m = text.match(re);
    if (!m || m[1].trim() === '') {
      const line = `${key}=${gen()}`;
      text = m ? text.replace(re, line) : `${text.trim()}\n${line}\n`;
      changed = true;
    }
  }
  if (changed) {
    writeFileSync(envPath, text);
    console.log('[ensure-env] Generated crypto secrets into .env');
  }
  return envPath;
}

// Allow running directly: `node server/scripts/ensure-env.js`
if (import.meta.url === `file://${process.argv[1].replace(/\\/g, '/')}` || process.argv[1]?.endsWith('ensure-env.js')) {
  try {
    ensureEnv();
  } catch (e) {
    // Never fail the install over this.
    console.warn('[ensure-env] skipped:', e.message);
  }
}
