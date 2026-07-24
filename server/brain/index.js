// The Brain router (doc 03 §6). Resolves role→model→provider, calls the live
// adapter with retry+fallback when a key exists, otherwise runs the caller's
// deterministic simulation. Every call is metered into the usage ledger and
// checked against the tenant's cost budget before the result returns.
import { store } from '../store.js';
import { getAdapter, seedFor } from './adapters.js';
import { BrainRole } from '../constants.js';

function tenantOf(tenantId) {
  return store.get('tenants', tenantId);
}

export function estimateCost(model, usage) {
  if (!model) return 0;
  const inM = Number(model.inputPricePerM || 0);
  const outM = Number(model.outputPricePerM || 0);
  const imgEach = Number(model.imagePriceEach || 0);
  const cost = (usage.inputTokens || 0) / 1e6 * inM
    + (usage.outputTokens || 0) / 1e6 * outM
    + (usage.imageCount || 0) * imgEach;
  return Math.round(cost * 1e6) / 1e6;
}

export function monthToDateSpendUsd(tenantId) {
  const start = new Date();
  start.setDate(1); start.setHours(0, 0, 0, 0);
  const iso = start.toISOString();
  return store.find('usageLedger', (u) => u.tenantId === tenantId && u.createdAt >= iso)
    .reduce((s, u) => s + Number(u.costUsd || 0), 0);
}

export function budgetOf(tenant) {
  const b = tenant?.settings?.costBudgetUsd;
  return (typeof b === 'number' && b > 0) ? b : null;
}

// profile → role → model → provider
export function resolveBinding(tenantId, role, profileId) {
  const profiles = store.find('brainProfiles', (p) => p.tenantId === tenantId);
  const profile = (profileId && profiles.find((p) => p.id === profileId))
    || profiles.find((p) => p.isDefault) || profiles[0];
  let binding = profile
    ? store.findOne('brainRoleBindings', (b) => b.brainProfileId === profile.id && b.role === role)
    : null;

  const modelFor = (id) => (id ? store.get('aiModels', id) : null);
  let model = binding ? modelFor(binding.modelId) : null;

  // Fallback: any available text (or image) model on any provider.
  if (!model) {
    const wantImage = role === 'IMAGE_GEN';
    model = store.find('aiModels', (m) => m.isAvailable !== false
      && (wantImage ? m.modality === 'IMAGE' : m.modality === 'TEXT'))
      .sort((a, b) => tierRank(b) - tierRank(a))[0] || null;
  }
  const provider = model ? store.get('aiProviders', model.providerId) : null;
  return { profile, binding, model, provider };
}

function tierRank(m) {
  const t = m?.capabilities?.tier;
  return t === 'flagship' ? 3 : t === 'mid' ? 2 : t === 'small' ? 1 : 0;
}

// True when the resolved provider for `role` (or its fallback) has a real API
// key — i.e. content for this role will be written by a live model, not faked.
export function hasLiveProvider(tenantId, role) {
  const tenant = tenantOf(tenantId);
  const { provider, binding } = resolveBinding(tenantId, role);
  const check = (p) => { try { return !!p && getAdapter(p, tenant).hasKey; } catch { return false; } };
  if (check(provider)) return true;
  if (binding?.fallbackModelId) {
    const fb = store.get('aiModels', binding.fallbackModelId);
    const fbProv = fb ? store.get('aiProviders', fb.providerId) : null;
    if (check(fbProv)) return true;
  }
  return false;
}

async function withRetry(fn, { retries = 2 } = {}) {
  let lastErr;
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      lastErr = e;
      const retryable = e.status === 429 || (e.status >= 500 && e.status < 600) || e.name === 'AbortError';
      if (!retryable || i === retries) break;
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
  throw lastErr;
}

// Main entry. opts:
//   { tenantId, role, profileId?, system?, prompt?, temperature?, maxTokens?,
//     simulate?: () => string, postId?, runId? }
export async function run(opts) {
  const { tenantId, role } = opts;
  const tenant = tenantOf(tenantId);
  const { model, provider, binding } = resolveBinding(tenantId, role, opts.profileId);

  // Budget gate (doc 03 §6): hard-stop at 100% of the tenant cost budget.
  const budget = budgetOf(tenant);
  if (budget && monthToDateSpendUsd(tenantId) >= budget) {
    const err = new Error('Monthly AI budget exceeded — autopilot paused.');
    err.code = 'BUDGET_EXCEEDED';
    throw err;
  }

  const started = Date.now();
  const live = provider && !!model;
  let result;
  let attemptedLive = false;

  if (live) {
    try {
      const adapter = getAdapter(provider, tenant);
      if (adapter.hasKey) {
        attemptedLive = true;
        const req = {
          model: model.modelId,
          system: opts.system,
          prompt: typeof opts.prompt === 'string' ? opts.prompt : JSON.stringify(opts.prompt),
          temperature: binding?.temperature ?? opts.temperature ?? 0.7,
          maxTokens: binding?.maxTokens ?? opts.maxTokens ?? 2000,
          jsonSchema: opts.expectJson ? {} : undefined,
        };
        const gen = await withRetry(() => adapter.generate(req), { retries: 2 });
        result = {
          text: gen.text, usage: gen.usage, model: gen.model, provider: provider.label,
          simulated: false, latencyMs: Date.now() - started,
        };
      }
    } catch (e) {
      // Failover to the binding's fallback model (if it has its own key).
      if (binding?.fallbackModelId) {
        const fb = store.get('aiModels', binding.fallbackModelId);
        const fbProv = fb ? store.get('aiProviders', fb.providerId) : null;
        if (fb && fbProv) {
          try {
            const adapter = getAdapter(fbProv, tenant);
            if (adapter.hasKey) {
              const gen = await withRetry(() => adapter.generate({
                model: fb.modelId, system: opts.system,
                prompt: typeof opts.prompt === 'string' ? opts.prompt : JSON.stringify(opts.prompt),
              }), { retries: 1 });
              result = { text: gen.text, usage: gen.usage, model: gen.model, provider: fbProv.label, simulated: false, latencyMs: Date.now() - started, usedFallback: true };
            }
          } catch { /* fall through */ }
        }
      }
      // A live attempt that failed surfaces the real error — never fake content.
      if (!result) throw e;
    }
  }

  // Simulation is used ONLY when there was no live key to attempt for this role
  // (e.g. KEYWORD/IDEATION/POLICY, which are real deterministic logic anyway).
  if (!result && !attemptedLive) {
    const text = opts.simulate ? opts.simulate() : `[[deterministic ${role} output]]`;
    const inTok = Math.ceil((String(opts.prompt || '').length) / 4);
    const outTok = Math.ceil(text.length / 4);
    result = {
      text, usage: { inputTokens: inTok, outputTokens: outTok }, model: model?.modelId || '(deterministic)',
      provider: provider?.label || 'Deterministic', simulated: true, latencyMs: Date.now() - started,
    };
  }
  if (!result) { const e = new Error('Generation produced no result'); e.code = 'NO_RESULT'; throw e; }

  const costUsd = result.simulated ? 0 : estimateCost(model, result.usage);
  store.insert('usageLedger', {
    tenantId, providerId: provider?.id || null, modelId: model?.id || null, role,
    postId: opts.postId || null, runId: opts.runId || null,
    inputTokens: result.usage.inputTokens || 0, outputTokens: result.usage.outputTokens || 0,
    imageCount: result.usage.imageCount || 0, costUsd, latencyMs: result.latencyMs,
    success: true, simulated: result.simulated,
  });
  result.costUsd = costUsd;
  return result;
}

// Registry sync (doc 03 §4): validate, list, upsert into aiModels, flag missing.
export async function syncProviderModels(tenantId, providerId) {
  const tenant = tenantOf(tenantId);
  const provider = store.get('aiProviders', providerId);
  if (!provider) throw new Error('provider not found');
  const adapter = getAdapter(provider, tenant);

  const validation = await adapter.validate();
  store.update('aiProviders', providerId, {
    lastValidatedAt: new Date().toISOString(),
    validationError: validation.ok ? null : validation.error,
  });

  let models = [];
  try { models = await adapter.listModels(); }
  catch { models = seedFor(provider.kind); }

  const seenIds = new Set();
  for (const m of models) {
    seenIds.add(m.modelId);
    const existing = store.findOne('aiModels', (x) => x.providerId === providerId && x.modelId === m.modelId);
    const patch = {
      displayName: m.displayName || m.modelId, modality: m.modality || 'TEXT',
      contextWindow: m.contextWindow || null, maxOutput: m.maxOutput || null,
      inputPricePerM: m.inputPricePerM ?? existing?.inputPricePerM ?? null,
      outputPricePerM: m.outputPricePerM ?? existing?.outputPricePerM ?? null,
      imagePriceEach: m.imagePriceEach ?? existing?.imagePriceEach ?? null,
      capabilities: m.capabilities || {}, isAvailable: true,
      source: m.source || 'api', lastSyncedAt: new Date().toISOString(),
    };
    if (existing) store.update('aiModels', existing.id, patch);
    else store.insert('aiModels', { providerId, modelId: m.modelId, ...patch });
  }
  // Models we have but the provider no longer lists → mark unavailable, never delete.
  store.updateWhere('aiModels', (x) => x.providerId === providerId && !seenIds.has(x.modelId), { isAvailable: false });

  return { ok: validation.ok, count: seenIds.size, error: validation.error || null };
}

// Preset presets resolve against the live catalogue (doc 03 §6).
export function applyPreset(tenantId, profileId, preset) {
  const models = store.find('aiModels', (m) => m.isAvailable !== false);
  const providersById = Object.fromEntries(store.find('aiProviders', (p) => p.tenantId === tenantId).map((p) => [p.id, p]));
  const text = models.filter((m) => m.modality === 'TEXT' && providersById[m.providerId]);
  const image = models.filter((m) => m.modality === 'IMAGE' && providersById[m.providerId]);
  const pick = (tier, pool = text) => pool.filter((m) => m.capabilities?.tier === tier)[0] || pool.sort((a, b) => tierRank(b) - tierRank(a))[0];

  const flagship = pick('flagship');
  const mid = pick('mid') || flagship;
  const small = pick('small') || mid;
  const img = image.sort((a, b) => Number(a.imagePriceEach || 0) - Number(b.imagePriceEach || 0));
  const imgBest = img[img.length - 1] || img[0] || null;
  const imgCheap = img[0] || null;

  const map = {
    max: { DRAFT: flagship, HUMANIZE: flagship, IDEATION: flagship, SEO_AUDIT: flagship, KEYWORD: mid, POLICY: mid, IMAGE_PROMPT: mid, VISION_QA: flagship, IMAGE_GEN: imgBest, TRANSLATE: mid, SUMMARIZE: mid },
    balanced: { DRAFT: flagship, HUMANIZE: flagship, IDEATION: mid, SEO_AUDIT: mid, KEYWORD: small, POLICY: small, IMAGE_PROMPT: small, VISION_QA: mid, IMAGE_GEN: imgBest || imgCheap, TRANSLATE: small, SUMMARIZE: small },
    budget: { DRAFT: mid, HUMANIZE: mid, IDEATION: small, SEO_AUDIT: small, KEYWORD: small, POLICY: small, IMAGE_PROMPT: small, VISION_QA: small, IMAGE_GEN: imgCheap, TRANSLATE: small, SUMMARIZE: small },
  }[preset] || {};

  store.removeWhere('brainRoleBindings', (b) => b.brainProfileId === profileId);
  for (const role of BrainRole) {
    const model = map[role];
    if (!model) continue;
    const fallback = model.modality === 'TEXT' ? (text.find((m) => m.id !== model.id) || null) : null;
    store.insert('brainRoleBindings', {
      brainProfileId: profileId, role, modelId: model.id,
      fallbackModelId: fallback?.id || null,
      effort: ['DRAFT', 'HUMANIZE'].includes(role) ? 'high' : 'low',
    });
  }
  return store.find('brainRoleBindings', (b) => b.brainProfileId === profileId);
}
