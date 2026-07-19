'use strict';

/**
 * REAL publishing to the social platforms.
 *
 * One entry point — `publishPost(post, account)` — dispatches to the right
 * platform and actually sends the post. Used by BOTH:
 *   - the scheduler (Autopilot: publishes automatically on schedule), and
 *   - the "Publish now" button (Manual mode).
 *
 * DESIGN RULES
 *  - Never throw at the caller. Always resolve to {ok, permalink?, error?} so a
 *    failed publish leaves the post safely as a draft with a readable reason.
 *  - Never log or return tokens. Errors carry the platform's message only.
 *  - Prefer uploading local media as binary (works without a public URL).
 *    Instagram and Google Business are the exceptions — their APIs can only
 *    fetch a PUBLIC image URL, so those need settings.publicUrl to be set.
 *
 * API versions verified against the official docs (July 2026):
 *   Meta Graph v25.0 · LinkedIn /rest/posts (LinkedIn-Version 202606)
 *   Google Business Profile v4 localPosts · Shopify Admin 2024-10
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const config = require('./config');
const { decrypt } = require('./crypto');

const GRAPH = 'https://graph.facebook.com/v25.0';
const LINKEDIN_VERSION = '202606';
const SHOPIFY_API_VERSION = '2024-10';

const UPLOADS_DIR = path.join(config.dataDir, 'uploads');
const GENERATED_DIR = path.join(config.dataDir, 'generated');

/* ----------------------------- media helpers ------------------------------ */

// Signature that makes a media file publicly fetchable by Instagram/Google
// WITHOUT exposing the whole folder: an unguessable, per-file capability URL.
function mediaSignature(kind, name) {
  return crypto
    .createHmac('sha256', config.masterKey)
    .update(kind + '/' + name)
    .digest('hex')
    .slice(0, 32);
}

function verifyMediaSignature(kind, name, sig) {
  const expected = mediaSignature(kind, name);
  const a = Buffer.from(expected);
  const b = Buffer.from(String(sig || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Split an app media path like "/media/uploads/up-123.png" into its parts.
function parseMediaPath(url) {
  const m = String(url || '').match(/^\/media\/(uploads|generated)\/(.+)$/);
  if (!m) return null;
  return { kind: m[1], name: path.basename(m[2]) };
}

function localFileFor(url) {
  const p = parseMediaPath(url);
  if (!p) return null;
  const dir = p.kind === 'uploads' ? UPLOADS_DIR : GENERATED_DIR;
  const file = path.join(dir, p.name);
  return fs.existsSync(file) ? file : null;
}

/**
 * A publicly reachable URL for a media item, or null when we can't build one.
 * External URLs (e.g. a Shopify CDN product photo) are already public.
 */
function publicUrlFor(url) {
  const s = String(url || '');
  if (/^https?:\/\//i.test(s)) return s;
  const p = parseMediaPath(s);
  if (!p) return null;
  const base = (store.get().settings.publicUrl || '').trim().replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/p/${p.kind}/${mediaSignature(p.kind, p.name)}/${p.name}`;
}

// Reads media into a Buffer — from disk for local files, or by downloading it.
async function mediaBuffer(url) {
  const file = localFileFor(url);
  if (file) return fs.readFileSync(file);
  if (/^https?:\/\//i.test(url || '')) {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('could not download image');
    return Buffer.from(await resp.arrayBuffer());
  }
  return null;
}

function guessMime(url) {
  const ext = path.extname(String(url || '')).toLowerCase();
  if (ext === '.png') return 'image/png';
  if (ext === '.mp4') return 'video/mp4';
  if (ext === '.mov') return 'video/quicktime';
  return 'image/jpeg';
}

// Pull a readable message out of a platform's error response, never the token.
async function errorText(resp) {
  try {
    const body = await resp.json();
    const msg =
      (body.error && (body.error.message || body.error.error_user_msg)) ||
      body.message ||
      (body.errors && JSON.stringify(body.errors)) ||
      '';
    return `${resp.status}${msg ? ' — ' + String(msg).slice(0, 300) : ''}`;
  } catch (_) {
    return String(resp.status);
  }
}

function fetchWithTimeout(url, opts = {}, ms = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return fetch(url, { ...opts, signal: ctrl.signal }).finally(() => clearTimeout(timer));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------- Facebook --------------------------------- */

async function publishFacebook(post, account, token) {
  const pageId = account.pageId;
  if (!pageId) return { ok: false, error: 'Facebook Page ID is missing on this account.' };

  const image = post.image;
  const localFile = image ? localFileFor(image) : null;
  const publicImage = image ? publicUrlFor(image) : null;

  // With a photo: upload the local file directly, or hand Facebook a public URL.
  if (localFile || publicImage) {
    const url = `${GRAPH}/${encodeURIComponent(pageId)}/photos`;
    let resp;
    if (localFile) {
      const fd = new FormData();
      fd.append('caption', post.text || '');
      fd.append('access_token', token);
      fd.append('source', new Blob([fs.readFileSync(localFile)], { type: guessMime(image) }), path.basename(localFile));
      resp = await fetchWithTimeout(url, { method: 'POST', body: fd });
    } else {
      resp = await fetchWithTimeout(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: publicImage, caption: post.text || '', access_token: token }),
      });
    }
    if (!resp.ok) return { ok: false, error: 'Facebook: ' + (await errorText(resp)) };
    const data = await resp.json();
    const id = data.post_id || data.id;
    return { ok: true, id, permalink: `https://www.facebook.com/${id}` };
  }

  // Text-only post.
  const resp = await fetchWithTimeout(`${GRAPH}/${encodeURIComponent(pageId)}/feed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ message: post.text || '', access_token: token }),
  });
  if (!resp.ok) return { ok: false, error: 'Facebook: ' + (await errorText(resp)) };
  const data = await resp.json();
  return { ok: true, id: data.id, permalink: `https://www.facebook.com/${data.id}` };
}

/* ------------------------------- Instagram -------------------------------- */

async function publishInstagram(post, account, token) {
  const igId = account.igId;
  if (!igId) return { ok: false, error: 'Instagram Business ID is missing on this account.' };

  const media = post.video || post.image;
  if (!media) return { ok: false, error: 'Instagram requires a photo or video — this post has neither.' };

  // Instagram can ONLY pull from a public URL; it cannot accept a file upload.
  const publicMedia = publicUrlFor(media);
  if (!publicMedia) {
    return {
      ok: false,
      error:
        'Instagram needs a public image URL. Set your deployed site address in Settings → Public site address, ' +
        'or use a post whose photo comes from your Shopify store.',
    };
  }

  const isVideo = !!post.video;
  const createBody = isVideo
    ? { media_type: 'REELS', video_url: publicMedia, caption: post.text || '', access_token: token }
    : { image_url: publicMedia, caption: post.text || '', access_token: token };

  const createResp = await fetchWithTimeout(`${GRAPH}/${encodeURIComponent(igId)}/media`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(createBody),
  });
  if (!createResp.ok) return { ok: false, error: 'Instagram: ' + (await errorText(createResp)) };
  const created = await createResp.json();
  const creationId = created.id;

  // Video containers need processing time before they can be published.
  if (isVideo) {
    let ready = false;
    for (let i = 0; i < 20 && !ready; i++) {
      await sleep(3000);
      const st = await fetchWithTimeout(
        `${GRAPH}/${encodeURIComponent(creationId)}?fields=status_code&access_token=${encodeURIComponent(token)}`
      );
      if (st.ok) {
        const s = await st.json();
        if (s.status_code === 'FINISHED') ready = true;
        else if (s.status_code === 'ERROR') return { ok: false, error: 'Instagram could not process that video.' };
      }
    }
    if (!ready) return { ok: false, error: 'Instagram is still processing the video — try publishing again shortly.' };
  }

  const pubResp = await fetchWithTimeout(`${GRAPH}/${encodeURIComponent(igId)}/media_publish`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ creation_id: creationId, access_token: token }),
  });
  if (!pubResp.ok) return { ok: false, error: 'Instagram: ' + (await errorText(pubResp)) };
  const published = await pubResp.json();
  return { ok: true, id: published.id, permalink: `https://www.instagram.com/p/${published.id}` };
}

/* -------------------------------- LinkedIn -------------------------------- */

function linkedInHeaders(token) {
  return {
    authorization: 'Bearer ' + token,
    'X-Restli-Protocol-Version': '2.0.0',
    'LinkedIn-Version': LINKEDIN_VERSION,
    'content-type': 'application/json',
  };
}

// Uploads an image and returns its urn:li:image — or null so we can still post
// the text rather than failing the whole publish.
async function linkedInUploadImage(post, ownerUrn, token) {
  try {
    const buf = await mediaBuffer(post.image);
    if (!buf) return null;
    const initResp = await fetchWithTimeout('https://api.linkedin.com/rest/images?action=initializeUpload', {
      method: 'POST',
      headers: linkedInHeaders(token),
      body: JSON.stringify({ initializeUploadRequest: { owner: ownerUrn } }),
    });
    if (!initResp.ok) return null;
    const init = await initResp.json();
    const value = (init && init.value) || {};
    if (!value.uploadUrl || !value.image) return null;
    const put = await fetchWithTimeout(value.uploadUrl, {
      method: 'PUT',
      headers: { authorization: 'Bearer ' + token, 'content-type': guessMime(post.image) },
      body: buf,
    });
    if (!put.ok) return null;
    return value.image;
  } catch (_) {
    return null;
  }
}

async function publishLinkedIn(post, account, token) {
  const org = String(account.orgUrn || '').trim();
  if (!org) return { ok: false, error: 'LinkedIn Organization URN / Page ID is missing on this account.' };
  // Accept a bare numeric id or a full URN.
  const author = /^urn:li:/.test(org) ? org : `urn:li:organization:${org}`;

  const body = {
    author,
    commentary: post.text || '',
    visibility: 'PUBLIC',
    distribution: { feedDistribution: 'MAIN_FEED', targetEntities: [], thirdPartyDistributionChannels: [] },
    lifecycleState: 'PUBLISHED',
    isReshareDisabledByAuthor: false,
  };

  if (post.image) {
    const imageUrn = await linkedInUploadImage(post, author, token);
    if (imageUrn) body.content = { media: { id: imageUrn } };
  }

  const resp = await fetchWithTimeout('https://api.linkedin.com/rest/posts', {
    method: 'POST',
    headers: linkedInHeaders(token),
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { ok: false, error: 'LinkedIn: ' + (await errorText(resp)) };
  const id = resp.headers.get('x-restli-id') || '';
  return { ok: true, id, permalink: id ? `https://www.linkedin.com/feed/update/${id}/` : null };
}

/* --------------------------- Google Business ------------------------------ */

async function publishGoogle(post, account, token) {
  const { accountId, locationId } = account;
  if (!accountId || !locationId) {
    return { ok: false, error: 'Google Business Account ID and Location ID are both required.' };
  }
  const brand = store.get().settings.brand;
  const body = {
    languageCode: 'en',
    summary: post.text || '',
    topicType: 'STANDARD',
  };
  const publicImage = post.image ? publicUrlFor(post.image) : null;
  if (publicImage) body.media = [{ mediaFormat: 'PHOTO', sourceUrl: publicImage }];
  if (brand && brand.website) {
    const site = /^https?:\/\//i.test(brand.website) ? brand.website : 'https://' + brand.website;
    body.callToAction = { actionType: 'LEARN_MORE', url: site };
  }

  const url =
    `https://mybusiness.googleapis.com/v4/accounts/${encodeURIComponent(accountId)}` +
    `/locations/${encodeURIComponent(locationId)}/localPosts`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!resp.ok) return { ok: false, error: 'Google Business: ' + (await errorText(resp)) };
  const data = await resp.json();
  return { ok: true, id: data.name || '', permalink: data.searchUrl || null };
}

/* ------------------------------ Shopify Blog ------------------------------ */

async function publishShopifyBlog(post, account) {
  const s = store.get().settings;
  const domain = String((s.shopify && s.shopify.domain) || '')
    .replace(/^https?:\/\//i, '')
    .replace(/\/.*$/, '');
  const token = decrypt((s.shopify && s.shopify.token) || '');
  if (!domain || !token) return { ok: false, error: 'Shopify store is not connected (add the Admin API token in Settings).' };
  if (!account || !account.blogId) return { ok: false, error: 'Shopify Blog ID is missing on this account.' };

  // Blog posts are written "title on line 1, blank line, then the body".
  const raw = String(post.text || '').trim();
  const lines = raw.split('\n');
  const title = (lines[0] || post.productTitle || 'New post').trim().slice(0, 240);
  const bodyText = lines.slice(1).join('\n').trim() || raw;
  const bodyHtml = bodyText
    .split(/\n{2,}/)
    .map((p) => `<p>${p.replace(/\n/g, '<br />')}</p>`)
    .join('\n');

  const article = { title, body_html: bodyHtml, published: true };
  // Attach the image: a public URL by reference, or the raw bytes if local.
  if (post.image) {
    if (/^https?:\/\//i.test(post.image)) {
      article.image = { src: post.image };
    } else {
      const buf = await mediaBuffer(post.image).catch(() => null);
      if (buf) article.image = { attachment: buf.toString('base64') };
    }
  }

  const url = `https://${domain}/admin/api/${SHOPIFY_API_VERSION}/blogs/${encodeURIComponent(account.blogId)}/articles.json`;
  const resp = await fetchWithTimeout(url, {
    method: 'POST',
    headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
    body: JSON.stringify({ article }),
  });
  if (!resp.ok) return { ok: false, error: 'Shopify Blog: ' + (await errorText(resp)) };
  const data = await resp.json();
  const a = data.article || {};
  return { ok: true, id: String(a.id || ''), permalink: a.handle ? `https://${domain}/blogs/news/${a.handle}` : null };
}

/* -------------------------------- dispatch -------------------------------- */

/**
 * Publish ONE post to ONE account. Resolves to {ok, permalink?, error?} and
 * never throws, so a platform outage can never crash the scheduler.
 */
async function publishPost(post, account) {
  try {
    const platform = post.platform;
    if (platform === 'blog') return await publishShopifyBlog(post, account); // uses the store token

    if (!account) return { ok: false, error: 'No account is connected for this platform yet.' };
    const token = decrypt(account.token || '');
    if (!token) return { ok: false, error: `No access token saved for "${account.label}".` };

    if (platform === 'fb') return await publishFacebook(post, account, token);
    if (platform === 'ig') return await publishInstagram(post, account, token);
    if (platform === 'linkedin') return await publishLinkedIn(post, account, token);
    if (platform === 'gmb') return await publishGoogle(post, account, token);
    return { ok: false, error: `Publishing is not supported for "${platform}".` };
  } catch (e) {
    // AbortError = our own timeout; anything else is a network/parse failure.
    const msg = e && e.name === 'AbortError' ? 'the platform did not respond in time' : (e && e.message) || 'unknown error';
    return { ok: false, error: `Could not reach the platform (${msg}).` };
  }
}

module.exports = { publishPost, publicUrlFor, verifyMediaSignature, UPLOADS_DIR, GENERATED_DIR };
