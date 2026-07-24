// Real LinkedIn API client — the LinkedIn equivalent of shopify-client.js.
//
// Two ways to connect, both producing a real, live connection (no simulation):
//   1. Paste an access token  — fastest. LinkedIn's developer portal can mint a
//      member token for your own app ("Auth → Generate access token"), exactly
//      like a Shopify custom-app Admin token. No redirect URI, no callback.
//   2. OAuth authorization-code — client id/secret can now be set from the UI
//      (stored encrypted in the DB) instead of only app/.env + restart.
//
// Everything below hits real LinkedIn endpoints. Tokens are validated before
// they are saved, stored AES-256-GCM encrypted under the tenant DEK, and
// refreshed automatically when the app has refresh tokens enabled.
import { store } from './store.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { config } from './config.js';
import { DEFAULT_CADENCE } from './constants.js';
import { getPlatformApp, setPlatformApp, clearPlatformApp } from './platform-apps.js';
import { readAssetBytes } from './media-store.js';

const API = 'https://api.linkedin.com';
const OAUTH_BASE = 'https://www.linkedin.com/oauth/v2';

// Versioned LinkedIn APIs (/rest/*) require a LinkedIn-Version: YYYYMM header.
// A version is only valid for ~1 year, so a hardcoded one silently rots and
// every publish starts failing with HTTP 426. We negotiate instead: try the
// configured/last-known-good version first, then walk this list on a 426, and
// remember whatever worked.
const VERSION_CANDIDATES = [
  process.env.LINKEDIN_API_VERSION,
  '202506', '202505', '202504', '202503', '202502', '202501',
  '202411', '202408', '202405', '202401',
].filter(Boolean);

let negotiatedVersion = null;   // process-wide cache of the last version LinkedIn accepted

// Member posting + identity. Organisation scopes are additive and only needed
// if you publish as a Company Page.
export const MEMBER_SCOPES = ['openid', 'profile', 'email', 'w_member_social'];
export const ORG_SCOPES = ['r_organization_social', 'w_organization_social', 'rw_organization_admin'];

export function scopesFor({ organizations = false } = {}) {
  return organizations ? [...MEMBER_SCOPES, ...ORG_SCOPES] : MEMBER_SCOPES;
}

// ── Runtime app credentials (UI-configurable, no restart) ────────────────────
// Shared with the other OAuth connectors — see platform-apps.js.
export const getLinkedInApp = () => getPlatformApp('LINKEDIN');
export const setLinkedInApp = (tenant, creds) => setPlatformApp(tenant, 'LINKEDIN', creds);
export const clearLinkedInApp = () => clearPlatformApp('LINKEDIN');

export function redirectUri() {
  return `${config.webUrl.replace(/\/$/, '')}/api/v1/connections/oauth/LINKEDIN/callback`;
}

// ── Low-level fetch helpers ──────────────────────────────────────────────────
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

function liError(status, body, fallback) {
  let detail = fallback;
  try {
    const j = typeof body === 'string' ? JSON.parse(body) : body;
    detail = j?.message || j?.error_description || j?.error?.message || j?.error || fallback;
  } catch { detail = String(body || '').slice(0, 300) || fallback; }
  const hint =
    status === 401 ? ' → The access token is invalid, revoked or expired. Reconnect LinkedIn.'
    : status === 403 ? ' → Your LinkedIn app is missing a required product/scope. Add "Share on LinkedIn" (w_member_social) and "Sign In with LinkedIn using OpenID Connect", then reconnect so the new scopes are granted.'
    : status === 422 ? ' → LinkedIn rejected the post body (usually unescaped special characters or an invalid author URN).'
    : status === 429 ? ' → Rate limited by LinkedIn. It will be retried automatically.'
    : '';
  const err = new Error(`LinkedIn ${status}: ${detail}${hint}`);
  err.status = err.httpStatus = status;
  err.retryable = status === 429 || (status >= 500 && status < 600);
  return err;
}

// Plain /v2 (non-versioned) call.
async function liFetch(path, { token, method = 'GET', body, headers = {}, timeout = 20000 } = {}) {
  const { signal, done } = timeoutSignal(timeout);
  try {
    const res = await fetch(`${API}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'X-Restli-Protocol-Version': '2.0.0',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...headers,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw liError(res.status, text, `HTTP ${res.status}`);
    let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return { json, res };
  } finally { done(); }
}

// Versioned /rest call with automatic LinkedIn-Version negotiation.
async function liRest(path, { token, method = 'GET', body, headers = {}, timeout = 25000, version } = {}) {
  const tryOrder = version ? [version]
    : [negotiatedVersion, ...VERSION_CANDIDATES].filter((v, i, a) => v && a.indexOf(v) === i);
  let last = null;
  for (const v of tryOrder) {
    const { signal, done } = timeoutSignal(timeout);
    try {
      const res = await fetch(`${API}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'LinkedIn-Version': v,
          'X-Restli-Protocol-Version': '2.0.0',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal,
      });
      const text = await res.text();
      if (res.status === 426) { last = liError(426, text, 'Unsupported LinkedIn-Version'); continue; }
      if (!res.ok) throw liError(res.status, text, `HTTP ${res.status}`);
      negotiatedVersion = v;
      let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
      return { json, res, version: v };
    } finally { done(); }
  }
  throw last || new Error('LinkedIn rejected every known API version — set LINKEDIN_API_VERSION in app/.env.');
}

// ── Identity / targets ───────────────────────────────────────────────────────
// Resolve the member behind a token. There are three ways to ask, each gated by
// a different product/scope, and which ones a token can use depends entirely on
// which products the app has:
//   /v2/userinfo  ← "Sign In with LinkedIn using OpenID Connect" (openid+profile)
//   /rest/me      ← versioned equivalent, some apps only answer here
//   /v2/me        ← legacy, needs r_liteprofile (no longer self-serve)
// A token with ONLY w_member_social ("Share on LinkedIn") can publish perfectly
// but cannot answer any of them — so we must report that precisely rather than
// leaking whichever error happened to come last.
export async function resolveMember(token) {
  const attempts = [];

  try {
    const { json } = await liFetch('/v2/userinfo', { token });
    if (json?.sub) return { id: `urn:li:person:${json.sub}`, name: json.name || json.given_name || 'My LinkedIn', kind: 'PERSON', email: json.email || null, picture: json.picture || null };
    attempts.push('/v2/userinfo returned no subject');
  } catch (e) {
    if (e.status === 401) throw e;   // dead token — no point trying the rest
    attempts.push(`/v2/userinfo → ${e.status}`);
  }

  try {
    const { json } = await liRest('/rest/me', { token });
    const id = json?.id || json?.sub;
    if (id) return { id: `urn:li:person:${id}`, name: [json.localizedFirstName, json.localizedLastName].filter(Boolean).join(' ') || 'My LinkedIn', kind: 'PERSON', email: null, picture: null };
    attempts.push('/rest/me returned no id');
  } catch (e) { attempts.push(`/rest/me → ${e.status}`); }

  try {
    const { json: me } = await liFetch('/v2/me', { token });
    if (me?.id) return { id: `urn:li:person:${me.id}`, name: [me.localizedFirstName, me.localizedLastName].filter(Boolean).join(' ') || 'My LinkedIn', kind: 'PERSON', email: null, picture: null };
    attempts.push('/v2/me returned no id');
  } catch (e) { attempts.push(`/v2/me → ${e.status}`); }

  const err = new Error(
    'LinkedIn accepted the token but will not reveal which member it belongs to, '
    + 'so there is no author to publish as. Fix: open your app on linkedin.com/developers → '
    + 'Products → add "Sign In with LinkedIn using OpenID Connect" (self-serve, instant), then '
    + 'generate a NEW token with the openid, profile and w_member_social scopes ticked — '
    + 'existing tokens do not gain scopes retroactively. '
    + `(tried ${attempts.join(', ')})`,
  );
  err.status = 403;
  err.identityUnavailable = true;
  err.attempts = attempts;
  throw err;
}

// When app credentials are configured we can state the token's real scopes,
// which turns "something is missing" into "this exact scope is missing".
export function withScopeEvidence(err, meta) {
  if (!err?.identityUnavailable || !meta?.scopes) return err;
  const have = meta.scopes;
  const missing = ['openid', 'profile'].filter((s) => !have.includes(s));
  if (!missing.length) return err;
  err.message = `Your token only carries: ${have.join(', ')}. It is missing ${missing.join(' and ')}, `
    + `which is what identifies the member. ${err.message}`;
  err.scopes = have;
  err.missingScopes = missing;
  return err;
}

// Company Pages this member administers. Best-effort: needs rw_organization_admin.
export async function listOrganizations(token) {
  try {
    const { json } = await liFetch(
      '/v2/organizationAcls?q=roleAssignee&role=ADMINISTRATOR&state=APPROVED&projection=(elements*(organization~(id,localizedName)))',
      { token },
    );
    return (json.elements || []).map((el) => {
      const org = el['organization~'] || {};
      const urn = el.organization || (org.id ? `urn:li:organization:${org.id}` : null);
      return urn ? { id: urn, name: org.localizedName || urn, kind: 'ORGANIZATION' } : null;
    }).filter(Boolean);
  } catch {
    return [];   // no org scopes → member-only posting, which is fine
  }
}

// Token metadata (scopes + real expiry). Needs the app client id/secret.
export async function introspect(token) {
  const app = getLinkedInApp();
  if (!app.clientId || !app.clientSecret) return null;
  const { signal, done } = timeoutSignal(15000);
  try {
    const res = await fetch(`${OAUTH_BASE}/introspectToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, token }).toString(),
      signal,
    });
    if (!res.ok) return null;
    const j = await res.json().catch(() => null);
    if (!j) return null;
    return {
      active: j.active === true || j.status === 'active',
      scopes: String(j.scope || '').split(/[,\s]+/).filter(Boolean),
      expiresAt: j.expires_at ? new Date(j.expires_at * 1000).toISOString() : null,
      authType: j.auth_type || null,
    };
  } catch { return null; } finally { done(); }
}

// ── Token lifecycle ──────────────────────────────────────────────────────────
export async function exchangeAuthCode(code) {
  const app = getLinkedInApp();
  const { signal, done } = timeoutSignal(20000);
  try {
    const res = await fetch(`${OAUTH_BASE}/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'authorization_code', code, redirect_uri: redirectUri(),
        client_id: app.clientId, client_secret: app.clientSecret,
      }).toString(),
      signal,
    });
    const text = await res.text();
    if (!res.ok) throw liError(res.status, text, 'Token exchange failed');
    const j = JSON.parse(text);
    return normalizeTokenBundle(j);
  } finally { done(); }
}

function normalizeTokenBundle(j) {
  return {
    accessToken: j.access_token,
    refreshToken: j.refresh_token || null,
    expiresAt: j.expires_in ? new Date(Date.now() + j.expires_in * 1000).toISOString() : null,
    refreshTokenExpiresAt: j.refresh_token_expires_in ? new Date(Date.now() + j.refresh_token_expires_in * 1000).toISOString() : null,
    scopes: String(j.scope || '').split(/[,\s]+/).filter(Boolean),
  };
}

async function refreshAccessToken(refreshToken) {
  const app = getLinkedInApp();
  if (!app.clientId || !app.clientSecret) return null;
  const { signal, done } = timeoutSignal(20000);
  try {
    const res = await fetch(`${OAUTH_BASE}/accessToken`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'refresh_token', refresh_token: refreshToken,
        client_id: app.clientId, client_secret: app.clientSecret,
      }).toString(),
      signal,
    });
    if (!res.ok) return null;
    return normalizeTokenBundle(await res.json());
  } catch { return null; } finally { done(); }
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

// Refresh ~5 minutes before expiry, when the app supports it. Returns creds.
export async function ensureFreshToken(connection, creds) {
  if (!creds?.expiresAt || !creds.refreshToken) return creds;
  if (new Date(creds.expiresAt).getTime() - Date.now() > 5 * 60 * 1000) return creds;
  const bundle = await refreshAccessToken(creds.refreshToken);
  if (!bundle?.accessToken) return creds;
  const next = { ...creds, ...bundle, refreshToken: bundle.refreshToken || creds.refreshToken };
  saveCredentials(connection, next, { status: 'CONNECTED' });
  return next;
}

// ── Connect ──────────────────────────────────────────────────────────────────
function provision(conn) {
  if (store.findOne('platformSchedules', (s) => s.connectionId === conn.id)) return;
  const cad = DEFAULT_CADENCE.LINKEDIN || DEFAULT_CADENCE.CUSTOM_WEBHOOK;
  store.insert('platformSchedules', { connectionId: conn.id, isEnabled: false, timezone: 'Asia/Kolkata', slots: cad.slots, maxPerDay: 2, maxPerWeek: cad.perWeek + 4, minGapMinutes: 180, quietHours: { start: '22:00', end: '07:00' }, categoryRatio: { PRODUCT: 60, KNOWLEDGE: 40 }, autoApproveAbove: 75, leadTimeMinutes: 120 });
  store.insert('platformQuotas', { connectionId: conn.id, maxBytes: 5368709120, usedBytes: 0, retentionDays: 180, purgeStrategy: 'OLDEST_FIRST', keepMetadata: true, keepThumbnails: true, warnAtPercent: 80 });
}

// Validate a token bundle against the live API, then create/update the
// connection. Used by both the paste-token path and the OAuth callback.
export async function connectLinkedIn(tenant, bundle, { label, authorUrn, connectionId } = {}) {
  const token = String(bundle.accessToken || '').trim();
  if (!token) { const e = new Error('Access token is required'); e.status = 400; throw e; }

  // A token that can publish but not introspect its own owner is still usable —
  // provided the caller tells us the author URN. So only insist on discovery
  // when we have nothing else to go on. A 401 always aborts: the token is dead.
  const explicit = normalizeAuthorUrn(authorUrn);
  const tokenMeta = await introspect(token);   // early, so failures can cite real scopes
  let member = null;
  let identityNote = null;
  try {
    member = await resolveMember(token);
  } catch (e) {
    if (e.status === 401 || !explicit) throw withScopeEvidence(e, tokenMeta);
    identityNote = withScopeEvidence(e, tokenMeta).message;
  }

  const orgs = await listOrganizations(token);
  const targets = [member, ...orgs].filter(Boolean);
  const target = (explicit && targets.find((t) => t.id === explicit))
    || (explicit ? { id: explicit, name: member?.name || explicit, kind: explicit.includes(':organization:') ? 'ORGANIZATION' : 'PERSON' } : null)
    || member;
  if (!targets.some((t) => t.id === target.id)) targets.unshift(target);

  const meta = tokenMeta;
  const scopes = bundle.scopes?.length ? bundle.scopes : (meta?.scopes || []);
  const expiresAt = bundle.expiresAt || meta?.expiresAt || null;
  if (scopes.length && !scopes.includes('w_member_social') && target.kind === 'PERSON') {
    const e = new Error('This token is missing the w_member_social scope, so it cannot publish. Add the "Share on LinkedIn" product to your app and reconnect.');
    e.status = 400; throw e;
  }

  const creds = { ...bundle, accessToken: token, expiresAt, scopes, target, targets };

  let conn = connectionId ? store.get('connections', connectionId) : null;
  if (!conn) {
    conn = store.findOne('connections', (c) => c.tenantId === tenant.id && c.platform === 'LINKEDIN'
      && !c.archivedAt && c.externalAccountId === String(target.id));
  }
  if (conn) {
    saveCredentials(conn, creds, {
      label: label || conn.label, externalAccountId: String(target.id), externalAccountName: target.name,
      scopes, status: 'CONNECTED', isActive: true,
      config: { ...(conn.config || {}), sandbox: false, live: true, authorKind: target.kind },
      circuitOpenUntil: null, consecutiveFailures: 0, lastHealthCheckAt: new Date().toISOString(),
    });
  } else {
    conn = store.insert('connections', {
      tenantId: tenant.id, platform: 'LINKEDIN',
      label: label || `LinkedIn — ${target.name}`,
      externalAccountId: String(target.id), externalAccountName: target.name,
      credentialsEnc: encryptSecret(tenant, JSON.stringify(creds)),
      scopes, status: 'CONNECTED', mode: 'MANUAL', tokenExpiresAt: expiresAt, isActive: true,
      config: { sandbox: false, live: true, authorKind: target.kind },
      lastHealthCheckAt: new Date().toISOString(),
    });
  }
  provision(conn);
  return { connection: store.get('connections', conn.id), member, targets, scopes, expiresAt, identityNote };
}

// Accept a bare member id, a profile URL or a full URN and return a full URN.
export function normalizeAuthorUrn(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^urn:li:(person|organization):[\w-]+$/.test(s)) return s;
  const org = s.match(/linkedin\.com\/company\/(\d+)/i);
  if (org) return `urn:li:organization:${org[1]}`;
  if (/^\d+$/.test(s)) return `urn:li:organization:${s}`;           // numeric → company id
  if (/^[A-Za-z0-9_-]{5,}$/.test(s)) return `urn:li:person:${s}`;   // opaque id → member
  const e = new Error(`"${s}" is not a LinkedIn URN. Expected urn:li:person:… or urn:li:organization:…`);
  e.status = 400; throw e;
}

// ── Publishing ───────────────────────────────────────────────────────────────
// LinkedIn's `commentary` field is "Little Text": these characters are markup
// and MUST be backslash-escaped or the API answers 422. This is the single most
// common cause of silent LinkedIn publish failures.
const SENTINEL = String.fromCharCode(1);   // cannot occur in post text
const RESERVED = /[\\<>#~_|{}[\]()@*]/g;
export function escapeCommentary(text) {
  return String(text || '')
    // Keep real hashtags clickable: protect "#word" before escaping.
    .replace(/#(?=[A-Za-z0-9])/g, SENTINEL)
    .replace(RESERVED, (ch) => `\\${ch}`)
    .split(SENTINEL).join('#');
}

// Get raw bytes for a media asset, if we actually have them. Placeholder/AI
// assets have no bytes on disk — we publish text-only rather than fail.
async function mediaBytes(m) {
  // Manually uploaded files: read the bytes straight off disk. This is what
  // makes uploaded images actually reach LinkedIn (no public URL needed).
  const local = readAssetBytes(m);
  if (local) return { buf: local.buf, mime: local.mime || m.mimeType || 'image/jpeg' };

  const url = m?.publicUrl || m?.url || m?.remoteUrl;
  if (url && /^https?:\/\//.test(url) && !/\/api\/v1\/media\/file\//.test(url)) {
    const { signal, done } = timeoutSignal(20000);
    try {
      const res = await fetch(url, { signal });
      if (!res.ok) return null;
      return { buf: Buffer.from(await res.arrayBuffer()), mime: res.headers.get('content-type') || m.mimeType || 'image/jpeg' };
    } catch { return null; } finally { done(); }
  }
  if (m?.dataUrl && m.dataUrl.startsWith('data:')) {
    const [head, b64] = m.dataUrl.split(',');
    return { buf: Buffer.from(b64, 'base64'), mime: (head.match(/data:([^;]+)/) || [])[1] || 'image/jpeg' };
  }
  return null;
}

// Upload one image and return its urn:li:image:… id.
async function uploadImage(token, ownerUrn, asset) {
  const bytes = await mediaBytes(asset);
  if (!bytes) return null;
  const { json, version } = await liRest('/rest/images?action=initializeUpload', {
    token, method: 'POST', body: { initializeUploadRequest: { owner: ownerUrn } },
  });
  const uploadUrl = json?.value?.uploadUrl;
  const imageUrn = json?.value?.image;
  if (!uploadUrl || !imageUrn) throw new Error('LinkedIn did not return an image upload URL.');
  const { signal, done } = timeoutSignal(60000);
  try {
    const put = await fetch(uploadUrl, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': bytes.mime, 'LinkedIn-Version': version },
      body: bytes.buf,
      signal,
    });
    if (!put.ok) throw liError(put.status, await put.text().catch(() => ''), 'Image upload failed');
  } finally { done(); }
  return imageUrn;
}

// Publish a post for real. Returns { externalId, externalUrl, simulated:false }.
export async function publishLinkedIn(connection, post, media = []) {
  let creds = credentialsOf(connection);
  if (!creds.accessToken) { const e = new Error('This LinkedIn connection has no stored token — reconnect it.'); e.retryable = false; throw e; }
  creds = await ensureFreshToken(connection, creds);

  const author = creds.target?.id || connection.externalAccountId;
  if (!author || !/^urn:li:(person|organization):/.test(String(author))) {
    const e = new Error('This LinkedIn connection has no valid author URN — reconnect it.'); e.retryable = false; throw e;
  }

  const raw = [post.body, (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n').trim();
  const commentary = escapeCommentary(raw);

  // Images (best-effort — never block a text post on a missing asset).
  const notes = [];
  const imageUrns = [];
  for (const m of (media || []).filter((x) => x && x.kind === 'IMAGE' && !x.purgedAt).slice(0, 9)) {
    try {
      const urn = await uploadImage(creds.accessToken, author, m);
      if (urn) imageUrns.push({ id: urn, altText: (m.altText || '').slice(0, 300) || undefined });
      else notes.push(`Image ${m.id} has no retrievable bytes (no public URL) — published as text-only.`);
    } catch (e) { notes.push(`Image upload skipped: ${e.message}`); }
  }

  const body = {
    author,
    commentary,
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };
  if (imageUrns.length === 1) body.content = { media: imageUrns[0] };
  else if (imageUrns.length > 1) body.content = { multiImage: { images: imageUrns } };

  const { res } = await liRest('/rest/posts', { token: creds.accessToken, method: 'POST', body });
  const urn = res.headers.get('x-restli-id') || res.headers.get('x-linkedin-id');
  if (!urn) { const e = new Error('LinkedIn accepted the post but returned no post id.'); e.retryable = true; throw e; }
  return {
    externalId: urn,
    externalUrl: `https://www.linkedin.com/feed/update/${urn}/`,
    simulated: false,
    ...(notes.length ? { notes } : {}),
  };
}

// Read the post back to prove it is really live.
export async function verifyLinkedInPost(connection, externalId) {
  const creds = credentialsOf(connection);
  if (!creds.accessToken || !externalId) return { ok: false, reason: 'no token or post id' };
  try {
    const { json } = await liRest(`/rest/posts/${encodeURIComponent(externalId)}`, { token: creds.accessToken });
    return { ok: !!json?.id || !!json?.author, lifecycleState: json?.lifecycleState || null, externalUrl: `https://www.linkedin.com/feed/update/${externalId}/` };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
}

// A real health check: call the API with the stored token.
export async function healthCheckLinkedIn(connection) {
  const now = new Date().toISOString();
  if (connection.config?.sandbox) return { status: 'CONNECTED', at: now, sandbox: true, detail: 'Sandbox connection — publishing is simulated.' };
  let creds = credentialsOf(connection);
  if (!creds.accessToken) return { status: 'PENDING_AUTH', at: now, detail: 'No token stored — connect LinkedIn.' };
  try {
    creds = await ensureFreshToken(connection, creds);
    // A publish-only token (no OIDC product) cannot answer "who am I" — that is
    // not a broken connection, so don't fail the check when we already know the
    // author. Only a 401 proves the token is actually dead.
    let member = null;
    let identityNote = null;
    try {
      member = await resolveMember(creds.accessToken);
    } catch (e) {
      if (e.status === 401 || !creds.target?.id) throw e;
      identityNote = 'Identity lookup unavailable for this token (publish-only scopes).';
    }
    const meta = await introspect(creds.accessToken);
    const scopes = meta?.scopes || creds.scopes || [];
    const canPublish = !scopes.length || scopes.includes('w_member_social') || scopes.includes('w_organization_social');
    return {
      status: canPublish ? 'CONNECTED' : 'DEGRADED', at: now,
      detail: [canPublish ? `Live as ${creds.target?.name || member?.name}` : 'Token cannot publish — missing w_member_social.', identityNote].filter(Boolean).join(' '),
      author: creds.target?.id || member?.id,
      scopes,
      expiresAt: creds.expiresAt || meta?.expiresAt || null,
    };
  } catch (e) {
    return { status: e.status === 401 ? 'EXPIRED' : 'ERROR', at: now, detail: e.message };
  }
}
