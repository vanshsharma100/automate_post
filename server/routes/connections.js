import express from 'express';
import { store } from '../store.js';
import { encryptSecret, signJwt, verifyJwt } from '../crypto.js';
import { config } from '../config.js';
import { requireAuth, requireRole, requireConnectionAccess, visibleConnectionIds, effectivePermissions, fail } from '../auth.js';
import { audit } from '../audit.js';
import { Platform, PLATFORM_META, PLATFORM_CAPS, DEFAULT_CADENCE, OperationMode } from '../constants.js';
import { capabilitiesFor, healthCheck } from '../connectors/index.js';
import { OAUTH, isConfigured, requiredEnv, buildAuthUrl, exchangeCode, listTargets, redirectUri } from '../connectors/oauth.js';
import { connectLinkedIn } from '../linkedin-client.js';
import { connectGoogleBusiness } from '../google-business-client.js';
import { connectMeta } from '../meta-client.js';
import { nextSlotFor } from '../pipeline.js';
import { usageFor, purge } from '../storage.js';
import { h, pickBody } from './_helpers.js';

export const router = express.Router();

function withMeta(c) {
  const schedule = store.findOne('platformSchedules', (s) => s.connectionId === c.id);
  const usage = usageFor(c.id);
  const published = store.count('posts', (p) => p.connectionId === c.id && p.status === 'PUBLISHED');
  return {
    ...c, meta: PLATFORM_META[c.platform],
    schedule: schedule ? { isEnabled: schedule.isEnabled, slots: schedule.slots, nextSlot: nextSlotFor(c.id) } : null,
    storage: { usedBytes: usage.usedBytes, maxBytes: usage.maxBytes, percent: usage.percent },
    publishedCount: published,
    breakerOpen: !!(c.circuitOpenUntil && new Date(c.circuitOpenUntil) > new Date()),
  };
}

// ── Platforms catalogue ────────────────────────────────────────────────────────
router.get('/platforms', requireAuth, h((req, res) => {
  const list = Object.keys(PLATFORM_META).map((p) => ({
    platform: p, ...PLATFORM_META[p], capabilities: PLATFORM_CAPS[p] || null,
    authType: p === 'SHOPIFY_BLOG' ? 'token' : p === 'CUSTOM_WEBHOOK' ? 'config' : 'oauth',
    oauthConfigured: OAUTH[p] ? isConfigured(p) : false,
    requiredEnv: OAUTH[p] ? requiredEnv(p) : [],
    defaultCadence: DEFAULT_CADENCE[p] || null,
  }));
  res.json({ data: list });
}));

// ── Connections ────────────────────────────────────────────────────────────────
router.get('/connections', requireAuth, h((req, res) => {
  const visible = new Set(visibleConnectionIds(req.auth.user));
  const rows = store.find('connections', (c) => c.tenantId === req.auth.tenantId && !c.archivedAt && visible.has(c.id)).map(withMeta);
  // Group by platform for the UI.
  const grouped = {};
  for (const c of rows) { (grouped[c.platform] ||= []).push(c); }
  res.json({ data: rows, grouped });
}));

router.get('/connections/:id', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  res.json({ data: withMeta(req.connection) });
}));

// Token/config-based connect (Shopify + custom webhook). OAuth is simulated below.
router.post('/connections', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { platform, label } = req.body || {};
  if (!Platform.includes(platform)) return fail(res, 400, 'VALIDATION', 'invalid platform');
  if (!label) return fail(res, 400, 'VALIDATION', 'label required');
  const conn = store.insert('connections', {
    tenantId: req.auth.tenantId, platform, label, externalAccountName: req.body.accountName || null,
    status: platform === 'CUSTOM_WEBHOOK' && req.body.config?.url ? 'CONNECTED' : 'PENDING_AUTH',
    mode: 'MANUAL', scopes: [], isActive: true, config: req.body.config || {},
    credentialsEnc: req.body.authHeaderValue ? encryptSecret(store.get('tenants', req.auth.tenantId), JSON.stringify({ authHeaderName: req.body.authHeaderName, authHeaderValue: req.body.authHeaderValue })) : null,
  });
  const cad = DEFAULT_CADENCE[platform] || DEFAULT_CADENCE.CUSTOM_WEBHOOK;
  store.insert('platformSchedules', { connectionId: conn.id, isEnabled: false, timezone: 'Asia/Kolkata', slots: cad.slots, maxPerDay: 2, maxPerWeek: cad.perWeek + 4, minGapMinutes: 180, quietHours: { start: '22:00', end: '07:00' }, categoryRatio: { PRODUCT: 60, KNOWLEDGE: 40 }, autoApproveAbove: 75, leadTimeMinutes: 120 });
  store.insert('platformQuotas', { connectionId: conn.id, maxBytes: 5368709120, usedBytes: 0, retentionDays: 180, purgeStrategy: 'OLDEST_FIRST', keepMetadata: true, keepThumbnails: true, warnAtPercent: 80 });
  audit(req, 'connection.create', { entityType: 'connection', entityId: conn.id, after: { platform, label } });
  res.status(201).json({ data: withMeta(conn) });
}));

// Provision the default schedule + quota for a new connection.
function provisionConnection(conn) {
  const cad = DEFAULT_CADENCE[conn.platform] || DEFAULT_CADENCE.CUSTOM_WEBHOOK;
  store.insert('platformSchedules', { connectionId: conn.id, isEnabled: false, timezone: 'Asia/Kolkata', slots: cad.slots, maxPerDay: 2, maxPerWeek: cad.perWeek + 4, minGapMinutes: 180, quietHours: { start: '22:00', end: '07:00' }, categoryRatio: { PRODUCT: 60, KNOWLEDGE: 40 }, autoApproveAbove: 75, leadTimeMinutes: 120 });
  store.insert('platformQuotas', { connectionId: conn.id, maxBytes: 5368709120, usedBytes: 0, retentionDays: 180, purgeStrategy: 'OLDEST_FIRST', keepMetadata: true, keepThumbnails: true, warnAtPercent: 80 });
}

// Real OAuth start (doc 04 §3). Returns the provider authorize URL, or a precise
// setup message when the app credentials aren't in .env yet.
router.get('/connections/oauth/:platform/start', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { platform } = req.params;
  if (!OAUTH[platform]) return fail(res, 400, 'VALIDATION', 'This platform does not use OAuth');
  if (!isConfigured(platform)) {
    if (platform === 'LINKEDIN') {
      return fail(res, 400, 'NOT_CONFIGURED', `Add your LinkedIn app on the LinkedIn screen — paste an access token, or save your Client ID/Secret there (no .env edit, no restart). Redirect URL to register in your LinkedIn app: ${redirectUri(platform)}`);
    }
    if (platform === 'GOOGLE_BUSINESS') {
      return fail(res, 400, 'NOT_CONFIGURED', `Add your Google app on the Google Business screen — save your OAuth Client ID/Secret there (no .env edit, no restart). Authorized redirect URI to register in Google Cloud Console: ${redirectUri(platform)}`);
    }
    if (platform === 'FACEBOOK' || platform === 'INSTAGRAM') {
      return fail(res, 400, 'NOT_CONFIGURED', `Add your Meta app on the Facebook screen — save your App ID/Secret there (no .env edit, no restart). Valid OAuth redirect URI to register in your Meta app: ${redirectUri(platform)}`);
    }
    return fail(res, 400, 'NOT_CONFIGURED', `Set ${requiredEnv(platform).join(' and ')} in app/.env and restart. Register the redirect URI ${redirectUri(platform)} in your ${PLATFORM_META[platform].label} app, and complete its App Review for the publishing scopes.`);
  }
  const state = signJwt({ t: req.auth.tenantId, u: req.auth.userId, p: platform, label: req.query.label || '' }, { secret: config.jwtAccessSecret, expiresInSec: 600 });
  res.json({ data: { authUrl: buildAuthUrl(platform, state), redirectUri: redirectUri(platform) } });
}));

// OAuth callback — the provider redirects the browser here after consent.
router.get('/connections/oauth/:platform/callback', h(async (req, res) => {
  const { platform } = req.params;
  const { code, state, error } = req.query;
  // Land back on the screen the user started from — a GBP failure shown on the
  // generic Connections page is a failure nobody sees.
  const home = { GOOGLE_BUSINESS: '/googlebusiness', LINKEDIN: '/linkedin', FACEBOOK: '/facebook', INSTAGRAM: '/instagram' }[platform] || '/connections';
  const back = (q) => res.redirect(`${config.webUrl.replace(/\/$/, '')}${home}?${q}`);
  if (error) return back(`oauth_error=${encodeURIComponent(String(error))}`);
  const payload = state ? verifyJwt(String(state), config.jwtAccessSecret) : null;
  if (!payload || payload.p !== platform || !code) return back('oauth_error=invalid_state');
  try {
    const bundle = await exchangeCode(platform, String(code));
    // LinkedIn goes through its own client so the token is validated, the
    // author URN resolved properly, scopes checked and Company Pages listed.
    if (platform === 'LINKEDIN') {
      const tenant = store.get('tenants', payload.t);
      await connectLinkedIn(tenant, bundle, { label: payload.label || undefined });
      return back(`connected=${platform}`);
    }
    if (platform === 'GOOGLE_BUSINESS') {
      const tenant = store.get('tenants', payload.t);
      await connectGoogleBusiness(tenant, bundle, { label: payload.label || undefined });
      return back(`connected=${platform}`);
    }
    if (platform === 'FACEBOOK' || platform === 'INSTAGRAM') {
      const tenant = store.get('tenants', payload.t);
      await connectMeta(tenant, platform, bundle, { label: payload.label || undefined });
      return back(`connected=${platform}`);
    }
    const targets = await listTargets(platform, bundle);
    const target = targets[0] || { id: 'primary', name: 'Authorized account' };
    const tenant = store.get('tenants', payload.t);
    const conn = store.insert('connections', {
      tenantId: payload.t, platform, label: payload.label || `${PLATFORM_META[platform].label} — ${target.name}`,
      externalAccountId: String(target.id), externalAccountName: target.name,
      credentialsEnc: encryptSecret(tenant, JSON.stringify({ ...bundle, target })),
      scopes: OAUTH[platform].scopes, status: 'CONNECTED', mode: 'MANUAL',
      tokenExpiresAt: bundle.expiresAt, isActive: true, config: {},
    });
    provisionConnection(conn);
    return back(`connected=${platform}`);
  } catch (e) {
    // Log it too — a redirect-only failure leaves no trace to debug from.
    console.error(`[oauth:${platform}] callback failed:`, e.message);
    return back(`oauth_error=${encodeURIComponent(e.message)}`);
  }
}));

// Sandbox connection — clearly labelled, for testing the pipeline before your
// real app is approved. Not demo data: you create it deliberately.
router.post('/connections/oauth/:platform/sandbox', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { platform } = req.params;
  if (!Platform.includes(platform)) return fail(res, 400, 'VALIDATION', 'invalid platform');
  const label = req.body?.label || `${PLATFORM_META[platform]?.label} (sandbox)`;
  const conn = store.insert('connections', {
    tenantId: req.auth.tenantId, platform, label, externalAccountName: req.body?.accountName || 'Sandbox account',
    externalAccountId: `sandbox_${Math.random().toString(36).slice(2, 10)}`, status: 'CONNECTED', mode: 'MANUAL',
    scopes: ['sandbox'], isActive: true, config: { sandbox: true }, tokenExpiresAt: new Date(Date.now() + 60 * 864e5).toISOString(),
  });
  provisionConnection(conn);
  audit(req, 'connection.sandbox.create', { entityType: 'connection', entityId: conn.id });
  res.status(201).json({ data: withMeta(conn), note: 'Sandbox connection — publishing is simulated. Connect a live app for real publishing.' });
}));

router.patch('/connections/:id', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  const perms = effectivePermissions(req.auth.user, req.connection.id);
  if (!perms.canEdit && !perms.canManageCreds) return fail(res, 403, 'FORBIDDEN', 'Missing permission');
  const updated = store.update('connections', req.connection.id, pickBody(req.body, ['label', 'config', 'isActive', 'externalAccountName']));
  audit(req, 'connection.update', { entityType: 'connection', entityId: req.connection.id });
  res.json({ data: withMeta(updated) });
}));

router.delete('/connections/:id', requireAuth, requireConnectionAccess('canManageCreds'), h((req, res) => {
  store.update('connections', req.connection.id, { archivedAt: new Date().toISOString(), status: 'DISCONNECTED', credentialsEnc: null });
  audit(req, 'connection.disconnect', { entityType: 'connection', entityId: req.connection.id });
  res.json({ ok: true });
}));

router.post('/connections/:id/test', requireAuth, requireConnectionAccess('canView'), h(async (req, res) => {
  const health = await healthCheck(req.connection);
  store.update('connections', req.connection.id, { status: health.status, lastHealthCheckAt: health.at });
  res.json({ data: health });
}));

router.put('/connections/:id/mode', requireAuth, requireConnectionAccess('canToggleMode'), h((req, res) => {
  const { mode } = req.body || {};
  if (!OperationMode.includes(mode)) return fail(res, 400, 'VALIDATION', 'invalid mode');
  const before = req.connection.mode;
  store.update('connections', req.connection.id, { mode });
  audit(req, 'connection.mode.change', { entityType: 'connection', entityId: req.connection.id, before: { mode: before }, after: { mode } });
  res.json({ data: { mode } });
}));

router.get('/connections/:id/capabilities', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  res.json({ data: capabilitiesFor(req.connection.platform) });
}));

router.post('/connections/:id/breaker/reset', requireAuth, requireConnectionAccess('canManageCreds'), h((req, res) => {
  store.update('connections', req.connection.id, { circuitOpenUntil: null, consecutiveFailures: 0, status: 'CONNECTED' });
  audit(req, 'connection.breaker.reset', { entityType: 'connection', entityId: req.connection.id });
  res.json({ ok: true });
}));

// ── Schedule (requirement 9 — the Save button) ────────────────────────────────
router.get('/connections/:id/schedule', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  res.json({ data: store.findOne('platformSchedules', (s) => s.connectionId === req.connection.id) });
}));

router.put('/connections/:id/schedule', requireAuth, requireConnectionAccess('canEdit'), h((req, res) => {
  const sched = store.findOne('platformSchedules', (s) => s.connectionId === req.connection.id);
  const patch = pickBody(req.body, ['isEnabled', 'timezone', 'slots', 'maxPerDay', 'maxPerWeek', 'minGapMinutes', 'quietHours', 'categoryRatio', 'autoApproveAbove', 'leadTimeMinutes']);
  // Sanitise slots so a malformed entry can never crash nextSlotFor (which runs
  // for every connection in GET /connections and on every scheduler tick).
  if (patch.slots !== undefined) {
    patch.slots = (Array.isArray(patch.slots) ? patch.slots : [])
      .filter((s) => s && Number.isInteger(s.dayOfWeek) && s.dayOfWeek >= 0 && s.dayOfWeek <= 6 && typeof s.time === 'string' && /^\d{1,2}:\d{2}$/.test(s.time))
      .map((s) => ({ dayOfWeek: s.dayOfWeek, time: s.time }));
  }
  const updated = store.update('platformSchedules', sched.id, patch);
  audit(req, 'schedule.save', { entityType: 'connection', entityId: req.connection.id });
  res.json({ data: updated });
}));

// Preview upcoming slots. Pass a `schedule` in the body to preview unsaved
// edits — nothing is persisted either way.
router.post('/connections/:id/schedule/preview', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  let override = null;
  if (req.body?.schedule) {
    const raw = req.body.schedule;
    override = {
      isEnabled: raw.isEnabled !== false,
      slots: (Array.isArray(raw.slots) ? raw.slots : []).filter((s) => s && Number.isInteger(s.dayOfWeek) && s.dayOfWeek >= 0 && s.dayOfWeek <= 6 && typeof s.time === 'string' && /^\d{1,2}:\d{2}$/.test(s.time)),
    };
  }
  const times = [];
  let cursor = new Date();
  for (let i = 0; i < 20; i++) {
    const next = nextSlotFor(req.connection.id, cursor, override);
    if (!next) break;
    times.push(next);
    cursor = new Date(new Date(next).getTime() + 60e3);
  }
  res.json({ data: times });
}));

// ── Quota + purge (requirement 14) ─────────────────────────────────────────────
router.get('/connections/:id/quota', requireAuth, requireConnectionAccess('canView'), h((req, res) => {
  res.json({ data: usageFor(req.connection.id) });
}));

router.put('/connections/:id/quota', requireAuth, requireConnectionAccess('canManageCreds'), h((req, res) => {
  const q = store.findOne('platformQuotas', (x) => x.connectionId === req.connection.id);
  const updated = store.update('platformQuotas', q.id, pickBody(req.body, ['maxBytes', 'maxPosts', 'retentionDays', 'purgeStrategy', 'keepMetadata', 'keepThumbnails', 'warnAtPercent']));
  audit(req, 'quota.update', { entityType: 'connection', entityId: req.connection.id });
  res.json({ data: updated });
}));

router.post('/connections/:id/purge', requireAuth, requireConnectionAccess('canManageCreds'), h((req, res) => {
  const dryRun = req.body?.dryRun !== false;
  const result = purge(req.connection.id, { dryRun, force: !!req.body?.force }, req);
  res.json({ data: result });
}));
