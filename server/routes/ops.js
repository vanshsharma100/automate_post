import express from 'express';
import { store } from '../store.js';
import { hashPassword, randomToken, accessToken } from '../crypto.js';
import { requireAuth, requireRole, fail, effectivePermissions, visibleConnectionIds } from '../auth.js';
import { audit } from '../audit.js';
import { publicUser } from './auth.js';
import * as C from '../constants.js';
import { PLATFORM_META, PLATFORM_CAPS } from '../constants.js';
import { runPipeline } from '../pipeline.js';
import { connectShopify, syncShopify } from '../shopify-client.js';
import { publishPost, masterMode } from '../scheduler.js';
import { usageFor } from '../storage.js';
import { addClient, removeClient } from '../events.js';
import { h, paginate, sortRows, pickBody } from './_helpers.js';

export const router = express.Router();
function tenant(req) { return store.get('tenants', req.auth.tenantId); }

// ── Bootstrap payload for the SPA ──────────────────────────────────────────────
router.get('/bootstrap', requireAuth, h((req, res) => {
  const t = tenant(req);
  res.json({
    user: publicUser(req.auth.user),
    tenant: { id: t.id, name: t.name, slug: t.slug, settings: t.settings },
    masterSwitch: masterMode(t),
    enums: { UserRole: C.UserRole, Platform: C.Platform, OperationMode: C.OperationMode, PostStatus: C.PostStatus, PostCategory: C.PostCategory, BrainRole: C.BrainRole, KnowledgeScope: C.KnowledgeScope, ProviderKind: C.ProviderKind, PurgeStrategy: C.PurgeStrategy },
    platformMeta: PLATFORM_META, platformCaps: PLATFORM_CAPS,
  });
}));

// ── Automation ─────────────────────────────────────────────────────────────────
router.get('/automation/status', requireAuth, h((req, res) => {
  const t = tenant(req);
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const connections = store.find('connections', (c) => c.tenantId === req.auth.tenantId && !c.archivedAt && visible.has(c.id))
    .map((c) => ({ id: c.id, label: c.label, platform: c.platform, mode: c.mode, status: c.status, breakerOpen: !!(c.circuitOpenUntil && new Date(c.circuitOpenUntil) > new Date()) }));
  res.json({ data: { masterSwitch: masterMode(t), connections, automated: connections.filter((c) => c.mode === 'AUTOPILOT').length } });
}));

router.put('/automation/master', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { mode } = req.body || {};
  if (!['AUTOPILOT', 'MANUAL', 'PAUSED'].includes(mode)) return fail(res, 400, 'VALIDATION', 'invalid mode');
  const t = tenant(req);
  store.update('tenants', t.id, { settings: { ...t.settings, masterSwitch: mode } });
  store.updateWhere('tenantSettings', (s) => s.tenantId === t.id && s.key === 'master_switch', { value: { mode } });
  audit(req, 'automation.master.toggle', { after: { mode } });
  res.json({ data: { masterSwitch: mode } });
}));

router.post('/automation/run', requireAuth, h(async (req, res) => {
  const { connectionId, category = 'KNOWLEDGE' } = req.body || {};
  const conn = store.get('connections', connectionId);
  if (!conn || conn.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Connection not found');
  if (!effectivePermissions(req.auth.user, connectionId).canEdit) return fail(res, 403, 'FORBIDDEN', 'No access');
  const result = await runPipeline({ tenantId: req.auth.tenantId, connectionId, category, trigger: 'MANUAL', shadow: conn.mode === 'SHADOW' });
  res.json({ data: { postId: result.post.id, runId: result.run.id, status: result.post.status, seoScore: result.seo.score } });
}));

router.get('/automation/runs', requireAuth, h((req, res) => {
  let rows = store.find('automationRuns', (r) => r.tenantId === req.auth.tenantId);
  if (req.query.connectionId) rows = rows.filter((r) => r.connectionId === req.query.connectionId);
  if (req.query.status) rows = rows.filter((r) => r.status === req.query.status);
  res.json(paginate(sortRows(rows, '-startedAt'), req.query));
}));

router.get('/automation/runs/:id', requireAuth, h((req, res) => {
  const run = store.get('automationRuns', req.params.id);
  if (!run || run.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Run not found');
  res.json({ data: run });
}));

// ── History + analytics ─────────────────────────────────────────────────────────
router.get('/history/calendar', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const rows = store.find('posts', (p) => p.tenantId === req.auth.tenantId && !p.archivedAt && visible.has(p.connectionId) && (p.scheduledAt || p.publishedAt))
    .map((p) => { const c = store.get('connections', p.connectionId); return { id: p.id, title: p.title, platform: c?.platform, status: p.status, at: p.publishedAt || p.scheduledAt, seoScore: p.seoScore }; });
  res.json({ data: rows });
}));

router.get('/history/posts', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  let rows = store.find('posts', (p) => p.tenantId === req.auth.tenantId && !p.archivedAt && visible.has(p.connectionId) && ['PUBLISHED', 'FAILED', 'SCHEDULED'].includes(p.status));
  if (req.query.platform) rows = rows.filter((p) => store.get('connections', p.connectionId)?.platform === req.query.platform);
  if (req.query.status) rows = rows.filter((p) => p.status === req.query.status);
  rows = sortRows(rows, '-publishedAt').map((p) => {
    const c = store.get('connections', p.connectionId);
    const cost = store.find('usageLedger', (u) => u.postId === p.id).reduce((s, u) => s + Number(u.costUsd || 0), 0);
    return { id: p.id, title: p.title, platform: c?.platform, connectionLabel: c?.label, category: p.category, status: p.status, seoScore: p.seoScore, costUsd: cost, publishedAt: p.publishedAt, scheduledAt: p.scheduledAt, externalUrl: p.externalUrl };
  });
  res.json(paginate(rows, req.query));
}));

router.get('/history/failures', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const failedPosts = store.find('posts', (p) => p.tenantId === req.auth.tenantId && p.status === 'FAILED' && visible.has(p.connectionId));
  const rows = failedPosts.map((p) => {
    const c = store.get('connections', p.connectionId);
    const attempts = store.find('publishAttempts', (a) => a.postId === p.id);
    const last = attempts[attempts.length - 1];
    return { id: p.id, title: p.title, platform: c?.platform, connectionLabel: c?.label, attempts, lastError: last?.errorMessage, httpStatus: last?.httpStatus };
  });
  res.json({ data: rows });
}));

router.get('/history/export', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const rows = store.find('posts', (p) => p.tenantId === req.auth.tenantId && ['PUBLISHED', 'FAILED'].includes(p.status) && visible.has(p.connectionId));
  const header = 'date,platform,title,category,status,seoScore,externalUrl';
  const lines = rows.map((p) => {
    const c = store.get('connections', p.connectionId);
    const date = (p.publishedAt || p.createdAt || '').slice(0, 10);
    return [date, c?.platform, `"${(p.title || '').replace(/"/g, '""')}"`, p.category, p.status, p.seoScore ?? '', p.externalUrl || ''].join(',');
  });
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', 'attachment; filename="history.csv"');
  res.send([header, ...lines].join('\n'));
}));

router.get('/analytics/overview', requireAuth, h((req, res) => {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const posts = store.find('posts', (p) => p.tenantId === req.auth.tenantId && visible.has(p.connectionId));
  const published = posts.filter((p) => p.status === 'PUBLISHED' && (p.publishedAt || '') >= since);
  const failed = posts.filter((p) => p.status === 'FAILED' && (p.updatedAt || p.createdAt) >= since);
  const scored = posts.filter((p) => typeof p.seoScore === 'number');
  const avgSeo = scored.length ? Math.round(scored.reduce((s, p) => s + p.seoScore, 0) / scored.length) : 0;
  const spend = store.find('usageLedger', (u) => u.tenantId === req.auth.tenantId && u.createdAt >= since).reduce((s, u) => s + Number(u.costUsd || 0), 0);
  // 12-slot sparkline of daily publishes
  const spark = [];
  for (let i = 11; i >= 0; i--) {
    const day = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10);
    spark.push(published.filter((p) => (p.publishedAt || '').slice(0, 10) === day).length);
  }
  res.json({ data: { published: published.length, failed: failed.length, avgSeo, spend: Math.round(spend * 100) / 100, successRate: published.length + failed.length ? Math.round((published.length / (published.length + failed.length)) * 100) : 100, spark } });
}));

router.get('/analytics/by-platform', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const byPlatform = {};
  for (const p of store.find('posts', (x) => x.tenantId === req.auth.tenantId && visible.has(x.connectionId))) {
    const plat = store.get('connections', p.connectionId)?.platform || 'UNKNOWN';
    byPlatform[plat] ||= { platform: plat, published: 0, failed: 0, scheduled: 0, avgSeo: 0, _seo: [] };
    if (p.status === 'PUBLISHED') byPlatform[plat].published++;
    if (p.status === 'FAILED') byPlatform[plat].failed++;
    if (p.status === 'SCHEDULED') byPlatform[plat].scheduled++;
    if (typeof p.seoScore === 'number') byPlatform[plat]._seo.push(p.seoScore);
  }
  const data = Object.values(byPlatform).map((r) => ({ ...r, avgSeo: r._seo.length ? Math.round(r._seo.reduce((a, b) => a + b, 0) / r._seo.length) : 0, _seo: undefined }));
  res.json({ data });
}));

// ── Storage overview ─────────────────────────────────────────────────────────────
router.get('/storage/overview', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const rows = store.find('connections', (c) => c.tenantId === req.auth.tenantId && !c.archivedAt && visible.has(c.id))
    .map((c) => ({ connectionId: c.id, label: c.label, platform: c.platform, ...usageFor(c.id) }));
  res.json({ data: rows });
}));

// ── Users + ACL (requirement 10) ─────────────────────────────────────────────────
router.get('/users', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  res.json({ data: store.find('users', (u) => u.tenantId === req.auth.tenantId).map(publicUser) });
}));

router.post('/users', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { username, role = 'EDITOR', email } = req.body || {};
  if (!username) return fail(res, 400, 'VALIDATION', 'username required');
  if (store.findOne('users', (u) => u.tenantId === req.auth.tenantId && u.username === username)) return fail(res, 409, 'CONFLICT', 'Username already exists');
  if (role === 'SUPER_ADMIN') return fail(res, 403, 'FORBIDDEN', 'Cannot create another SUPER_ADMIN');
  const tempPassword = randomToken(6);
  const user = store.insert('users', { tenantId: req.auth.tenantId, username, email: email || null, role, status: 'ACTIVE', passwordHash: hashPassword(tempPassword), mustChangePassword: true, createdById: req.auth.userId });
  audit(req, 'user.create', { entityType: 'user', entityId: user.id, after: { username, role } });
  res.status(201).json({ data: publicUser(user), tempPassword });
}));

router.patch('/users/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const u = store.get('users', req.params.id);
  if (!u || u.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  if (u.role === 'SUPER_ADMIN' && req.auth.role !== 'SUPER_ADMIN') return fail(res, 403, 'FORBIDDEN', 'Cannot modify the super admin');
  if (req.body.role === 'SUPER_ADMIN') return fail(res, 403, 'FORBIDDEN', 'Cannot promote to SUPER_ADMIN');
  const updated = store.update('users', u.id, pickBody(req.body, ['role', 'status', 'email']));
  audit(req, 'user.update', { entityType: 'user', entityId: u.id });
  res.json({ data: publicUser(updated) });
}));

router.delete('/users/:id', requireAuth, requireRole('SUPER_ADMIN'), h((req, res) => {
  const u = store.get('users', req.params.id);
  if (!u || u.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  if (u.role === 'SUPER_ADMIN') return fail(res, 403, 'FORBIDDEN', 'The super admin cannot be deleted');
  store.remove('users', u.id);
  audit(req, 'user.delete', { entityType: 'user', entityId: u.id });
  res.json({ ok: true });
}));

router.post('/users/:id/reset-password', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const u = store.get('users', req.params.id);
  if (!u || u.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const tempPassword = randomToken(6);
  store.update('users', u.id, { passwordHash: hashPassword(tempPassword), mustChangePassword: true });
  audit(req, 'user.reset_password', { entityType: 'user', entityId: u.id });
  res.json({ data: { tempPassword } });
}));

router.get('/users/:id/access', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const target = store.get('users', req.params.id);
  if (!target || target.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'User not found');
  const connections = store.find('connections', (c) => c.tenantId === req.auth.tenantId && !c.archivedAt);
  const acls = store.find('userPlatformAccess', (a) => a.userId === req.params.id);
  const byConn = Object.fromEntries(acls.map((a) => [a.connectionId, a]));
  res.json({ data: connections.map((c) => ({ connectionId: c.id, label: c.label, platform: c.platform, ...(byConn[c.id] || { canView: false, canEdit: false, canPublish: false, canManageCreds: false, canToggleMode: false }) })) });
}));

router.put('/users/:id/access', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const target = store.get('users', req.params.id);
  if (!target || target.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'User not found');
  const tenantConns = new Set(store.find('connections', (c) => c.tenantId === req.auth.tenantId).map((c) => c.id));
  const list = (Array.isArray(req.body?.access) ? req.body.access : []).filter((row) => tenantConns.has(row.connectionId));
  for (const row of list) {
    const existing = store.findOne('userPlatformAccess', (a) => a.userId === req.params.id && a.connectionId === row.connectionId);
    const patch = { canView: !!row.canView, canEdit: !!row.canEdit, canPublish: !!row.canPublish, canManageCreds: !!row.canManageCreds, canToggleMode: !!row.canToggleMode };
    if (existing) store.update('userPlatformAccess', existing.id, patch);
    else store.insert('userPlatformAccess', { userId: req.params.id, connectionId: row.connectionId, grantedById: req.auth.userId, ...patch });
  }
  audit(req, 'user.access.update', { entityType: 'user', entityId: req.params.id });
  res.json({ ok: true });
}));

// ── Shopify ───────────────────────────────────────────────────────────────────
router.get('/shopify/store', requireAuth, h((req, res) => {
  const st = store.findOne('shopifyStores', (s) => s.tenantId === req.auth.tenantId);
  if (!st) return res.json({ data: null });
  const hasToken = !!st.accessTokenEnc;
  res.json({ data: {
    ...st, accessTokenEnc: undefined,
    hasToken, isDemo: !hasToken,   // demo store ships without a token → simulated
    productCount: store.count('shopifyProducts', (p) => p.storeId === st.id),
    blogs: store.find('shopifyBlogs', (b) => b.storeId === st.id),
  } });
}));

// Token-paste connect (doc 04 §5.1): validates against the live Admin API,
// stores the token encrypted, then syncs blogs + products.
router.post('/shopify/connect', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const { shopDomain, accessToken, apiVersion } = req.body || {};
  try {
    const result = await connectShopify(tenant(req), { shopDomain, accessToken, apiVersion });
    audit(req, 'shopify.connect', { entityType: 'shopifyStore', entityId: result.store.id, after: { shopDomain: result.store.shopDomain } });
    res.status(201).json({ data: { shopDomain: result.store.shopDomain, shopName: result.shopName, connectionId: result.connectionId, ...result.counts } });
  } catch (e) {
    return fail(res, e.status && e.status < 500 ? 400 : 502, 'VALIDATION', e.message);
  }
}));

router.get('/shopify/products', requireAuth, h((req, res) => {
  const st = store.findOne('shopifyStores', (s) => s.tenantId === req.auth.tenantId);
  if (!st) return res.json({ data: [] });
  let rows = store.find('shopifyProducts', (p) => p.storeId === st.id);
  if (req.query.q) { const q = req.query.q.toLowerCase(); rows = rows.filter((p) => p.title.toLowerCase().includes(q)); }
  res.json({ data: sortRows(rows, 'lastPostedAt') });
}));

router.post('/shopify/sync', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const st = store.findOne('shopifyStores', (s) => s.tenantId === req.auth.tenantId);
  if (!st) return fail(res, 404, 'NOT_FOUND', 'No Shopify store connected');
  // Real sync when a token is present; the demo store just re-stamps the time.
  if (st.accessTokenEnc) {
    try {
      const counts = await syncShopify(tenant(req), st);
      audit(req, 'shopify.sync', { entityType: 'shopifyStore', entityId: st.id, after: counts });
      return res.json({ data: { ok: true, ...counts, productCount: counts.products, syncedAt: new Date().toISOString() } });
    } catch (e) { return fail(res, 502, 'INTERNAL', `Sync failed: ${e.message}`); }
  }
  store.update('shopifyStores', st.id, { lastFullSyncAt: new Date().toISOString(), syncStatus: 'idle' });
  audit(req, 'shopify.sync', { entityType: 'shopifyStore', entityId: st.id });
  res.json({ data: { ok: true, productCount: store.count('shopifyProducts', (p) => p.storeId === st.id), syncedAt: new Date().toISOString(), demo: true } });
}));

// ── Settings, audit, notifications ────────────────────────────────────────────────
router.get('/settings', requireAuth, h((req, res) => {
  const t = tenant(req);
  res.json({ data: { name: t.name, settings: t.settings, keys: store.find('tenantSettings', (s) => s.tenantId === t.id).map((s) => ({ key: s.key, value: s.value })) } });
}));

router.put('/settings', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const t = tenant(req);
  const settings = { ...t.settings, ...(req.body?.settings || {}) };
  store.update('tenants', t.id, { settings, name: req.body?.name || t.name });
  audit(req, 'settings.update');
  res.json({ data: { name: req.body?.name || t.name, settings } });
}));

router.get('/audit-logs', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  let rows = store.find('auditLogs', (a) => a.tenantId === req.auth.tenantId);
  if (req.query.action) rows = rows.filter((a) => a.action === req.query.action);
  if (req.query.userId) rows = rows.filter((a) => a.userId === req.query.userId);
  rows = sortRows(rows, '-createdAt').map((a) => ({ ...a, username: store.get('users', a.userId)?.username || 'system' }));
  res.json(paginate(rows, req.query));
}));

router.get('/notifications', requireAuth, h((req, res) => {
  const rows = store.find('notifications', (n) => n.tenantId === req.auth.tenantId);
  res.json({ data: sortRows(rows, '-createdAt').slice(0, 50), unread: rows.filter((n) => !n.readAt).length });
}));

router.post('/notifications/:id/read', requireAuth, h((req, res) => {
  const n = store.get('notifications', req.params.id);
  if (!n || n.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  store.update('notifications', req.params.id, { readAt: new Date().toISOString() });
  res.json({ ok: true });
}));

router.post('/notifications/read-all', requireAuth, h((req, res) => {
  store.updateWhere('notifications', (n) => n.tenantId === req.auth.tenantId && !n.readAt, { readAt: new Date().toISOString() });
  res.json({ ok: true });
}));

// ── SSE stream (auth via short-lived query token, since EventSource sends no headers) ──
router.get('/events/stream', h((req, res) => {
  const token = req.query.token;
  const payload = token ? accessToken.verify(token) : null;
  if (!payload) return fail(res, 401, 'UNAUTHORIZED', 'Invalid stream token');
  // Honour revocation/suspension, not just the signature (matches authMiddleware).
  const session = store.get('userSessions', payload.sessionId);
  const user = store.get('users', payload.sub);
  if (!session || session.revokedAt || !user || user.status === 'SUSPENDED') return fail(res, 401, 'UNAUTHORIZED', 'Session no longer valid');
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  const id = addClient(res, payload.tenantId);
  req.on('close', () => removeClient(id));
}));

// ── Health ─────────────────────────────────────────────────────────────────────
router.get('/health', (req, res) => res.json({ ok: true, ts: new Date().toISOString() }));
router.get('/health/deep', requireAuth, h((req, res) => {
  res.json({ data: {
    store: 'ok',
    tenants: store.count('tenants'), users: store.count('users'), posts: store.count('posts'),
    providers: store.find('aiProviders', (p) => p.tenantId === req.auth.tenantId).map((p) => ({ label: p.label, hasKey: !!p.apiKeyEnc, error: p.validationError })),
    connections: store.find('connections', (c) => c.tenantId === req.auth.tenantId && !c.archivedAt).map((c) => ({ label: c.label, status: c.status })),
  } });
}));
