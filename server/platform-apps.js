// OAuth app credentials (client id + secret) for the platforms that need them,
// settable from the UI instead of app/.env + restart. The secret is encrypted
// at rest under the tenant DEK; .env stays a valid fallback so existing setups
// keep working unchanged.
import { store } from './store.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { config } from './config.js';

// Where each platform's .env fallback lives, and what the env keys are called.
const ENV_FALLBACK = {
  LINKEDIN: { get: () => config.oauth.linkedin, keys: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'] },
  GOOGLE_BUSINESS: { get: () => config.oauth.google, keys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'] },
  FACEBOOK: { get: () => config.oauth.meta, keys: ['META_APP_ID', 'META_APP_SECRET'] },
  INSTAGRAM: { get: () => config.oauth.meta, keys: ['META_APP_ID', 'META_APP_SECRET'] },
};

export function envKeysFor(platform) {
  return ENV_FALLBACK[platform]?.keys || [];
}

function row(platform) {
  return store.findOne('platformApps', (a) => a.platform === platform);
}

export function getPlatformApp(platform) {
  const r = row(platform);
  if (r?.clientId) {
    let secret = '';
    try {
      const tenant = store.get('tenants', r.tenantId);
      secret = tenant ? decryptSecret(tenant, r.clientSecretEnc) || '' : '';
    } catch { secret = ''; }
    if (secret) return { clientId: r.clientId, clientSecret: secret, source: 'ui', extra: r.extra || {} };
  }
  const env = ENV_FALLBACK[platform]?.get() || {};
  if (env.id && env.secret) return { clientId: env.id, clientSecret: env.secret, source: 'env', extra: {} };
  return { clientId: '', clientSecret: '', source: 'none', extra: {} };
}

export function setPlatformApp(tenant, platform, { clientId, clientSecret, extra }) {
  const id = String(clientId || '').trim();
  const secret = String(clientSecret || '').trim();
  if (!id || !secret) { const e = new Error('Both Client ID and Client Secret are required'); e.status = 400; throw e; }
  const existing = row(platform);
  const patch = { platform, tenantId: tenant.id, clientId: id, clientSecretEnc: encryptSecret(tenant, secret), extra: extra || existing?.extra || {} };
  return existing ? store.update('platformApps', existing.id, patch) : store.insert('platformApps', patch);
}

export function clearPlatformApp(platform) {
  store.removeWhere('platformApps', (a) => a.platform === platform);
}

export function isAppConfigured(platform) {
  const a = getPlatformApp(platform);
  return !!(a.clientId && a.clientSecret);
}
