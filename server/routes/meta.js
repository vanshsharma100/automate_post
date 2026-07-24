// Facebook + Instagram control surface — the Meta twin of routes/linkedin.js.
// One Meta app powers both; the routes are parametrised by platform.
import express from 'express';
import { store } from '../store.js';
import { requireAuth, requireRole, fail } from '../auth.js';
import { audit } from '../audit.js';
import { h } from './_helpers.js';
import {
  getMetaApp, setMetaApp, clearMetaApp, redirectUri, scopesFor,
  connectMeta, listTargets, longLiveUserToken, debugToken,
  credentialsOf, healthCheckMeta, verifyMetaPost,
} from '../meta-client.js';

export const router = express.Router();

const PLATFORMS = { facebook: 'FACEBOOK', instagram: 'INSTAGRAM' };
function resolvePlatform(req, res) {
  const p = PLATFORMS[String(req.params.network || '').toLowerCase()];
  if (!p) { fail(res, 404, 'NOT_FOUND', 'Unknown network'); return null; }
  return p;
}

function conns(tenantId, platform) {
  return store.find('connections', (c) => c.tenantId === tenantId && c.platform === platform && !c.archivedAt);
}

function publicConn(c) {
  const creds = c.config?.sandbox ? {} : credentialsOf(c);
  return {
    id: c.id, label: c.label, status: c.status, mode: c.mode, isActive: c.isActive,
    platform: c.platform, sandbox: !!c.config?.sandbox,
    targetId: c.externalAccountId || null, targetName: c.externalAccountName || null,
    pageName: c.config?.pageName || null,
    scopes: c.scopes || [], hasToken: !!c.credentialsEnc,
    tokenExpiresAt: c.tokenExpiresAt || null, lastHealthCheckAt: c.lastHealthCheckAt || null,
    availableTargets: (creds.targets || []).map((t) => ({ id: t.id, name: t.name })),
    publishedCount: store.count('posts', (p) => p.connectionId === c.id && p.status === 'PUBLISHED'),
  };
}

// One Meta app, so status is shared; `network` just filters the connections.
router.get('/meta/:network/status', requireAuth, h((req, res) => {
  const platform = resolvePlatform(req, res); if (!platform) return;
  const app = getMetaApp();
  res.json({
    data: {
      app: { configured: !!(app.clientId && app.clientSecret), clientId: app.clientId ? `${app.clientId.slice(0, 6)}…` : '', source: app.source },
      redirectUri: redirectUri(platform),
      scopes: scopesFor(platform),
      connections: conns(req.auth.tenantId, platform).map(publicConn),
    },
  });
}));

router.put('/meta/app', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const tenant = store.get('tenants', req.auth.tenantId);
  setMetaApp(tenant, { clientId: req.body?.clientId, clientSecret: req.body?.clientSecret });
  audit(req, 'meta.app.save', { entityType: 'connection', entityId: 'META' });
  const app = getMetaApp();
  res.json({ data: { configured: !!(app.clientId && app.clientSecret), source: app.source } });
}));

router.delete('/meta/app', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  clearMetaApp();
  audit(req, 'meta.app.clear', { entityType: 'connection', entityId: 'META' });
  res.json({ ok: true });
}));

// Probe a token and list the pages / IG accounts it can publish to.
router.post('/meta/:network/inspect', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const platform = resolvePlatform(req, res); if (!platform) return;
  const raw = String(req.body?.accessToken || '').trim();
  if (!raw) return fail(res, 400, 'VALIDATION', 'accessToken required');
  const ll = req.body?.isPageToken ? { accessToken: raw, longLived: false } : await longLiveUserToken(raw);
  const [targets, meta] = await Promise.all([listTargets(platform, ll.accessToken), debugToken(ll.accessToken)]);
  const needed = platform === 'INSTAGRAM' ? 'instagram_content_publish' : 'pages_manage_posts';
  res.json({
    data: {
      targets, targetCount: targets.length, longLived: ll.longLived,
      scopes: meta?.scopes || [], expiresAt: meta?.expiresAt || ll.expiresAt || null,
      canPublish: !meta?.scopes?.length || meta.scopes.includes(needed),
      neededScope: needed,
    },
  });
}));

// Connect by pasting a token.
router.post('/meta/:network/connect-token', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const platform = resolvePlatform(req, res); if (!platform) return;
  const tenant = store.get('tenants', req.auth.tenantId);
  const bundle = { accessToken: String(req.body?.accessToken || '').trim(), isPageToken: !!req.body?.isPageToken };
  const result = await connectMeta(tenant, platform, bundle, { label: req.body?.label, targetId: req.body?.targetId });
  audit(req, 'meta.connect', { entityType: 'connection', entityId: result.connection.id, after: { platform, target: result.connection.externalAccountId } });
  res.status(201).json({ data: { connection: publicConn(result.connection), targets: result.targets } });
}));

// Switch which page / IG account this connection publishes to.
router.put('/meta/connections/:id/target', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || !['FACEBOOK', 'INSTAGRAM'].includes(conn.platform)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const creds = credentialsOf(conn);
  if (!creds.accessToken) return fail(res, 400, 'VALIDATION', 'This connection has no stored token');
  const tenant = store.get('tenants', req.auth.tenantId);
  const result = await connectMeta(tenant, conn.platform, { accessToken: creds.accessToken }, { targetId: req.body?.targetId, connectionId: conn.id, label: conn.label });
  audit(req, 'meta.target.change', { entityType: 'connection', entityId: conn.id, after: { target: req.body?.targetId } });
  res.json({ data: publicConn(result.connection) });
}));

router.post('/meta/connections/:id/test', requireAuth, h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || !['FACEBOOK', 'INSTAGRAM'].includes(conn.platform)) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const health = await healthCheckMeta(conn);
  store.update('connections', conn.id, { status: health.status, lastHealthCheckAt: health.at });
  res.json({ data: health });
}));

router.get('/meta/posts/:postId/verify', requireAuth, h(async (req, res) => {
  const post = store.get('posts', req.params.postId);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const conn = store.get('connections', post.connectionId);
  if (!conn || !['FACEBOOK', 'INSTAGRAM'].includes(conn.platform)) return fail(res, 400, 'VALIDATION', 'Not a Meta post');
  res.json({ data: await verifyMetaPost(conn, post.externalId) });
}));
