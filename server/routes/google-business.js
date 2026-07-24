// Google Business Profile control surface — the GBP twin of routes/linkedin.js.
// Every call here hits the live Google APIs; nothing is simulated.
import express from 'express';
import { store } from '../store.js';
import { requireAuth, requireRole, fail } from '../auth.js';
import { audit } from '../audit.js';
import { h } from './_helpers.js';
import {
  getGoogleApp, setGoogleApp, clearGoogleApp, redirectUri, GBP_SCOPES,
  connectGoogleBusiness, accessTokenFromRefresh, listTargets, syncLocations,
  credentialsOf, ensureFreshToken, healthCheckGoogleBusiness, verifyGoogleBusinessPost,
} from '../google-business-client.js';

export const router = express.Router();

function gbpConnections(tenantId) {
  return store.find('connections', (c) => c.tenantId === tenantId && c.platform === 'GOOGLE_BUSINESS' && !c.archivedAt);
}

function publicConn(c) {
  const creds = c.config?.sandbox ? {} : credentialsOf(c);
  return {
    id: c.id, label: c.label, status: c.status, mode: c.mode, isActive: c.isActive,
    sandbox: !!c.config?.sandbox,
    locationId: c.externalAccountId || null,
    locationName: c.externalAccountName || null,
    hasToken: !!c.credentialsEnc,
    durable: !!creds.refreshToken,
    pendingDiscovery: !!c.config?.pendingDiscovery,
    pendingReason: c.config?.pendingReason || null,
    tokenExpiresAt: c.tokenExpiresAt || null,
    lastHealthCheckAt: c.lastHealthCheckAt || null,
    availableTargets: creds.targets || [],
    publishedCount: store.count('posts', (p) => p.connectionId === c.id && p.status === 'PUBLISHED'),
  };
}

router.get('/google-business/status', requireAuth, h((req, res) => {
  const app = getGoogleApp();
  res.json({
    data: {
      app: { configured: !!(app.clientId && app.clientSecret), clientId: app.clientId ? `${app.clientId.slice(0, 12)}…` : '', source: app.source },
      redirectUri: redirectUri(),
      scopes: GBP_SCOPES,
      connections: gbpConnections(req.auth.tenantId).map(publicConn),
    },
  });
}));

router.put('/google-business/app', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const tenant = store.get('tenants', req.auth.tenantId);
  setGoogleApp(tenant, { clientId: req.body?.clientId, clientSecret: req.body?.clientSecret });
  audit(req, 'gbp.app.save', { entityType: 'connection', entityId: 'GOOGLE_BUSINESS' });
  const app = getGoogleApp();
  res.json({ data: { configured: !!(app.clientId && app.clientSecret), redirectUri: redirectUri(), source: app.source } });
}));

router.delete('/google-business/app', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  clearGoogleApp();
  audit(req, 'gbp.app.clear', { entityType: 'connection', entityId: 'GOOGLE_BUSINESS' });
  res.json({ ok: true });
}));

// Probe credentials and list manageable locations before committing.
router.post('/google-business/inspect', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const { refreshToken, accessToken } = req.body || {};
  let token = String(accessToken || '').trim();
  let minted = null;
  if (!token) {
    const rt = String(refreshToken || '').trim();
    if (!rt) return fail(res, 400, 'VALIDATION', 'Provide a refresh token or an access token');
    minted = await accessTokenFromRefresh(rt);
    token = minted.accessToken;
  }
  const targets = await listTargets(token);
  res.json({
    data: {
      targets,
      locationCount: targets.length,
      durable: !!refreshToken,
      expiresAt: minted?.expiresAt || null,
      scopes: minted?.scopes || [],
    },
  });
}));

// Connect with a pasted refresh token (durable) or access token (1 hour).
router.post('/google-business/connect-token', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const tenant = store.get('tenants', req.auth.tenantId);
  const { refreshToken, accessToken, label, locationId, connectionId } = req.body || {};
  const bundle = {
    refreshToken: refreshToken ? String(refreshToken).trim() : null,
    accessToken: accessToken ? String(accessToken).trim() : null,
  };
  const result = await connectGoogleBusiness(tenant, bundle, { label, locationId, connectionId });
  audit(req, 'gbp.connect', { entityType: 'connection', entityId: result.connection.id, after: { location: result.connection.externalAccountId } });
  res.status(201).json({ data: { connection: publicConn(result.connection), targets: result.targets, durable: result.durable } });
}));

// Switch which location this connection posts to.
router.put('/google-business/connections/:id/location', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || conn.platform !== 'GOOGLE_BUSINESS') return fail(res, 404, 'NOT_FOUND', 'Not found');
  const creds = await ensureFreshToken(conn, credentialsOf(conn));
  const tenant = store.get('tenants', req.auth.tenantId);
  const result = await connectGoogleBusiness(tenant, creds, { locationId: req.body?.locationId, connectionId: conn.id, label: conn.label });
  audit(req, 'gbp.location.change', { entityType: 'connection', entityId: conn.id, after: { location: req.body?.locationId } });
  res.json({ data: publicConn(result.connection) });
}));

// Finish a connection that was saved before Google granted API access.
router.post('/google-business/connections/:id/sync', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || conn.platform !== 'GOOGLE_BUSINESS') return fail(res, 404, 'NOT_FOUND', 'Not found');
  const result = await syncLocations(conn, { locationId: req.body?.locationId });
  audit(req, 'gbp.sync', { entityType: 'connection', entityId: conn.id, after: { location: result.target.id } });
  res.json({ data: { connection: publicConn(result.connection), targets: result.targets } });
}));

router.post('/google-business/connections/:id/test', requireAuth, h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || conn.platform !== 'GOOGLE_BUSINESS') return fail(res, 404, 'NOT_FOUND', 'Not found');
  const health = await healthCheckGoogleBusiness(conn);
  store.update('connections', conn.id, { status: health.status, lastHealthCheckAt: health.at });
  res.json({ data: health });
}));

router.get('/google-business/posts/:postId/verify', requireAuth, h(async (req, res) => {
  const post = store.get('posts', req.params.postId);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const conn = store.get('connections', post.connectionId);
  if (!conn || conn.platform !== 'GOOGLE_BUSINESS') return fail(res, 400, 'VALIDATION', 'Not a Google Business post');
  res.json({ data: await verifyGoogleBusinessPost(conn, post.externalId) });
}));
