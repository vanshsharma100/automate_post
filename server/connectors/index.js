// Platform connectors (doc 04). One contract per platform. Real network calls
// happen for the custom webhook (always) and Shopify (when a real Admin token is
// present). The social platforms require approved Meta/LinkedIn/Google apps that
// take weeks to obtain (doc 00.2, doc 04 §5), so without live credentials they
// run in an honest simulation: the post is marked published with a synthetic URL
// and clearly flagged as simulated in generationMeta.
import { store } from './../store.js';
import { decryptSecret } from '../crypto.js';
import { config } from '../config.js';
import { PLATFORM_CAPS, PLATFORM_META } from '../constants.js';
import { publishLinkedIn, healthCheckLinkedIn, verifyLinkedInPost } from '../linkedin-client.js';
import { publishGoogleBusiness, healthCheckGoogleBusiness, verifyGoogleBusinessPost } from '../google-business-client.js';
import { publishMeta, healthCheckMeta, verifyMetaPost } from '../meta-client.js';

function tenantOf(id) { return store.get('tenants', id); }

export function capabilitiesFor(platform) {
  return PLATFORM_CAPS[platform] || PLATFORM_CAPS.CUSTOM_WEBHOOK;
}

// Pre-flight validation used by the composer and before publish (doc 04 §1).
export function validatePost(platform, post, media = []) {
  const cap = capabilitiesFor(platform);
  const errors = [];
  const warnings = [];
  const text = `${post.title || ''}\n${post.body || ''}`;
  const bodyLen = (post.body || '').length;
  if (bodyLen > cap.text.maxChars) errors.push(`Body is ${bodyLen} chars; ${PLATFORM_META[platform].label} allows ${cap.text.maxChars}.`);
  const hashCount = (post.hashtags || []).length;
  if (cap.hashtags.supported && hashCount > cap.hashtags.max) errors.push(`${hashCount} hashtags; max is ${cap.hashtags.max}.`);
  if (cap.hashtags.supported && hashCount > cap.hashtags.recommended) warnings.push(`${hashCount} hashtags; ${cap.hashtags.recommended} recommended.`);
  if (cap.requiresMedia && media.length === 0) errors.push(`${PLATFORM_META[platform].label} requires at least one image.`);
  if (cap.text.links === 'none' && /https?:\/\//.test(post.body || '')) warnings.push('Links are not clickable here — the CTA will read "link in bio".');
  return { ok: errors.length === 0, errors, warnings };
}

// Publish. Returns { externalId, externalUrl, simulated }.
export async function publish(connection, post, media = []) {
  const platform = connection.platform;
  const cap = capabilitiesFor(platform);
  const pre = validatePost(platform, post, media);
  if (!pre.ok) {
    const err = new Error(pre.errors[0]);
    err.retryable = false;
    err.validation = pre.errors;
    throw err;
  }

  if (platform === 'CUSTOM_WEBHOOK') return publishWebhook(connection, post, media);
  if (platform === 'SHOPIFY_BLOG') return publishShopify(connection, post, media);
  // Real OAuth social publish when connected with live tokens; sandbox → simulate.
  if (connection.credentialsEnc && !connection.config?.sandbox) return publishSocial(connection, post, media);
  return simulatePublish(connection, post);
}

function credsOf(connection) {
  const tenant = tenantOf(connection.tenantId);
  try { return JSON.parse(decryptSecret(tenant, connection.credentialsEnc) || '{}'); } catch { return {}; }
}

// Real publish per platform (doc 04 §5). Each social platform owns its own
// client — token lifecycle, endpoints and error decoding all live there.
async function publishSocial(connection, post, media) {
  // LinkedIn: version negotiation, commentary escaping, image upload, refresh.
  if (connection.platform === 'LINKEDIN') return publishLinkedIn(connection, post, media);
  // Google Business: token refresh, account-scoped location names, 403 decoding.
  if (connection.platform === 'GOOGLE_BUSINESS') return publishGoogleBusiness(connection, post, media);
  // Facebook + Instagram: page-token derivation, long-lived tokens, photo vs
  // feed endpoints, the IG two-step publish, Meta error-code decoding.
  if (connection.platform === 'FACEBOOK' || connection.platform === 'INSTAGRAM') return publishMeta(connection, post, media);
  return simulatePublish(connection, post);
}

async function publishWebhook(connection, post, media) {
  const cfg = connection.config || {};
  const url = cfg.url;
  if (!url) { const e = new Error('Webhook URL not configured'); e.retryable = false; throw e; }
  const tenant = tenantOf(connection.tenantId);
  let authHeader = {};
  if (connection.credentialsEnc) {
    try {
      const creds = JSON.parse(decryptSecret(tenant, connection.credentialsEnc) || '{}');
      if (creds.authHeaderName && creds.authHeaderValue) authHeader[creds.authHeaderName] = creds.authHeaderValue;
    } catch { /* ignore */ }
  }
  const payload = renderTemplate(cfg.template, post, media);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: cfg.method || 'POST',
      headers: { 'content-type': 'application/json', ...authHeader },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    if (!res.ok) { const e = new Error(`Webhook responded ${res.status}`); e.retryable = res.status >= 500; e.httpStatus = res.status; throw e; }
    return { externalId: `wh_${post.id}`, externalUrl: url, simulated: false };
  } finally {
    clearTimeout(t);
  }
}

async function publishShopify(connection, post, media) {
  const st = store.findOne('shopifyStores', (s) => s.connectionId === connection.id);
  const tenant = tenantOf(connection.tenantId);
  let token = null;
  try { token = st?.accessTokenEnc ? decryptSecret(tenant, st.accessTokenEnc) : null; } catch { /* ignore */ }
  // Real publish only when a validated token is present; otherwise simulate.
  if (!st || !token || !st.shopDomain) {
    return simulatePublish(connection, post);
  }
  // Publish via the REST Admin API — available on every version and gives clear
  // HTTP errors (403 = missing write_content scope, the #1 cause of failures).
  const blog = store.findOne('shopifyBlogs', (b) => b.storeId === st.id && b.isDefaultTarget) || store.findOne('shopifyBlogs', (b) => b.storeId === st.id);
  if (!blog) { const e = new Error('No blog found on this store — sync the store first (Shopify → Sync now).'); e.retryable = false; throw e; }
  const blogId = (String(blog.shopifyGid).match(/(\d+)\s*$/) || [])[1];
  const article = {
    title: post.title || post.seoTitle || 'Untitled',
    author: post.author || st.author || 'Editorial',
    body_html: htmlFromMarkdown(post.body || ''),
    summary_html: post.excerpt || post.seoDescription || undefined,
    handle: post.slug || undefined,
    tags: (post.keywords || []).join(', ') || undefined,
    published: true,
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`https://${st.shopDomain}/admin/api/${st.apiVersion}/blogs/${blogId}/articles.json`, {
      method: 'POST',
      headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ article }),
      signal: ctrl.signal,
    });
    const raw = await res.text();
    let json; try { json = raw ? JSON.parse(raw) : {}; } catch { json = null; }
    if (!res.ok || !json?.article) {
      const detail = json?.errors ? (typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors)) : (raw || '').slice(0, 200);
      const hint = res.status === 401 || res.status === 403
        ? ' → Your Admin API token is missing the write_content scope. In Shopify admin: Settings → Apps and sales channels → Develop apps → your app → Configuration → Admin API access scopes → enable write_content → Save → API credentials → (re)install → copy the new token and reconnect on the Shopify screen.'
        : res.status === 404 ? ` → Blog not found or API version "${st.apiVersion}" is invalid for your store. Reconnect with a supported version like 2025-01.` : '';
      const e = new Error(`Shopify ${res.status}: ${detail}${hint}`);
      e.retryable = res.status >= 500; e.httpStatus = res.status;
      throw e;
    }
    const created = json.article;
    return { externalId: `gid://shopify/Article/${created.id}`, externalUrl: `https://${st.shopDomain}/blogs/${blog.handle}/${created.handle}`, simulated: false };
  } finally {
    clearTimeout(t);
  }
}

function simulatePublish(connection, post) {
  const platform = connection.platform;
  const slug = (post.slug || post.id).replace(/[^a-z0-9-]/gi, '');
  const host = {
    LINKEDIN: 'https://www.linkedin.com/feed/update/urn:li:share:',
    INSTAGRAM: 'https://www.instagram.com/p/',
    FACEBOOK: 'https://www.facebook.com/',
    GOOGLE_BUSINESS: 'https://business.google.com/posts/',
    SHOPIFY_BLOG: 'https://demo-store.myshopify.com/blogs/news/',
  }[platform] || 'https://example.com/posts/';
  const externalId = `${platform.toLowerCase()}_${Math.random().toString(36).slice(2, 11)}`;
  return { externalId, externalUrl: `${host}${platform === 'LINKEDIN' ? Date.now() : slug}`, simulated: true };
}

// Read the post back to confirm it's actually live (doc 04 §7 step 7).
export async function verify(connection, externalId, externalUrl) {
  // LinkedIn really re-reads the post; other connectors return the canonical URL.
  if (connection.platform === 'LINKEDIN' && !connection.config?.sandbox && externalId) {
    const r = await verifyLinkedInPost(connection, externalId);
    return { ok: r.ok, externalUrl: r.externalUrl || externalUrl, detail: r.reason || r.lifecycleState || null };
  }
  if (connection.platform === 'GOOGLE_BUSINESS' && !connection.config?.sandbox && externalId) {
    const r = await verifyGoogleBusinessPost(connection, externalId);
    return { ok: r.ok, externalUrl: r.externalUrl || externalUrl, detail: r.reason || r.state || null };
  }
  if ((connection.platform === 'FACEBOOK' || connection.platform === 'INSTAGRAM') && !connection.config?.sandbox && externalId) {
    const r = await verifyMetaPost(connection, externalId);
    return { ok: r.ok, externalUrl: r.externalUrl || externalUrl, detail: r.reason || null };
  }
  return { ok: true, externalUrl };
}

export async function healthCheck(connection) {
  // A cheap read call in production. Here: derive from stored credential state.
  const now = new Date().toISOString();
  if (connection.platform === 'LINKEDIN') return healthCheckLinkedIn(connection);
  if (connection.platform === 'GOOGLE_BUSINESS') return healthCheckGoogleBusiness(connection);
  if (connection.platform === 'FACEBOOK' || connection.platform === 'INSTAGRAM') return healthCheckMeta(connection);
  if (connection.platform === 'CUSTOM_WEBHOOK') {
    return { status: connection.config?.url ? 'CONNECTED' : 'PENDING_AUTH', at: now };
  }
  if (connection.tokenExpiresAt && new Date(connection.tokenExpiresAt) < new Date()) {
    return { status: 'EXPIRED', at: now };
  }
  if (connection.status === 'PENDING_AUTH' || connection.status === 'DISCONNECTED') {
    return { status: connection.status, at: now };
  }
  return { status: 'CONNECTED', at: now };
}

// ── helpers ──────────────────────────────────────────────────────────────────
function renderTemplate(template, post, media) {
  const data = {
    title: post.title || '', body: post.body || '', excerpt: post.excerpt || '',
    imageUrl: media[0]?.publicUrl || '', link: post.linkUrl || '',
    hashtags: (post.hashtags || []).join(' '), platform: post.platform || '',
  };
  if (!template) return data;
  const rendered = String(template).replace(/\{\{(\w+)\}\}/g, (_, k) => data[k] ?? '');
  try { return JSON.parse(rendered); } catch { return { content: rendered, ...data }; }
}

function htmlFromMarkdown(md = '') {
  return String(md)
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .split(/\n{2,}/).map((p) => (p.startsWith('<h') ? p : `<p>${p.replace(/\n/g, '<br>')}</p>`)).join('\n');
}
