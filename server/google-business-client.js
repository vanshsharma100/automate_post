// Real Google Business Profile client — the GBP twin of linkedin-client.js.
//
// Google has no long-lived pasteable token, so the durable credential here is a
// REFRESH token: paste one (or complete the OAuth redirect) and the connector
// mints a fresh access token on every call. Three ways in:
//   1. OAuth redirect     — needs client id/secret, settable from the UI.
//   2. Paste refresh token — from OAuth Playground or your own flow. Durable.
//   3. Paste access token  — works immediately but dies in ~60 minutes. Testing only.
//
// IMPORTANT REALITY CHECK: unlike LinkedIn, GBP API access is not self-serve.
// Google requires an approved quota request per Cloud project before any of
// these endpoints answer, and until then every call returns 403 PERMISSION_DENIED
// no matter how valid the token is. The connector detects that exact condition
// and says so, rather than looking broken.
import { store } from './store.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { config } from './config.js';
import { DEFAULT_CADENCE } from './constants.js';
import { getPlatformApp, setPlatformApp, clearPlatformApp } from './platform-apps.js';

const OAUTH_TOKEN = 'https://oauth2.googleapis.com/token';
const OAUTH_AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const ACCOUNTS_API = 'https://mybusinessaccountmanagement.googleapis.com/v1';
const INFO_API = 'https://mybusinessbusinessinformation.googleapis.com/v1';
const POSTS_API = 'https://mybusiness.googleapis.com/v4';   // localPosts still lives on v4

export const GBP_SCOPES = ['https://www.googleapis.com/auth/business.manage'];

export const getGoogleApp = () => getPlatformApp('GOOGLE_BUSINESS');
export const setGoogleApp = (tenant, creds) => setPlatformApp(tenant, 'GOOGLE_BUSINESS', creds);
export const clearGoogleApp = () => clearPlatformApp('GOOGLE_BUSINESS');

export function redirectUri() {
  return `${config.webUrl.replace(/\/$/, '')}/api/v1/connections/oauth/GOOGLE_BUSINESS/callback`;
}

export function buildAuthUrl(state) {
  const app = getGoogleApp();
  const params = new URLSearchParams({
    response_type: 'code', client_id: app.clientId, redirect_uri: redirectUri(),
    scope: GBP_SCOPES.join(' '), state,
    access_type: 'offline',   // without this Google never issues a refresh token
    prompt: 'consent',        // and without this it stops re-issuing on re-auth
    include_granted_scopes: 'true',
  });
  return `${OAUTH_AUTH}?${params.toString()}`;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

// Google's 403 covers two completely different problems. Telling them apart is
// the difference between "click here to fix" and "wait for Google".
function gbpError(status, body, fallback) {
  let detail = fallback;
  let reason = '';
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    detail = j?.error?.message || j?.error_description || j?.error || fallback;
    reason = j?.error?.details?.[0]?.reason || j?.error?.status || '';
  } catch { detail = String(body || '').slice(0, 300) || fallback; }

  const text = `${detail} ${reason}`;
  const notEnabled = /has not been used in project|is disabled|SERVICE_DISABLED|accessNotConfigured/i.test(text);
  const noQuota = /PERMISSION_DENIED|insufficient|quota|not been approved/i.test(text);

  const hint =
    status === 401 ? ' → The token is expired or revoked. Reconnect Google Business.'
    : status === 403 && notEnabled ? ' → Enable the APIs in your Google Cloud project: "My Business Account Management API", "My Business Business Information API" and "Google My Business API", then retry.'
    : status === 403 && noQuota ? ' → Your Cloud project has the APIs enabled but no approved GBP quota. Google requires a one-time access request (developers.google.com/my-business → Request access) and approval takes days to weeks. Nothing in this app can bypass it.'
    : status === 403 ? ' → The signed-in Google account does not manage this location.'
    : status === 404 ? ' → Location not found. Re-sync your locations and pick one again.'
    : status === 429 ? ' → Google rate limit. It will be retried automatically.'
    : '';

  const err = new Error(`Google ${status}: ${detail}${hint}`);
  err.status = err.httpStatus = status;
  err.retryable = status === 429 || (status >= 500 && status < 600);
  err.apiNotEnabled = notEnabled;
  err.quotaNotApproved = status === 403 && noQuota && !notEnabled;
  return err;
}

async function gapi(url, { token, method = 'GET', body, timeout = 25000 } = {}) {
  const { signal, done } = timeoutSignal(timeout);
  try {
    const res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw gbpError(res.status, text, `HTTP ${res.status}`);
    let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { json, res };
  } finally { done(); }
}

// ── Token lifecycle ──────────────────────────────────────────────────────────
async function tokenRequest(params) {
  const { signal, done } = timeoutSignal(20000);
  try {
    const res = await fetch(OAUTH_TOKEN, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams(params).toString(),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw gbpError(res.status, text, 'Token request failed');
    return JSON.parse(text);
  } finally { done(); }
}

export async function exchangeAuthCode(code) {
  const app = getGoogleApp();
  const j = await tokenRequest({
    grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
    client_id: app.clientId, client_secret: app.clientSecret,
  });
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || null,
    expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
    scopes: String(j.scope || '').split(/\s+/).filter(Boolean),
  };
}

export async function accessTokenFromRefresh(refreshToken) {
  const app = getGoogleApp();
  if (!app.clientId || !app.clientSecret) {
    const e = new Error('A refresh token needs your Google Client ID and Secret to mint access tokens. Save them first.');
    e.status = 400; throw e;
  }
  const j = await tokenRequest({
    grant_type: 'refresh_token', refresh_token: refreshToken,
    client_id: app.clientId, client_secret: app.clientSecret,
  });
  return {
    accessToken: j.access_token,
    expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
    scopes: String(j.scope || '').split(/\s+/).filter(Boolean),
  };
}

export function credentialsOf(connection) {
  const tenant = store.get('tenants', connection.tenantId);
  try { return JSON.parse(decryptSecret(tenant, connection.credentialsEnc) || '{}'); } catch { return {}; }
}

function saveCredentials(connection, creds, extraPatch = {}) {
  const tenant = store.get('tenants', connection.tenantId);
  store.update('connections', connection.id, {
    credentialsEnc: encryptSecret(tenant, JSON.stringify(creds)),
    tokenExpiresAt: creds.expiresAt || null,
    ...extraPatch,
  });
}

// Google access tokens live ~1 hour, so refreshing is the normal path, not an
// edge case. Refresh 2 minutes early to avoid racing the expiry.
export async function ensureFreshToken(connection, creds) {
  const stillValid = creds.expiresAt && new Date(creds.expiresAt).getTime() - Date.now() > 2 * 60 * 1000;
  if (stillValid && creds.accessToken) return creds;
  if (!creds.refreshToken) {
    if (creds.accessToken && !creds.expiresAt) return creds;   // unknown expiry — let the API judge
    const e = new Error('This Google access token has expired and there is no refresh token to renew it. Reconnect with a refresh token for a durable connection.');
    e.status = 401; throw e;
  }
  const bundle = await accessTokenFromRefresh(creds.refreshToken);
  const next = { ...creds, ...bundle };
  saveCredentials(connection, next, { status: 'CONNECTED' });
  return next;
}

// ── Discovery ────────────────────────────────────────────────────────────────
export async function listAccounts(token) {
  const { json } = await gapi(`${ACCOUNTS_API}/accounts`, { token });
  return (json.accounts || []).map((a) => ({ name: a.name, label: a.accountName || a.name, type: a.type || null }));
}

// Locations for one account. NOTE: the Business Information API returns
// `locations/456`, but the v4 localPosts endpoint requires the account-scoped
// form `accounts/123/locations/456`. Composing that here is what makes
// publishing work — passing the bare name through yields a 404 every time.
export async function listLocations(token, accountName) {
  const url = `${INFO_API}/${accountName}/locations?readMask=name,title,storefrontAddress&pageSize=100`;
  const { json } = await gapi(url, { token });
  return (json.locations || []).map((l) => {
    const bare = String(l.name || '');
    const id = bare.split('/').pop();
    const city = l.storefrontAddress?.locality || l.storefrontAddress?.administrativeArea || '';
    return {
      id: `${accountName}/locations/${id}`,       // account-scoped — what v4 needs
      name: l.title || bare,
      label: city ? `${l.title || bare} — ${city}` : (l.title || bare),
      kind: 'LOCATION',
      accountName,
    };
  });
}

// Every location the signed-in account manages, across all its GBP accounts.
export async function listTargets(token) {
  const accounts = await listAccounts(token);
  const out = [];
  for (const acc of accounts) {
    try { out.push(...(await listLocations(token, acc.name))); }
    catch (e) { if (e.status === 401) throw e; /* skip accounts we can't read */ }
  }
  return out;
}

// ── Connect ──────────────────────────────────────────────────────────────────
function provision(conn) {
  if (store.findOne('platformSchedules', (s) => s.connectionId === conn.id)) return;
  const cad = DEFAULT_CADENCE.GOOGLE_BUSINESS;
  store.insert('platformSchedules', { connectionId: conn.id, isEnabled: false, timezone: 'Asia/Kolkata', slots: cad.slots, maxPerDay: 1, maxPerWeek: cad.perWeek + 2, minGapMinutes: 1440, quietHours: { start: '22:00', end: '07:00' }, categoryRatio: { PRODUCT: 60, KNOWLEDGE: 40 }, autoApproveAbove: 75, leadTimeMinutes: 120 });
  store.insert('platformQuotas', { connectionId: conn.id, maxBytes: 5368709120, usedBytes: 0, retentionDays: 180, purgeStrategy: 'OLDEST_FIRST', keepMetadata: true, keepThumbnails: true, warnAtPercent: 80 });
}

// Validate credentials against the live API, then create/update the connection.
export async function connectGoogleBusiness(tenant, bundle, { label, locationId, connectionId } = {}) {
  let creds = { ...bundle };

  // A refresh token alone is enough — mint the first access token now, which
  // also proves the client id/secret and the refresh token all match.
  if (!creds.accessToken && creds.refreshToken) {
    const minted = await accessTokenFromRefresh(creds.refreshToken);
    creds = { ...creds, ...minted };
  }
  if (!creds.accessToken) { const e = new Error('Provide a refresh token (recommended) or an access token.'); e.status = 400; throw e; }

  // Discover locations. A 401 means the credentials are genuinely bad and must
  // fail hard. A 403 means Google is gating the API (quota not yet approved, or
  // APIs not enabled) — the credentials are perfect and were expensive to
  // obtain, so we keep them and finish setup later instead of throwing the
  // refresh token away and making the user re-authorise.
  let targets = [];
  let pendingReason = null;
  try {
    targets = await listTargets(creds.accessToken);
    if (!targets.length) {
      const e = new Error('This Google account manages no Business Profile locations. Sign in with the account that owns the listing, or ask its owner for a manager invite.');
      e.status = 400; throw e;
    }
  } catch (e) {
    if (e.status !== 403) throw e;
    pendingReason = e.message;
  }

  const target = targets.find((t) => t.id === locationId) || targets[0] || null;
  creds = { ...creds, target, targets };

  let conn = connectionId ? store.get('connections', connectionId) : null;
  if (!conn && target) {
    conn = store.findOne('connections', (c) => c.tenantId === tenant.id && c.platform === 'GOOGLE_BUSINESS'
      && !c.archivedAt && c.externalAccountId === String(target.id));
  }
  if (!conn) {
    // Pending connections have no location id yet — match on the platform alone
    // so re-authorising updates the same row instead of piling up duplicates.
    conn = store.findOne('connections', (c) => c.tenantId === tenant.id && c.platform === 'GOOGLE_BUSINESS'
      && !c.archivedAt && !c.config?.sandbox && c.config?.pendingDiscovery);
  }
  const shared = {
    externalAccountId: target ? String(target.id) : null,
    externalAccountName: target ? (target.label || target.name) : 'Waiting for Google API access',
    scopes: GBP_SCOPES, status: pendingReason ? 'DEGRADED' : 'CONNECTED', isActive: true,
    config: { sandbox: false, live: true, accountName: target?.accountName || null, pendingDiscovery: !!pendingReason, pendingReason },
    lastHealthCheckAt: new Date().toISOString(),
  };
  if (conn) {
    saveCredentials(conn, creds, { ...shared, label: label || conn.label, circuitOpenUntil: null, consecutiveFailures: 0 });
  } else {
    conn = store.insert('connections', {
      tenantId: tenant.id, platform: 'GOOGLE_BUSINESS', mode: 'MANUAL',
      label: label || (target ? `Google Business — ${target.name}` : 'Google Business'),
      credentialsEnc: encryptSecret(tenant, JSON.stringify(creds)),
      tokenExpiresAt: creds.expiresAt || null, ...shared,
    });
  }
  provision(conn);
  return { connection: store.get('connections', conn.id), targets, target, durable: !!creds.refreshToken, pendingReason };
}

// Retry location discovery for a connection saved before Google granted access.
// This is what turns a pending connection into a live one — no re-authorising,
// because the refresh token was kept all along.
export async function syncLocations(connection, { locationId } = {}) {
  let creds = await ensureFreshToken(connection, credentialsOf(connection));
  const targets = await listTargets(creds.accessToken);
  if (!targets.length) {
    const e = new Error('This Google account manages no Business Profile locations.');
    e.status = 400; throw e;
  }
  const target = targets.find((t) => t.id === locationId) || targets.find((t) => t.id === creds.target?.id) || targets[0];
  saveCredentials(connection, { ...creds, target, targets }, {
    externalAccountId: String(target.id), externalAccountName: target.label || target.name,
    status: 'CONNECTED',
    config: { ...(connection.config || {}), pendingDiscovery: false, pendingReason: null, accountName: target.accountName },
    lastHealthCheckAt: new Date().toISOString(),
  });
  return { connection: store.get('connections', connection.id), targets, target };
}

// ── Publishing ───────────────────────────────────────────────────────────────
const CTA_TYPES = ['BOOK', 'ORDER', 'SHOP', 'LEARN_MORE', 'SIGN_UP', 'CALL'];

export async function publishGoogleBusiness(connection, post, media = []) {
  let creds = credentialsOf(connection);
  if (!creds.accessToken && !creds.refreshToken) {
    const e = new Error('This Google Business connection has no stored credentials — reconnect it.'); e.retryable = false; throw e;
  }
  creds = await ensureFreshToken(connection, creds);

  const location = creds.target?.id || connection.externalAccountId;
  if (connection.config?.pendingDiscovery || !location) {
    const e = new Error('This connection is still waiting for Google Business Profile API access — no location could be read yet. Once your access request is approved, click "Finish setup" on the Google Business screen. Your sign-in is saved; you will not need to authorise again.');
    e.retryable = false; throw e;
  }
  if (!/^accounts\/[^/]+\/locations\/[^/]+$/.test(String(location))) {
    const e = new Error('This connection has no valid GBP location (expected accounts/…/locations/…) — reconnect it.');
    e.retryable = false; throw e;
  }

  // GBP posts are plain text, hard-capped at 1500 chars, and hashtags do
  // nothing here — strip them rather than burning characters.
  const summary = String(post.body || '').replace(/\s*#[\w-]+/g, '').trim().slice(0, 1500);
  if (!summary) { const e = new Error('Google Business posts need body text.'); e.retryable = false; throw e; }

  const body = { languageCode: post.languageCode || 'en-US', summary, topicType: 'STANDARD' };

  const ctaUrl = post.linkUrl || post.ctaUrl || null;
  if (ctaUrl) {
    const type = CTA_TYPES.includes(post.callToAction) ? post.callToAction : 'LEARN_MORE';
    body.callToAction = { actionType: type, url: ctaUrl };
  }

  // GBP pulls media by URL — it never accepts uploaded bytes here, so an asset
  // without a public URL simply cannot be attached.
  const notes = [];
  const reachable = (u) => { try { return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(new URL(u).hostname); } catch { return false; } };
  const photo = (media || []).find((m) => m && m.kind === 'IMAGE' && !m.purgedAt && reachable(m.publicUrl || ''));
  if (photo) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: photo.publicUrl }];
  else if ((media || []).some((m) => m && m.kind === 'IMAGE')) {
    notes.push('Image skipped — Google Business fetches media by public URL and this asset is only reachable at a private/localhost address. Set WEB_URL to a public origin to include it. Published as text-only.');
  }

  const { json } = await gapi(`${POSTS_API}/${location}/localPosts`, { token: creds.accessToken, method: 'POST', body });
  if (!json?.name) { const e = new Error('Google accepted the post but returned no post name.'); e.retryable = true; throw e; }
  return {
    externalId: json.name,
    externalUrl: json.searchUrl || `https://business.google.com/posts/l/${String(location).split('/').pop()}`,
    simulated: false,
    ...(notes.length ? { notes } : {}),
  };
}

export async function verifyGoogleBusinessPost(connection, externalId) {
  if (!externalId) return { ok: false, reason: 'no post id' };
  try {
    let creds = await ensureFreshToken(connection, credentialsOf(connection));
    const { json } = await gapi(`${POSTS_API}/${externalId}`, { token: creds.accessToken });
    return { ok: !!json?.name, state: json?.state || null, externalUrl: json?.searchUrl || null };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

export async function healthCheckGoogleBusiness(connection) {
  const now = new Date().toISOString();
  if (connection.config?.sandbox) return { status: 'CONNECTED', at: now, sandbox: true, detail: 'Sandbox connection — publishing is simulated.' };
  const stored = credentialsOf(connection);
  if (!stored.accessToken && !stored.refreshToken) return { status: 'PENDING_AUTH', at: now, detail: 'No credentials stored — connect Google Business.' };
  try {
    const creds = await ensureFreshToken(connection, stored);
    const targets = await listTargets(creds.accessToken);
    const current = creds.target?.id;
    const stillThere = !current || targets.some((t) => t.id === current);
    return {
      status: stillThere ? 'CONNECTED' : 'DEGRADED', at: now,
      detail: stillThere
        ? `Live on ${creds.target?.label || creds.target?.name || 'a location'} · ${targets.length} location(s) manageable${creds.refreshToken ? ' · auto-refresh on' : ' · access token only, expires hourly'}`
        : 'The selected location is no longer managed by this Google account.',
      location: current, locationCount: targets.length, expiresAt: creds.expiresAt || null,
    };
  } catch (e) {
    return { status: e.status === 401 ? 'EXPIRED' : 'ERROR', at: now, detail: e.message, quotaNotApproved: !!e.quotaNotApproved, apiNotEnabled: !!e.apiNotEnabled };
  }
}
