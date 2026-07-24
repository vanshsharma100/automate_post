// LinkedIn control surface — the LinkedIn twin of the Shopify connect flow.
// Everything here talks to the live LinkedIn API; nothing is simulated.
import express from 'express';
import { store } from '../store.js';
import { requireAuth, requireRole, fail } from '../auth.js';
import { audit } from '../audit.js';
import { h } from './_helpers.js';
import {
  getLinkedInApp, setLinkedInApp, clearLinkedInApp, redirectUri, scopesFor,
  connectLinkedIn, resolveMember, listOrganizations, introspect,
  credentialsOf, ensureFreshToken, healthCheckLinkedIn, verifyLinkedInPost, withScopeEvidence,
} from '../linkedin-client.js';

export const router = express.Router();

function liveConnections(tenantId) {
  return store.find('connections', (c) => c.tenantId === tenantId && c.platform === 'LINKEDIN' && !c.archivedAt);
}

function publicConn(c) {
  const creds = c.config?.sandbox ? {} : credentialsOf(c);
  return {
    id: c.id, label: c.label, status: c.status, mode: c.mode, isActive: c.isActive,
    sandbox: !!c.config?.sandbox,
    authorUrn: c.externalAccountId || null,
    authorName: c.externalAccountName || null,
    authorKind: c.config?.authorKind || (String(c.externalAccountId || '').includes(':organization:') ? 'ORGANIZATION' : 'PERSON'),
    scopes: c.scopes || [],
    hasToken: !!c.credentialsEnc,
    canRefresh: !!creds.refreshToken,
    tokenExpiresAt: c.tokenExpiresAt || null,
    lastHealthCheckAt: c.lastHealthCheckAt || null,
    availableTargets: creds.targets || [],
    publishedCount: store.count('posts', (p) => p.connectionId === c.id && p.status === 'PUBLISHED'),
  };
}

// ── Status ────────────────────────────────────────────────────────────────────
router.get('/linkedin/status', requireAuth, h((req, res) => {
  const app = getLinkedInApp();
  res.json({
    data: {
      app: { configured: !!(app.clientId && app.clientSecret), clientId: app.clientId ? `${app.clientId.slice(0, 4)}…${app.clientId.slice(-3)}` : '', source: app.source },
      redirectUri: redirectUri(),
      scopes: { member: scopesFor(), organizations: scopesFor({ organizations: true }) },
      connections: liveConnections(req.auth.tenantId).map(publicConn),
    },
  });
}));

// ── App credentials (set from the UI — no .env edit, no restart) ─────────────
router.put('/linkedin/app', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const tenant = store.get('tenants', req.auth.tenantId);
  setLinkedInApp(tenant, { clientId: req.body?.clientId, clientSecret: req.body?.clientSecret });
  audit(req, 'linkedin.app.save', { entityType: 'connection', entityId: 'LINKEDIN' });
  const app = getLinkedInApp();
  res.json({ data: { configured: !!(app.clientId && app.clientSecret), redirectUri: redirectUri(), source: app.source } });
}));

router.delete('/linkedin/app', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  clearLinkedInApp();
  audit(req, 'linkedin.app.clear', { entityType: 'connection', entityId: 'LINKEDIN' });
  res.json({ ok: true });
}));

// ── Inspect a token before committing to it ──────────────────────────────────
router.post('/linkedin/inspect', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const token = String(req.body?.accessToken || '').trim();
  if (!token) return fail(res, 400, 'VALIDATION', 'accessToken required');

  // A token can be perfectly good for publishing yet unable to name its owner
  // (app has "Share on LinkedIn" but not the OpenID Connect product). Report
  // that as a diagnosis the UI can act on, not as a dead end.
  const meta = await introspect(token);   // first, so a failure can cite real scopes
  let member = null;
  let identityError = null;
  try {
    member = await resolveMember(token);
  } catch (e) {
    if (e.status === 401) throw e;   // genuinely bad token
    identityError = withScopeEvidence(e, meta).message;
  }

  const orgs = await listOrganizations(token);
  const scopes = meta?.scopes || [];
  res.json({
    data: {
      member, organizations: orgs, targets: [member, ...orgs].filter(Boolean),
      scopes, expiresAt: meta?.expiresAt || null, active: meta?.active ?? null,
      canPublish: !scopes.length || scopes.includes('w_member_social') || scopes.includes('w_organization_social'),
      introspected: !!meta,
      identityError,
      needsAuthorUrn: !!identityError && orgs.length === 0,
    },
  });
}));

// ── Connect by pasting an access token (the Shopify-style path) ──────────────
router.post('/linkedin/connect-token', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const tenant = store.get('tenants', req.auth.tenantId);
  const { accessToken, refreshToken, expiresIn, label, authorUrn, connectionId } = req.body || {};
  const bundle = {
    accessToken: String(accessToken || '').trim(),
    refreshToken: refreshToken ? String(refreshToken).trim() : null,
    expiresAt: expiresIn ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString() : null,
  };
  const result = await connectLinkedIn(tenant, bundle, { label, authorUrn, connectionId });
  audit(req, 'linkedin.connect', { entityType: 'connection', entityId: result.connection.id, after: { author: result.connection.externalAccountId } });
  res.status(201).json({ data: { connection: publicConn(result.connection), targets: result.targets, scopes: result.scopes, expiresAt: result.expiresAt } });
}));

// ── Switch which identity a connection posts as (you / a Company Page) ───────
router.put('/linkedin/connections/:id/author', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || conn.platform !== 'LINKEDIN') return fail(res, 404, 'NOT_FOUND', 'Not found');
  let creds = credentialsOf(conn);
  if (!creds.accessToken) return fail(res, 400, 'VALIDATION', 'This connection has no stored token');
  creds = await ensureFreshToken(conn, creds);
  const tenant = store.get('tenants', req.auth.tenantId);
  const result = await connectLinkedIn(tenant, creds, { authorUrn: req.body?.authorUrn, connectionId: conn.id, label: conn.label });
  audit(req, 'linkedin.author.change', { entityType: 'connection', entityId: conn.id, after: { author: req.body?.authorUrn } });
  res.json({ data: publicConn(result.connection) });
}));

// ── Real health check against the LinkedIn API ───────────────────────────────
router.post('/linkedin/connections/:id/test', requireAuth, h(async (req, res) => {
  const conn = store.get('connections', req.params.id);
  if (!conn || conn.tenantId !== req.auth.tenantId || conn.platform !== 'LINKEDIN') return fail(res, 404, 'NOT_FOUND', 'Not found');
  const health = await healthCheckLinkedIn(conn);
  store.update('connections', conn.id, { status: health.status, lastHealthCheckAt: health.at });
  res.json({ data: health });
}));

// ── Read a published post back from LinkedIn ─────────────────────────────────
router.get('/linkedin/posts/:postId/verify', requireAuth, h(async (req, res) => {
  const post = store.get('posts', req.params.postId);
  if (!post || post.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const conn = store.get('connections', post.connectionId);
  if (!conn || conn.platform !== 'LINKEDIN') return fail(res, 400, 'VALIDATION', 'Not a LinkedIn post');
  res.json({ data: await verifyLinkedInPost(conn, post.externalId) });
}));
