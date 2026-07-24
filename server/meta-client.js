// Real Meta (Facebook Pages + Instagram) client — the Meta twin of
// linkedin-client.js / google-business-client.js. Facebook and Instagram share
// one Meta app and one auth flow, so they live together here.
//
// How Meta auth actually works (the part that trips everyone up):
//   • You authorise once and get a SHORT-lived user token (~1 hour).
//   • You exchange that for a LONG-lived user token (~60 days).
//   • From the long-lived user token you read PAGE tokens. A page token derived
//     from a long-lived user token effectively does not expire.
//   • Facebook publishes with the PAGE token. Instagram publishes with the same
//     page token against the IG Business account linked to that page.
//
// Three ways to connect, all producing a real live connection:
//   1. OAuth redirect          — needs the app id/secret (UI-settable).
//   2. Paste a user token       — from Graph API Explorer. We long-live it.
//   3. Paste a page token       — advanced; used directly.
//
// REALITY CHECK, like GBP: publishing to a Page or IG needs the
// pages_manage_posts / instagram_content_publish permissions APPROVED via Meta
// App Review before they work for anyone but the app's own admins/testers. For
// your own pages while the app is in Development mode, they work immediately.
import { store } from './store.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { config } from './config.js';
import { DEFAULT_CADENCE } from './constants.js';
import { getPlatformApp, setPlatformApp, clearPlatformApp } from './platform-apps.js';
import { readAssetBytes } from './media-store.js';

const V = process.env.META_API_VERSION || 'v21.0';
const GRAPH = `https://graph.facebook.com/${V}`;

export const FACEBOOK_SCOPES = ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management', 'public_profile'];
export const INSTAGRAM_SCOPES = ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'];

export function scopesFor(platform) {
  return platform === 'INSTAGRAM' ? INSTAGRAM_SCOPES : FACEBOOK_SCOPES;
}

// Facebook and Instagram share ONE Meta app, so both map to the same creds row.
export const getMetaApp = () => getPlatformApp('FACEBOOK');
export const setMetaApp = (tenant, creds) => setPlatformApp(tenant, 'FACEBOOK', creds);
export const clearMetaApp = () => clearPlatformApp('FACEBOOK');
export const isMetaConfigured = () => { const a = getMetaApp(); return !!(a.clientId && a.clientSecret); };

export function redirectUri(platform) {
  return `${config.webUrl.replace(/\/$/, '')}/api/v1/connections/oauth/${platform}/callback`;
}

export function buildAuthUrl(platform, state) {
  const app = getMetaApp();
  const params = new URLSearchParams({
    client_id: app.clientId, redirect_uri: redirectUri(platform),
    scope: scopesFor(platform).join(','), response_type: 'code', state,
  });
  return `https://www.facebook.com/${V}/dialog/oauth?${params.toString()}`;
}

// ── HTTP plumbing ────────────────────────────────────────────────────────────
function timeoutSignal(ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, done: () => clearTimeout(t) };
}

// Meta wraps errors in {error:{message,code,error_subcode,type}}. The subcode is
// what distinguishes "token expired" from "permission missing" from "app not
// approved" — flattening it to just message loses the actionable part.
function metaError(status, body, fallback) {
  let e = {};
  try { e = (typeof body === 'string' ? JSON.parse(body) : body)?.error || {}; } catch { /* keep {} */ }
  const msg = e.message || fallback || `HTTP ${status}`;
  const code = e.code;
  const sub = e.error_subcode;

  const hint =
    code === 190 ? ' → The access token is invalid or expired. Reconnect this account.'
    : (code === 200 || code === 10 || code === 3) ? ' → Your Meta app is missing a required permission for this action (pages_manage_posts for Facebook, instagram_content_publish for Instagram), OR those permissions have not passed App Review yet. In Development mode they work only for the app\'s own admins, developers and testers.'
    : code === 100 ? ' → Bad request to the Graph API — often a missing image URL for Instagram, or an unreachable image.'
    : (code === 4 || code === 17 || code === 32 || code === 613) ? ' → Meta rate limit hit. It will be retried automatically.'
    : code === 368 ? ' → Temporarily blocked for a policy reason on this account.'
    : '';

  const err = new Error(`Meta ${status} (code ${code ?? '?'}${sub ? `/${sub}` : ''}): ${msg}${hint}`);
  err.status = err.httpStatus = status;
  err.metaCode = code;
  err.permissionProblem = code === 200 || code === 10 || code === 3;
  err.retryable = code === 4 || code === 17 || code === 32 || code === 613 || (status >= 500 && status < 600);
  return err;
}

async function graph(path, { token, method = 'GET', params = {}, timeout = 25000 } = {}) {
  const { signal, done } = timeoutSignal(timeout);
  try {
    const url = new URL(`${GRAPH}${path.startsWith('/') ? path : `/${path}`}`);
    const opts = { method, signal, headers: {} };
    if (method === 'GET') {
      for (const [k, v] of Object.entries({ ...params, access_token: token })) if (v != null) url.searchParams.set(k, v);
    } else {
      const form = new URLSearchParams();
      for (const [k, v] of Object.entries({ ...params, access_token: token })) if (v != null) form.set(k, typeof v === 'object' ? JSON.stringify(v) : v);
      opts.body = form; opts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }
    const res = await fetch(url, opts);
    const text = await res.text();
    if (!res.ok) throw metaError(res.status, text, `HTTP ${res.status}`);
    let json = null; try { json = text ? JSON.parse(text) : {}; } catch { json = {}; }
    return json;
  } finally { done(); }
}

// ── Token lifecycle ──────────────────────────────────────────────────────────
export async function exchangeAuthCode(platform, code) {
  const app = getMetaApp();
  const json = await graph('/oauth/access_token', {
    token: undefined,
    params: { client_id: app.clientId, client_secret: app.clientSecret, redirect_uri: redirectUri(platform), code },
  });
  return longLiveUserToken(json.access_token);
}

// Turn a short-lived user token into a ~60-day one. Idempotent: passing an
// already-long token just returns another long one.
export async function longLiveUserToken(shortToken) {
  const app = getMetaApp();
  if (!app.clientId || !app.clientSecret) {
    // No app creds → can't extend. Use as-is; expiry unknown.
    return { accessToken: shortToken, expiresAt: null, longLived: false };
  }
  try {
    const json = await graph('/oauth/access_token', {
      token: undefined,
      params: { grant_type: 'fb_exchange_token', client_id: app.clientId, client_secret: app.clientSecret, fb_exchange_token: shortToken },
    });
    return {
      accessToken: json.access_token || shortToken,
      expiresAt: json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null,
      longLived: true,
    };
  } catch {
    return { accessToken: shortToken, expiresAt: null, longLived: false };
  }
}

// Token metadata via debug_token — real scopes, real expiry, validity.
export async function debugToken(token) {
  const app = getMetaApp();
  if (!app.clientId || !app.clientSecret) return null;
  try {
    const appToken = `${app.clientId}|${app.clientSecret}`;   // app access token form
    const json = await graph('/debug_token', { token: appToken, params: { input_token: token } });
    const d = json.data || {};
    return {
      valid: d.is_valid === true,
      scopes: d.scopes || [],
      expiresAt: d.expires_at ? new Date(d.expires_at * 1000).toISOString() : null,
      dataAccessExpiresAt: d.data_access_expires_at ? new Date(d.data_access_expires_at * 1000).toISOString() : null,
      type: d.type || null,
      userId: d.user_id || null,
    };
  } catch { return null; }
}

// ── Discovery ────────────────────────────────────────────────────────────────
// Pages the user manages, each carrying its page token and (if present) the
// linked Instagram Business account. This is the single source of publish
// targets for both platforms.
export async function listPages(userToken) {
  const out = [];
  let path = '/me/accounts';
  let params = { fields: 'id,name,access_token,instagram_business_account{id,username,name}', limit: 100 };
  for (let page = 0; page < 5 && path; page++) {
    const json = await graph(path, { token: userToken, params });
    out.push(...(json.data || []));
    const next = json.paging?.next;
    if (next) { path = next.replace(GRAPH, ''); params = {}; } else path = null;
  }
  return out;
}

// Targets for a given platform. FACEBOOK → every page. INSTAGRAM → only pages
// that actually have a linked IG Business account.
export async function listTargets(platform, userToken) {
  const pages = await listPages(userToken);
  if (platform === 'INSTAGRAM') {
    return pages.filter((p) => p.instagram_business_account?.id).map((p) => ({
      id: p.instagram_business_account.id,
      name: p.instagram_business_account.username ? `@${p.instagram_business_account.username}` : (p.instagram_business_account.name || p.name),
      kind: 'INSTAGRAM', pageId: p.id, pageName: p.name, pageToken: p.access_token,
    }));
  }
  return pages.map((p) => ({
    id: p.id, name: p.name, kind: 'PAGE', pageId: p.id, pageToken: p.access_token,
    hasInstagram: !!p.instagram_business_account?.id,
  }));
}

// ── Credentials on the connection ────────────────────────────────────────────
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

// ── Connect ──────────────────────────────────────────────────────────────────
function provision(conn) {
  if (store.findOne('platformSchedules', (s) => s.connectionId === conn.id)) return;
  const cad = DEFAULT_CADENCE[conn.platform] || DEFAULT_CADENCE.CUSTOM_WEBHOOK;
  store.insert('platformSchedules', { connectionId: conn.id, isEnabled: false, timezone: 'Asia/Kolkata', slots: cad.slots, maxPerDay: 2, maxPerWeek: cad.perWeek + 4, minGapMinutes: 180, quietHours: { start: '22:00', end: '07:00' }, categoryRatio: { PRODUCT: 60, KNOWLEDGE: 40 }, autoApproveAbove: 75, leadTimeMinutes: 120 });
  store.insert('platformQuotas', { connectionId: conn.id, maxBytes: 5368709120, usedBytes: 0, retentionDays: 180, purgeStrategy: 'OLDEST_FIRST', keepMetadata: true, keepThumbnails: true, warnAtPercent: 80 });
}

// Validate a token against the live Graph API, then create/update the
// connection. `bundle.accessToken` is a user token (preferred — we long-live it
// and derive page tokens) or a page token (used directly).
export async function connectMeta(tenant, platform, bundle, { label, targetId, connectionId } = {}) {
  let userToken = String(bundle.accessToken || '').trim();
  if (!userToken) { const e = new Error('An access token is required.'); e.status = 400; throw e; }

  // Long-live it if it's a user token and we have app creds. Harmless otherwise.
  let expiresAt = bundle.expiresAt || null;
  if (!bundle.isPageToken) {
    const ll = await longLiveUserToken(userToken);
    userToken = ll.accessToken;
    expiresAt = ll.expiresAt || expiresAt;
  }

  const targets = await listTargets(platform, userToken);   // 190 = bad token, aborts pre-save
  if (!targets.length) {
    const e = new Error(platform === 'INSTAGRAM'
      ? 'No Instagram Business account was found. Connect your Instagram account to a Facebook Page and convert it to a Business/Creator account, then reconnect.'
      : 'This account manages no Facebook Pages. Create or get admin access to a Page, then reconnect.');
    e.status = 400; throw e;
  }
  const target = targets.find((t) => t.id === String(targetId)) || targets[0];

  const meta = await debugToken(userToken);
  const scopes = meta?.scopes || scopesFor(platform);
  expiresAt = expiresAt || meta?.expiresAt || null;

  // Store the page token alongside — it's what actually publishes, and it
  // outlives the user token when the user token is long-lived.
  const creds = { accessToken: userToken, pageToken: target.pageToken, expiresAt, scopes, target, targets };

  let conn = connectionId ? store.get('connections', connectionId) : null;
  if (!conn) {
    conn = store.findOne('connections', (c) => c.tenantId === tenant.id && c.platform === platform
      && !c.archivedAt && c.externalAccountId === String(target.id));
  }
  const shared = {
    externalAccountId: String(target.id), externalAccountName: target.name,
    scopes, status: 'CONNECTED', isActive: true,
    config: { sandbox: false, live: true, pageId: target.pageId, pageName: target.pageName || target.name },
    lastHealthCheckAt: new Date().toISOString(),
  };
  if (conn) {
    saveCredentials(conn, creds, { ...shared, label: label || conn.label, circuitOpenUntil: null, consecutiveFailures: 0 });
  } else {
    conn = store.insert('connections', {
      tenantId: tenant.id, platform, mode: 'MANUAL',
      label: label || `${platform === 'INSTAGRAM' ? 'Instagram' : 'Facebook'} — ${target.name}`,
      credentialsEnc: encryptSecret(tenant, JSON.stringify(creds)),
      tokenExpiresAt: expiresAt, ...shared,
    });
  }
  provision(conn);
  return { connection: store.get('connections', conn.id), targets, target, scopes, expiresAt };
}

// ── Media helpers ────────────────────────────────────────────────────────────
// A URL Meta's servers can actually fetch — i.e. not localhost/private. Uploaded
// files served from a localhost WEB_URL are reachable by LinkedIn/Facebook (we
// send bytes) but NOT by Instagram/GBP (they fetch the URL themselves).
function isPubliclyFetchable(url) {
  try {
    const h = new URL(url).hostname;
    return !/^(localhost|127\.|0\.0\.0\.0|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1)/.test(h);
  } catch { return false; }
}

function firstImage(media) {
  const imgs = (media || []).filter((m) => m && m.kind === 'IMAGE' && !m.purgedAt);
  // Prefer an image we can actually publish (uploaded bytes, or a public URL)
  // over a byte-less AI placeholder that would otherwise be picked first.
  return imgs.find((m) => m.source === 'UPLOAD' || readAssetBytes(m) || isPubliclyFetchable(m.publicUrl || '')) || imgs[0];
}

// ── Publishing ───────────────────────────────────────────────────────────────
export async function publishMeta(connection, post, media = []) {
  return connection.platform === 'INSTAGRAM'
    ? publishInstagram(connection, post, media)
    : publishFacebook(connection, post, media);
}

async function publishFacebook(connection, post, media) {
  const creds = credentialsOf(connection);
  const pageId = creds.target?.pageId || connection.config?.pageId || creds.target?.id;
  const pageToken = creds.pageToken || creds.accessToken;
  if (!pageId || !pageToken) { const e = new Error('This Facebook connection is missing its Page token — reconnect it.'); e.retryable = false; throw e; }

  const message = [post.body, (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n').trim();
  const link = post.linkUrl || post.ctaUrl || null;
  const image = firstImage(media);
  const notes = [];

  // A photo post and a plain/link post are different endpoints on Facebook.
  if (image) {
    // Prefer raw bytes (uploaded files) via multipart `source` — no public URL
    // needed. Fall back to a publicly-fetchable URL if that's all we have.
    const local = readAssetBytes(image);
    if (local) {
      const fd = new FormData();
      fd.set('source', new Blob([local.buf], { type: local.mime || 'image/jpeg' }), 'image');
      fd.set('caption', message);
      fd.set('access_token', pageToken);
      const { signal, done } = timeoutSignal(60000);
      try {
        const res = await fetch(`${GRAPH}/${pageId}/photos`, { method: 'POST', body: fd, signal });
        const text = await res.text();
        if (!res.ok) throw metaError(res.status, text, 'Facebook photo upload failed');
        const json = JSON.parse(text);
        const id = json.post_id || json.id;
        return { externalId: id, externalUrl: `https://www.facebook.com/${id}`, simulated: false };
      } finally { done(); }
    }
    if (isPubliclyFetchable(image.publicUrl || '')) {
      const json = await graph(`/${pageId}/photos`, { token: pageToken, method: 'POST', params: { url: image.publicUrl, caption: message } });
      const id = json.post_id || json.id;
      return { externalId: id, externalUrl: `https://www.facebook.com/${id}`, simulated: false };
    }
    notes.push('Image skipped — it has no retrievable bytes and no public URL. Posted as text.');
  }

  const json = await graph(`/${pageId}/feed`, { token: pageToken, method: 'POST', params: { message, ...(link ? { link } : {}) } });
  if (!json.id) { const e = new Error('Facebook accepted the post but returned no id.'); e.retryable = true; throw e; }
  return { externalId: json.id, externalUrl: `https://www.facebook.com/${json.id}`, simulated: false, ...(notes.length ? { notes } : {}) };
}

async function publishInstagram(connection, post, media) {
  const creds = credentialsOf(connection);
  const igId = creds.target?.id || connection.externalAccountId;
  const pageToken = creds.pageToken || creds.accessToken;
  if (!igId || !pageToken) { const e = new Error('This Instagram connection is missing its token — reconnect it.'); e.retryable = false; throw e; }

  // Instagram MUST have a publicly reachable image — there is no text-only IG
  // post, and Meta fetches the image itself (no byte upload). This is a hard stop.
  const image = firstImage(media);
  const photo = image && isPubliclyFetchable(image.publicUrl || '') ? image : null;
  if (!photo) {
    const hasLocal = image && (image.publicUrl || readAssetBytes(image));
    const e = new Error(hasLocal
      ? 'Instagram cannot fetch this image because it is served from a private/localhost address. Instagram\'s servers must reach the URL directly. Set WEB_URL to a public origin (a tunnel like ngrok, or a deployed host) and reconnect — then this same upload works. (Facebook and LinkedIn already work with it.)'
      : 'Instagram requires a publicly reachable image, and this post has none. Attach an image (Instagram cannot post text alone).');
    e.retryable = false; throw e;
  }
  const caption = [post.body, (post.hashtags || []).join(' ')].filter(Boolean).join('\n\n').trim();

  // Two-step: create a media container, then publish it.
  const container = await graph(`/${igId}/media`, { token: pageToken, method: 'POST', params: { image_url: photo.publicUrl, caption } });
  if (!container.id) { const e = new Error('Instagram did not return a media container id.'); e.retryable = true; throw e; }
  const pub = await graph(`/${igId}/media_publish`, { token: pageToken, method: 'POST', params: { creation_id: container.id } });
  if (!pub.id) { const e = new Error('Instagram accepted the container but did not publish it.'); e.retryable = true; throw e; }

  // Best-effort permalink lookup.
  let url = `https://www.instagram.com/`;
  try { const info = await graph(`/${pub.id}`, { token: pageToken, params: { fields: 'permalink' } }); if (info.permalink) url = info.permalink; } catch { /* ignore */ }
  return { externalId: pub.id, externalUrl: url, simulated: false };
}

// ── Verify / health ──────────────────────────────────────────────────────────
export async function verifyMetaPost(connection, externalId) {
  if (!externalId) return { ok: false, reason: 'no post id' };
  const creds = credentialsOf(connection);
  const token = creds.pageToken || creds.accessToken;
  try {
    const fields = connection.platform === 'INSTAGRAM' ? 'permalink' : 'id,created_time';
    const json = await graph(`/${externalId}`, { token, params: { fields } });
    return { ok: !!json.id || !!json.permalink, externalUrl: json.permalink || (json.id ? `https://www.facebook.com/${json.id}` : null) };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export async function healthCheckMeta(connection) {
  const now = new Date().toISOString();
  if (connection.config?.sandbox) return { status: 'CONNECTED', at: now, sandbox: true, detail: 'Sandbox connection — publishing is simulated.' };
  const creds = credentialsOf(connection);
  const token = creds.pageToken || creds.accessToken;
  if (!token) return { status: 'PENDING_AUTH', at: now, detail: 'No token stored — connect this account.' };
  try {
    const targets = await listTargets(connection.platform, creds.accessToken || token);
    const current = creds.target?.id;
    const stillThere = !current || targets.some((t) => t.id === String(current));
    const needed = connection.platform === 'INSTAGRAM' ? 'instagram_content_publish' : 'pages_manage_posts';
    // Re-read scopes live — a token can lose a permission after connect, and the
    // stored scope list would then lie. debug_token is the source of truth.
    const meta = await debugToken(creds.accessToken || token);
    const scopes = meta?.scopes?.length ? meta.scopes : (creds.scopes || []);
    const canPublish = !scopes.length || scopes.includes(needed);
    return {
      status: !stillThere ? 'DEGRADED' : canPublish ? 'CONNECTED' : 'DEGRADED', at: now,
      detail: !stillThere ? 'The selected page/account is no longer managed by this login.'
        : canPublish ? `Live as ${creds.target?.name} · ${targets.length} target(s) available`
        : `Token cannot publish — missing ${needed}. Add it in App Review.`,
      target: current, targetCount: targets.length, expiresAt: creds.expiresAt || null,
    };
  } catch (e) {
    return { status: e.metaCode === 190 ? 'EXPIRED' : 'ERROR', at: now, detail: e.message, permissionProblem: !!e.permissionProblem };
  }
}
