// Audit logging (doc 08 §6). Every security- or money-relevant action writes a
// row: actor, action, entity, before/after (redacted), IP, UA, timestamp.
import { store } from './store.js';

const SECRET_KEYS = ['password', 'apiKey', 'accessToken', 'refreshToken', 'clientSecret', 'authorization', 'cookie', 'apiKeyEnc', 'credentialsEnc', 'accessTokenEnc', 'passwordHash', 'dataKeyEncrypted', 'mfaSecretEnc'];
const TOKEN_PREFIXES = [/shpat_[A-Za-z0-9]+/g, /sk-[A-Za-z0-9-]+/g, /EAA[A-Za-z0-9]+/g, /AQV[A-Za-z0-9]+/g, /ya29\.[A-Za-z0-9._-]+/g, /ghp_[A-Za-z0-9]+/g];

export function redact(obj) {
  if (obj == null) return obj;
  if (typeof obj === 'string') {
    let s = obj;
    for (const re of TOKEN_PREFIXES) s = s.replace(re, '[redacted]');
    return s;
  }
  if (Array.isArray(obj)) return obj.map(redact);
  if (typeof obj === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(obj)) {
      if (SECRET_KEYS.includes(k)) out[k] = '[redacted]';
      else out[k] = redact(v);
    }
    return out;
  }
  return obj;
}

export function audit(req, action, { entityType, entityId, before, after } = {}) {
  try {
    store.insert('auditLogs', {
      tenantId: req?.auth?.tenantId || null,
      userId: req?.auth?.userId || null,
      action,
      entityType: entityType || null,
      entityId: entityId || null,
      before: before ? redact(before) : null,
      after: after ? redact(after) : null,
      ipAddress: req?.ip || null,
      userAgent: req?.headers?.['user-agent'] || null,
    });
  } catch (e) {
    console.warn('[audit] failed:', e.message);
  }
}
