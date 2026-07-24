// Bootstrap (doc 08 §1, doc 09 P0). Production-clean: creates ONLY what a real
// workspace needs to start — the super admin (forced password change), the AI
// provider catalogue (no keys yet — bring your own), a default routing profile,
// a default brand voice, and empty knowledge templates to fill in. No demo
// business, store, products, connections, or posts. Runs once, guarded by a
// tenant_settings flag so redeploys can't resurrect a default account.
import { store } from './store.js';
import { config } from './config.js';
import { generateWrappedDek, hashPassword } from './crypto.js';
import { applyPreset } from './brain/index.js';
import seedModels from './brain/seed-models.json' with { type: 'json' };

export function bootstrap() {
  const done = store.findOne('tenantSettings', (s) => s.key === 'bootstrap_completed');
  if (done) return { alreadyDone: true, tenantId: done.tenantId };

  // ── Tenant (rename in Settings → General) ──────────────────────────────────
  const tenant = store.insert('tenants', {
    name: 'My Workspace', slug: 'workspace',
    dataKeyEncrypted: generateWrappedDek(),
    plan: 'self_hosted', status: 'active',
    settings: { masterSwitch: 'MANUAL', timezone: 'Asia/Kolkata', seoMinScore: 75, costBudgetUsd: 50 },
  });
  const T = tenant.id;

  // ── Super admin (forced password change on first login) ────────────────────
  store.insert('users', {
    tenantId: T, username: config.bootstrap.username, email: config.bootstrap.recoveryEmail,
    recoveryEmail: config.bootstrap.recoveryEmail, passwordHash: hashPassword(config.bootstrap.password),
    mustChangePassword: true, role: 'SUPER_ADMIN', status: 'ACTIVE', mfaEnabled: false,
  });

  // ── AI provider catalogue (no keys — add yours in Brain → Providers) ───────
  // These are the real providers with their real model IDs seeded so routing has
  // a catalogue; each stays in "needs key" state until you add an API key.
  for (const def of [{ kind: 'ANTHROPIC', label: 'Anthropic' }, { kind: 'OPENAI', label: 'OpenAI' }, { kind: 'GOOGLE', label: 'Google AI' }]) {
    const provider = store.insert('aiProviders', {
      tenantId: T, kind: def.kind, label: def.label, apiKeyEnc: null, isActive: true,
      validationError: 'Add your API key to activate this provider.',
    });
    for (const m of (seedModels[def.kind] || [])) {
      store.insert('aiModels', { providerId: provider.id, ...m, isAvailable: true, source: 'seed', lastSyncedAt: new Date().toISOString() });
    }
  }

  // ── Default routing profile ────────────────────────────────────────────────
  const profile = store.insert('brainProfiles', { tenantId: T, name: 'Balanced', description: 'Flagship model for drafting, cheaper models for the rest.', isDefault: true });
  applyPreset(T, profile.id, 'balanced');

  // ── Default brand voice (neutral starting point — tune in Knowledge) ───────
  store.insert('brandVoices', {
    tenantId: T, name: 'Default voice', isDefault: true,
    toneAttributes: ['clear', 'direct', 'helpful'], readingLevel: 8, personPov: 'first_plural',
    bannedPhrases: [], preferredTerms: {}, emojiPolicy: 'sparing',
    ctaStyle: 'helpful, low-pressure', sampleTexts: [],
  });

  // ── Empty knowledge templates to fill in (doc 05 §3) ───────────────────────
  store.insert('knowledgeBases', {
    tenantId: T, scope: 'BRAIN_GLOBAL', title: 'About your business',
    content: 'Describe who you are, what you sell or do, and your mission. This applies to every post on every platform.',
    doRules: ['Use concrete numbers and real specifics', 'Lead with the useful part'],
    dontRules: ['Never open with a rhetorical question', 'Never claim to be “the best”'],
    examples: [], version: 1, isActive: true,
  });
  store.insert('knowledgeBases', {
    tenantId: T, scope: 'PRODUCT_RULES', title: 'Knowledge topic bank',
    content: 'List the subjects you can write about for non-product (knowledge) posts, one per line.',
    doRules: [], dontRules: [], examples: [], version: 1, isActive: true,
  });

  // ── Settings + finish ──────────────────────────────────────────────────────
  store.insert('tenantSettings', { tenantId: T, key: 'master_switch', value: { mode: 'MANUAL' } });
  store.insert('tenantSettings', { tenantId: T, key: 'seo_min_score', value: 75 });
  store.insert('tenantSettings', { tenantId: T, key: 'keyword_provider', value: 'LLM_ESTIMATE' });
  store.insert('tenantSettings', { tenantId: T, key: 'bootstrap_completed', value: true });

  console.log(`[seed] workspace ready — super admin "${config.bootstrap.username}" (must change password on first login). No demo data.`);
  return { tenantId: T };
}
