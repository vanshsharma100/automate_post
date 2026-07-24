import express from 'express';
import { store } from '../store.js';
import { cuid } from '../crypto.js';
import { requireAuth, requireConnectionAccess, visibleConnectionIds, effectivePermissions, fail } from '../auth.js';
import { audit } from '../audit.js';
import { PLATFORM_META, PLATFORM_CAPS } from '../constants.js';
import { runPipeline, composeDraft, keywordBrief, ideate, applyContentToPost, policyCheck, nextSlotFor } from '../pipeline.js';
import { scoreSeo } from '../seo.js';
import { humanScore, bannedList, stripBannedPhrases } from '../humanizer.js';
import { validatePost } from '../connectors/index.js';
import { publishPost } from '../scheduler.js';
import { checkQuotaWarning } from '../storage.js';
import { saveUploadBytes, publicUrlFor, uploadPath, kindFor, imageDimensions, removeAssetFile } from '../media-store.js';
import { existsSync, createReadStream, statSync } from 'node:fs';
import { h, paginate, sortRows, pickBody } from './_helpers.js';

const UPLOAD_MIME_OK = /^(image\/(jpeg|jpg|png|gif|webp)|video\/(mp4|quicktime|webm))$/i;
const MAX_UPLOAD_BYTES = 60 * 1024 * 1024;   // 60MB — generous for short video

export const router = express.Router();

function seoOptsFor(post) {
  const conn = store.get('connections', post.connectionId);
  const isBlog = !!PLATFORM_META[conn?.platform]?.longForm;
  const media = store.find('mediaAssets', (m) => m.postId === post.id && !m.purgedAt);
  return { isBlog, wordBand: PLATFORM_CAPS[conn?.platform]?.wordBand, media, platform: conn?.platform, connection: conn };
}
// Tenant-scoped fetch — returns the post only if it belongs to the caller's
// tenant, so admin all-permissions can't reach across tenants.
function ownedPost(req, id) {
  const p = store.get('posts', id);
  return p && p.tenantId === req.auth.tenantId ? p : null;
}
function canEditPost(req, post) {
  return effectivePermissions(req.auth.user, post.connectionId).canEdit;
}
function writeRevision(post, reason, userId) {
  const version = store.count('postRevisions', (r) => r.postId === post.id) + 1;
  store.insert('postRevisions', { postId: post.id, version, snapshot: post, reason, editedById: userId });
}
function enrichPost(post) {
  const conn = store.get('connections', post.connectionId);
  const media = store.find('mediaAssets', (m) => m.postId === post.id);
  return { ...post, platform: conn?.platform, platformMeta: PLATFORM_META[conn?.platform], connectionLabel: conn?.label, media };
}

// ── Posts list ───────────────────────────────────────────────────────────────
router.get('/posts', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  let rows = store.find('posts', (p) => p.tenantId === req.auth.tenantId && !p.archivedAt && visible.has(p.connectionId));
  if (req.query.connectionId) rows = rows.filter((p) => p.connectionId === req.query.connectionId);
  if (req.query.status) rows = rows.filter((p) => p.status === req.query.status);
  if (req.query.category) rows = rows.filter((p) => p.category === req.query.category);
  if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter((p) => (p.title || '').toLowerCase().includes(q)); }
  rows = sortRows(rows, req.query.sort, '-createdAt').map(enrichPost);
  res.json(paginate(rows, req.query));
}));

router.get('/posts/:id', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Post not found');
  if (!effectivePermissions(req.auth.user, post.connectionId).canView) return fail(res, 403, 'FORBIDDEN', 'No access');
  res.json({ data: enrichPost(post) });
}));

// ── Generate (runs the 8-stage pipeline; emits SSE progress) ─────────────────
router.post('/posts/generate', requireAuth, requireConnectionAccess('canEdit'), h(async (req, res) => {
  const { category = 'KNOWLEDGE', ideaId, topic, productId } = req.body || {};
  const result = await runPipeline({
    tenantId: req.auth.tenantId, connectionId: req.connection.id, category, topic, productId,
    trigger: 'MANUAL', idea: ideaId ? ideaFromRow(req, ideaId) : undefined,
  });
  audit(req, 'post.generate', { entityType: 'post', entityId: result.post.id });
  res.status(201).json({ data: enrichPost(result.post), runId: result.run.id, seo: result.seo });
}));

function ideaFromRow(req, ideaId) {
  const row = store.get('contentIdeas', ideaId);
  if (!row || row.tenantId !== req.auth.tenantId) return undefined;
  return { category: row.category, topic: row.topic, angle: row.angle, primaryKeyword: row.primaryKeyword, product: row.sourceProductId ? store.get('shopifyProducts', row.sourceProductId) : null };
}

// ── Fan-out one idea to several connections (native variants) ─────────────────
router.post('/posts/fan-out', requireAuth, h(async (req, res) => {
  const { ideaId, connectionIds = [] } = req.body || {};
  const idea = ideaFromRow(req, ideaId);
  if (!idea) return fail(res, 404, 'NOT_FOUND', 'Idea not found');
  const group = store.insert('postGroups', { tenantId: req.auth.tenantId, ideaId, title: idea.topic });
  const posts = [];
  for (const cid of connectionIds) {
    const conn = store.get('connections', cid);
    if (!conn || conn.tenantId !== req.auth.tenantId) continue;   // tenant scope
    if (!effectivePermissions(req.auth.user, cid).canEdit) continue;
    const r = await runPipeline({ tenantId: req.auth.tenantId, connectionId: cid, category: idea.category, idea, trigger: 'MANUAL' });
    store.update('posts', r.post.id, { groupId: group.id });
    posts.push(enrichPost(store.get('posts', r.post.id)));
  }
  res.status(201).json({ data: { group, posts } });
}));

// ── Manual create (requirement 5) ──────────────────────────────────────────────
router.post('/posts', requireAuth, requireConnectionAccess('canEdit'), h((req, res) => {
  const conn = req.connection;
  const post = store.insert('posts', {
    tenantId: req.auth.tenantId, connectionId: conn.id, category: req.body.category || 'CUSTOM', status: 'DRAFT',
    title: req.body.title || 'Untitled', body: req.body.body || '', isManual: true, createdById: req.auth.userId,
    primaryKeyword: req.body.primaryKeyword || null, hashtags: req.body.hashtags || [], language: 'en',
  });
  audit(req, 'post.create.manual', { entityType: 'post', entityId: post.id });
  res.status(201).json({ data: enrichPost(post) });
}));

// ── Edit any field → writes a revision ─────────────────────────────────────────
router.patch('/posts/:id', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Post not found');
  if (!canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No edit access');
  writeRevision(post, 'manual_edit', req.auth.userId);
  const patch = pickBody(req.body, ['title', 'body', 'excerpt', 'hashtags', 'callToAction', 'linkUrl', 'seoTitle', 'seoDescription', 'slug', 'primaryKeyword', 'keywords', 'internalLinks', 'externalLinks', 'faq', 'category']);
  store.update('posts', post.id, patch);
  // Re-score after an edit so the composer ring stays truthful.
  const updated = store.get('posts', post.id);
  const seo = scoreSeo(updated, seoOptsFor(updated));
  store.update('posts', post.id, { seoScore: seo.score, seoReport: seo.checks, wordCount: seo.wordCount, readabilityGrade: seo.readability });
  res.json({ data: enrichPost(store.get('posts', post.id)), seo });
}));

router.delete('/posts/:id', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Post not found');
  if (!canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No access');
  store.update('posts', post.id, { status: 'ARCHIVED', archivedAt: new Date().toISOString() });
  audit(req, 'post.delete', { entityType: 'post', entityId: post.id });
  res.json({ ok: true });
}));

// ── Stage re-runs ────────────────────────────────────────────────────────────
router.post('/posts/:id/regenerate', requireAuth, h(async (req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No access');
  const scope = req.body?.scope || 'all';
  const conn = store.get('connections', post.connectionId);
  const idea = { category: post.category, topic: post.primaryKeyword || post.title, angle: 'a fresh angle', primaryKeyword: post.primaryKeyword };
  const kw = keywordBrief(idea);
  const content = composeDraft(conn.platform, { idea, kw, product: null, brandVoice: null });
  writeRevision(post, 'ai_regenerate', req.auth.userId);
  if (scope === 'all') applyContentToPost(post.id, conn.platform, content, null);
  else if (scope === 'title') store.update('posts', post.id, { title: content.title, seoTitle: content.seoTitle });
  else if (scope === 'body') store.update('posts', post.id, { body: content.body });
  else if (scope === 'hashtags') store.update('posts', post.id, { hashtags: content.hashtags });
  else if (scope === 'image') { store.removeWhere('mediaAssets', (m) => m.postId === post.id); createImage(post, conn, content); }
  const updated = store.get('posts', post.id);
  const seo = scoreSeo(updated, seoOptsFor(updated));
  store.update('posts', post.id, { seoScore: seo.score, seoReport: seo.checks, wordCount: seo.wordCount });
  res.json({ data: enrichPost(store.get('posts', post.id)), seo });
}));

router.post('/posts/:id/humanize', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No access');
  const bv = store.find('brandVoices', (b) => b.tenantId === req.auth.tenantId).find((b) => b.isDefault);
  const banned = bannedList(bv);
  const strip = stripBannedPhrases(post.body || '', banned);
  writeRevision(post, 'humanize', req.auth.userId);
  store.update('posts', post.id, { body: strip.text, humanizePassed: true });
  const score = humanScore(strip.text, { banned });
  res.json({ data: enrichPost(store.get('posts', post.id)), humanScore: score, removed: strip.removed });
}));

router.post('/posts/:id/seo-audit', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const seo = scoreSeo(post, seoOptsFor(post));
  store.update('posts', post.id, { seoScore: seo.score, seoReport: seo.checks, wordCount: seo.wordCount });
  res.json({ data: seo });
}));

router.post('/posts/:id/policy-check', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const policy = policyCheck(post, null);
  store.update('posts', post.id, { policyPassed: policy.pass, policyReport: policy });
  res.json({ data: policy });
}));

router.post('/posts/:id/approve', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !effectivePermissions(req.auth.user, post.connectionId).canPublish) return fail(res, 403, 'FORBIDDEN', 'Needs publish permission');
  store.update('posts', post.id, { status: 'APPROVED', approvedById: req.auth.userId, approvedAt: new Date().toISOString() });
  audit(req, 'post.approve', { entityType: 'post', entityId: post.id });
  res.json({ data: enrichPost(store.get('posts', post.id)) });
}));

router.post('/posts/:id/schedule', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !effectivePermissions(req.auth.user, post.connectionId).canPublish) return fail(res, 403, 'FORBIDDEN', 'Needs publish permission');
  const when = req.body?.scheduledAt || nextSlotFor(post.connectionId) || new Date(Date.now() + 3600e3).toISOString();
  store.update('posts', post.id, { status: 'SCHEDULED', scheduledAt: when, idempotencyKey: post.idempotencyKey || cuid('idem') });
  audit(req, 'post.schedule', { entityType: 'post', entityId: post.id, after: { scheduledAt: when } });
  res.json({ data: enrichPost(store.get('posts', post.id)) });
}));

router.post('/posts/:id/unschedule', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !effectivePermissions(req.auth.user, post.connectionId).canPublish) return fail(res, 403, 'FORBIDDEN', 'No access');
  store.update('posts', post.id, { status: 'APPROVED', scheduledAt: null });
  res.json({ data: enrichPost(store.get('posts', post.id)) });
}));

router.post('/posts/:id/publish', requireAuth, h(async (req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !effectivePermissions(req.auth.user, post.connectionId).canPublish) return fail(res, 403, 'FORBIDDEN', 'Needs publish permission');
  // Publish-now bypasses the schedule but not the policy gate.
  if (!post.policyPassed) { const policy = policyCheck(post, null); if (!policy.pass) return fail(res, 400, 'VALIDATION', `Policy gate blocked: ${policy.issues[0]?.detail}`); }
  store.update('posts', post.id, { status: 'APPROVED', idempotencyKey: post.idempotencyKey || cuid('idem') });
  const result = await publishPost(post.id, { manual: true });
  audit(req, 'post.publish.manual', { entityType: 'post', entityId: post.id });
  res.json({ data: enrichPost(store.get('posts', post.id)), result });
}));

router.post('/posts/:id/retry', requireAuth, h(async (req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !effectivePermissions(req.auth.user, post.connectionId).canPublish) return fail(res, 403, 'FORBIDDEN', 'No access');
  store.update('posts', post.id, { status: 'APPROVED', idempotencyKey: cuid('idem') });
  const result = await publishPost(post.id, { manual: true });
  res.json({ data: enrichPost(store.get('posts', post.id)), result });
}));

router.get('/posts/:id/revisions', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !effectivePermissions(req.auth.user, post.connectionId).canView) return fail(res, 404, 'NOT_FOUND', 'Post not found');
  res.json({ data: store.find('postRevisions', (r) => r.postId === req.params.id) });
}));

router.post('/posts/:id/revisions/:v/revert', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || !canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No access');
  const rev = store.findOne('postRevisions', (r) => r.postId === post.id && r.version === Number(req.params.v));
  if (!rev) return fail(res, 404, 'NOT_FOUND', 'Revision not found');
  const s = rev.snapshot;
  store.update('posts', post.id, pickBody(s, ['title', 'body', 'excerpt', 'hashtags', 'seoTitle', 'seoDescription', 'slug', 'primaryKeyword', 'keywords', 'internalLinks', 'externalLinks', 'faq']));
  res.json({ data: enrichPost(store.get('posts', post.id)) });
}));

// Platform-accurate preview payload + live validation (doc 07 §6).
router.get('/posts/:id/preview', requireAuth, h((req, res) => {
  const post = ownedPost(req, req.params.id);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const conn = store.get('connections', post.connectionId);
  const media = store.find('mediaAssets', (m) => m.postId === post.id && !m.purgedAt);
  const validation = validatePost(conn.platform, post, media);
  res.json({ data: { post: enrichPost(post), platform: conn.platform, meta: PLATFORM_META[conn.platform], capabilities: PLATFORM_CAPS[conn.platform], account: conn.externalAccountName || conn.label, validation } });
}));

// ── Ideas ──────────────────────────────────────────────────────────────────────
router.get('/ideas', requireAuth, h((req, res) => {
  let rows = store.find('contentIdeas', (i) => i.tenantId === req.auth.tenantId);
  if (req.query.status) rows = rows.filter((i) => i.status === req.query.status);
  if (req.query.category) rows = rows.filter((i) => i.category === req.query.category);
  res.json({ data: sortRows(rows, '-createdAt') });
}));

router.post('/ideas/generate', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  const { category = 'KNOWLEDGE', count = 5 } = req.body || {};
  const out = [];
  for (let i = 0; i < Math.min(10, count); i++) {
    const idea = ideate(req.auth.tenantId, req.connection, category);
    const kw = keywordBrief(idea);
    out.push(store.insert('contentIdeas', {
      tenantId: req.auth.tenantId, category: idea.category, topic: idea.topic, angle: idea.angle, rationale: idea.rationale,
      sourceProductId: idea.product?.id || null, primaryKeyword: idea.primaryKeyword, keywords: [kw.primary, ...kw.secondary],
      score: 50 + Math.floor(Math.random() * 45), status: 'new',
    }));
  }
  res.status(201).json({ data: out });
}));

router.patch('/ideas/:id', requireAuth, h((req, res) => {
  const idea = store.get('contentIdeas', req.params.id);
  if (!idea || idea.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  res.json({ data: store.update('contentIdeas', idea.id, pickBody(req.body, ['status', 'topic', 'angle'])) });
}));

// ── Media ────────────────────────────────────────────────────────────────────
router.get('/media', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  let rows = store.find('mediaAssets', (m) => m.tenantId === req.auth.tenantId);
  if (req.query.connectionId) rows = rows.filter((m) => m.connectionId === req.query.connectionId);
  if (req.query.purged === 'false') rows = rows.filter((m) => !m.purgedAt);
  rows = rows.filter((m) => !m.connectionId || visible.has(m.connectionId));
  res.json({ data: sortRows(rows, '-createdAt') });
}));

// Manual upload — real bytes for a real image/video, attached to a post.
// Body is the raw file; Content-Type is the mime; ?filename= and ?altText=
// optional. express.raw is applied per-route so the global JSON parser (which
// ignores non-JSON content types) never touches the binary body.
router.post('/media/upload', requireAuth, express.raw({ type: () => true, limit: MAX_UPLOAD_BYTES }), h((req, res) => {
  const postId = req.query.postId;
  const post = postId ? ownedPost(req, postId) : null;
  if (!post) return fail(res, 400, 'VALIDATION', 'postId required');
  if (!canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No access');

  const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (!UPLOAD_MIME_OK.test(mime)) return fail(res, 400, 'VALIDATION', `Unsupported type "${mime || 'unknown'}". Allowed: JPG, PNG, GIF, WebP, MP4, MOV, WebM.`);
  const buf = Buffer.isBuffer(req.body) ? req.body : null;
  if (!buf || !buf.length) return fail(res, 400, 'VALIDATION', 'Empty upload body');
  if (buf.length > MAX_UPLOAD_BYTES) return fail(res, 413, 'TOO_LARGE', 'File exceeds 60MB');

  const conn = store.get('connections', post.connectionId);
  const assetId = cuid('med');
  const saved = saveUploadBytes(assetId, buf, mime);
  const dims = imageDimensions(buf, mime);
  const asset = store.insert('mediaAssets', {
    id: assetId, tenantId: post.tenantId, postId: post.id, connectionId: conn?.id || null,
    kind: kindFor(mime), source: 'UPLOAD', mimeType: mime,
    storageFilename: saved.filename, storageKey: `uploads/${saved.filename}`,
    publicUrl: publicUrlFor(assetId), bytes: saved.bytes,
    width: dims.width || null, height: dims.height || null,
    altText: req.query.altText || post.primaryKeyword || `${post.title || 'media'}`,
    caption: '',
  });
  // A manual image upload replaces the AI placeholder image(s) for this post —
  // the byte-less "sim/*.svg" ones. The real file becomes the single image the
  // preview shows and every connector publishes. (Videos are left alone.)
  if (asset.kind === 'IMAGE') {
    store.find('mediaAssets', (m) => m.postId === post.id && m.id !== assetId && m.kind === 'IMAGE' && m.source !== 'UPLOAD')
      .forEach((old) => { removeAssetFile(old); store.remove('mediaAssets', old.id); });
  }
  audit(req, 'media.upload', { entityType: 'post', entityId: post.id, after: { kind: asset.kind, bytes: asset.bytes } });
  checkQuotaWarning(post.connectionId);
  res.status(201).json({ data: asset });
}));

// Serve a stored asset. Intentionally unauthenticated: <img>/<video> tags and
// (when WEB_URL is public) the social platforms fetch it without auth headers.
// The opaque cuid is the capability. Local single-tenant deployment (doc 01).
router.get('/media/file/:id', h((req, res) => {
  const asset = store.get('mediaAssets', req.params.id);
  if (!asset || !asset.storageFilename) return res.status(404).end();
  const abs = uploadPath(asset.storageFilename);
  if (!existsSync(abs)) return res.status(404).end();
  res.setHeader('Content-Type', asset.mimeType || 'application/octet-stream');
  res.setHeader('Content-Length', statSync(abs).size);
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
  createReadStream(abs).pipe(res);
}));

router.post('/media/generate', requireAuth, h((req, res) => {
  const post = req.body?.postId ? ownedPost(req, req.body.postId) : null;
  if (!post) return fail(res, 400, 'VALIDATION', 'postId required');
  if (!canEditPost(req, post)) return fail(res, 403, 'FORBIDDEN', 'No access');
  const conn = store.get('connections', post.connectionId);
  const media = createImage(post, conn, { imageBrief: req.body?.brief, altText: post.primaryKeyword });
  checkQuotaWarning(post.connectionId);
  res.status(201).json({ data: media });
}));

router.patch('/media/:id', requireAuth, h((req, res) => {
  const m = store.get('mediaAssets', req.params.id);
  if (!m || m.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  res.json({ data: store.update('mediaAssets', m.id, pickBody(req.body, ['altText', 'caption'])) });
}));

router.delete('/media/:id', requireAuth, h((req, res) => {
  const m = store.get('mediaAssets', req.params.id);
  if (!m || m.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  removeAssetFile(m);
  store.remove('mediaAssets', m.id);
  res.json({ ok: true });
}));

function createImage(post, conn, content) {
  return store.insert('mediaAssets', {
    tenantId: post.tenantId, postId: post.id, connectionId: conn.id, kind: 'IMAGE', source: 'AI_GENERATED',
    storageKey: `sim/${post.id}-${Date.now()}.svg`, thumbnailKey: `sim/${post.id}-thumb.svg`, mimeType: 'image/svg+xml',
    bytes: 150000 + Math.floor(Math.random() * 400000), width: 1200, height: 900,
    altText: content.altText || `${post.primaryKeyword || 'image'} for ${conn.label}`,
    aiMeta: { brief: content.imageBrief, visionQa: { score: 86, matchesPost: true, hasGarbledText: false } },
  });
}
