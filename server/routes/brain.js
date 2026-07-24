import express from 'express';
import { store } from '../store.js';
import { encryptSecret, keyPreview } from '../crypto.js';
import { requireAuth, requireRole, fail } from '../auth.js';
import { audit } from '../audit.js';
import { syncProviderModels, applyPreset, resolveBinding, run as brainRun, monthToDateSpendUsd, budgetOf } from '../brain/index.js';
import { assemblePrompt } from '../pipeline.js';
import { BrainRole } from '../constants.js';
import { h, pickBody } from './_helpers.js';

export const router = express.Router();

function tenant(req) { return store.get('tenants', req.auth.tenantId); }
function publicProvider(p) {
  return { id: p.id, kind: p.kind, label: p.label, baseUrl: p.baseUrl, isActive: p.isActive, hasKey: !!p.apiKeyEnc, keyPreview: p.keyPreview || '', lastValidatedAt: p.lastValidatedAt, validationError: p.validationError, modelCount: store.count('aiModels', (m) => m.providerId === p.id) };
}

// ── Providers ────────────────────────────────────────────────────────────────
router.get('/providers', requireAuth, h((req, res) => {
  const rows = store.find('aiProviders', (p) => p.tenantId === req.auth.tenantId).map(publicProvider);
  res.json({ data: rows });
}));

router.post('/providers', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { kind, label, apiKey, baseUrl, extraConfig } = req.body || {};
  if (!kind || !label) return fail(res, 400, 'VALIDATION', 'kind and label are required');
  const provider = store.insert('aiProviders', {
    tenantId: req.auth.tenantId, kind, label, baseUrl: baseUrl || null,
    apiKeyEnc: apiKey ? encryptSecret(tenant(req), apiKey) : null,
    keyPreview: apiKey ? keyPreview(apiKey) : '', extraConfig: extraConfig || {}, isActive: true,
  });
  audit(req, 'provider.create', { entityType: 'aiProvider', entityId: provider.id, after: { kind, label } });
  res.status(201).json({ data: publicProvider(provider) });
}));

router.patch('/providers/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const p = store.get('aiProviders', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Provider not found');
  const patch = pickBody(req.body, ['label', 'baseUrl', 'isActive', 'extraConfig']);
  if (req.body.apiKey) { patch.apiKeyEnc = encryptSecret(tenant(req), req.body.apiKey); patch.keyPreview = keyPreview(req.body.apiKey); patch.validationError = null; }
  const updated = store.update('aiProviders', p.id, patch);
  audit(req, 'provider.update', { entityType: 'aiProvider', entityId: p.id });
  res.json({ data: publicProvider(updated) });
}));

router.delete('/providers/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const p = store.get('aiProviders', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Provider not found');
  store.removeWhere('aiModels', (m) => m.providerId === p.id);
  store.remove('aiProviders', p.id);
  audit(req, 'provider.delete', { entityType: 'aiProvider', entityId: p.id });
  res.json({ ok: true });
}));

router.post('/providers/:id/validate', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const p = store.get('aiProviders', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Provider not found');
  const result = await syncProviderModels(req.auth.tenantId, p.id);
  res.json({ data: result });
}));

router.post('/providers/:id/sync', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h(async (req, res) => {
  const p = store.get('aiProviders', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Provider not found');
  const result = await syncProviderModels(req.auth.tenantId, p.id);
  audit(req, 'provider.sync', { entityType: 'aiProvider', entityId: p.id, after: result });
  res.json({ data: result });
}));

// ── Models ────────────────────────────────────────────────────────────────────
router.get('/models', requireAuth, h((req, res) => {
  const providerIds = new Set(store.find('aiProviders', (p) => p.tenantId === req.auth.tenantId).map((p) => p.id));
  let rows = store.find('aiModels', (m) => providerIds.has(m.providerId));
  if (req.query.modality) rows = rows.filter((m) => m.modality === req.query.modality);
  if (req.query.providerId) rows = rows.filter((m) => m.providerId === req.query.providerId);
  if (req.query.available === 'true') rows = rows.filter((m) => m.isAvailable !== false);
  res.json({ data: rows });
}));

router.patch('/models/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const m = store.get('aiModels', req.params.id);
  const provider = m ? store.get('aiProviders', m.providerId) : null;
  if (!m || !provider || provider.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Model not found');
  const updated = store.update('aiModels', m.id, { ...pickBody(req.body, ['inputPricePerM', 'outputPricePerM', 'imagePriceEach', 'capabilities', 'isAvailable']), source: 'manual' });
  res.json({ data: updated });
}));

// ── Profiles + bindings ───────────────────────────────────────────────────────
router.get('/profiles', requireAuth, h((req, res) => {
  const rows = store.find('brainProfiles', (p) => p.tenantId === req.auth.tenantId)
    .map((p) => ({ ...p, bindings: store.find('brainRoleBindings', (b) => b.brainProfileId === p.id) }));
  res.json({ data: rows });
}));

router.post('/profiles', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const { name, preset } = req.body || {};
  if (!name) return fail(res, 400, 'VALIDATION', 'name required');
  const isFirst = store.count('brainProfiles', (p) => p.tenantId === req.auth.tenantId) === 0;
  const profile = store.insert('brainProfiles', { tenantId: req.auth.tenantId, name, isDefault: isFirst });
  if (preset) applyPreset(req.auth.tenantId, profile.id, preset);
  res.status(201).json({ data: { ...profile, bindings: store.find('brainRoleBindings', (b) => b.brainProfileId === profile.id) } });
}));

router.patch('/profiles/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const p = store.get('brainProfiles', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Profile not found');
  if (req.body.preset) applyPreset(req.auth.tenantId, p.id, req.body.preset);
  const updated = store.update('brainProfiles', p.id, pickBody(req.body, ['name', 'description']));
  res.json({ data: updated });
}));

router.post('/profiles/:id/default', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const p = store.get('brainProfiles', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Profile not found');
  store.updateWhere('brainProfiles', (x) => x.tenantId === req.auth.tenantId, { isDefault: false });
  store.update('brainProfiles', p.id, { isDefault: true });
  res.json({ ok: true });
}));

router.get('/profiles/:id/bindings', requireAuth, h((req, res) => {
  const profile = store.get('brainProfiles', req.params.id);
  if (!profile || profile.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Profile not found');
  res.json({ data: store.find('brainRoleBindings', (b) => b.brainProfileId === req.params.id) });
}));

router.put('/profiles/:id/bindings', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const p = store.get('brainProfiles', req.params.id);
  if (!p || p.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Profile not found');
  const bindings = Array.isArray(req.body?.bindings) ? req.body.bindings : [];
  store.removeWhere('brainRoleBindings', (b) => b.brainProfileId === p.id);
  for (const b of bindings) {
    if (!BrainRole.includes(b.role) || !b.modelId) continue;
    store.insert('brainRoleBindings', { brainProfileId: p.id, role: b.role, modelId: b.modelId, fallbackModelId: b.fallbackModelId || null, effort: b.effort || null, temperature: b.temperature ?? null, maxTokens: b.maxTokens ?? null, systemOverride: b.systemOverride || null });
  }
  audit(req, 'brain.bindings.update', { entityType: 'brainProfile', entityId: p.id });
  res.json({ data: store.find('brainRoleBindings', (b) => b.brainProfileId === p.id) });
}));

// ── Playground (doc 03 §8) ─────────────────────────────────────────────────────
router.post('/test', requireAuth, h(async (req, res) => {
  const { role = 'DRAFT', input = '', profileId } = req.body || {};
  const resolved = resolveBinding(req.auth.tenantId, role, profileId);
  const result = await brainRun({
    tenantId: req.auth.tenantId, role, profileId,
    prompt: typeof input === 'string' ? input : JSON.stringify(input),
    system: 'You are the brain playground. Respond helpfully and concisely.',
    simulate: () => `【${role} · ${resolved.model?.displayName || 'simulation'}】\n\nThis is a simulated ${role} response for your input:\n"${String(input).slice(0, 200)}"\n\nAdd a real provider API key in Brain → Providers to route this to a live model.`,
  });
  res.json({
    resolvedModel: resolved.model ? { id: resolved.model.id, modelId: resolved.model.modelId, displayName: resolved.model.displayName, provider: resolved.provider?.label } : null,
    assembledPromptNote: 'The full 10-block prompt is assembled per-connection at generation time (see the pipeline).',
    output: result.text, usage: result.usage, costUsd: result.costUsd, simulated: result.simulated, model: result.model, provider: result.provider,
  });
}));

// ── Usage + budget ─────────────────────────────────────────────────────────────
router.get('/usage', requireAuth, h((req, res) => {
  const rows = store.find('usageLedger', (u) => u.tenantId === req.auth.tenantId);
  const byDay = {}; const byRole = {}; const byModel = {};
  let totalCost = 0, totalIn = 0, totalOut = 0;
  for (const u of rows) {
    const day = (u.createdAt || '').slice(0, 10);
    byDay[day] = (byDay[day] || 0) + Number(u.costUsd || 0);
    if (u.role) byRole[u.role] = (byRole[u.role] || 0) + Number(u.costUsd || 0);
    if (u.modelId) byModel[u.modelId] = (byModel[u.modelId] || 0) + Number(u.costUsd || 0);
    totalCost += Number(u.costUsd || 0); totalIn += u.inputTokens || 0; totalOut += u.outputTokens || 0;
  }
  res.json({ data: { totalCost, totalIn, totalOut, calls: rows.length, monthToDate: monthToDateSpendUsd(req.auth.tenantId), byDay, byRole, byModel } });
}));

router.get('/budget', requireAuth, h((req, res) => {
  const t = tenant(req);
  res.json({ data: { costBudgetUsd: budgetOf(t), monthToDate: monthToDateSpendUsd(req.auth.tenantId) } });
}));

router.put('/budget', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const t = tenant(req);
  const costBudgetUsd = Number(req.body?.costBudgetUsd) || 0;
  store.update('tenants', t.id, { settings: { ...t.settings, costBudgetUsd } });
  audit(req, 'budget.update', { after: { costBudgetUsd } });
  res.json({ data: { costBudgetUsd } });
}));
