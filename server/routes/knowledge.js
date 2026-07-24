import express from 'express';
import { store } from '../store.js';
import { requireAuth, requireRole, fail } from '../auth.js';
import { audit } from '../audit.js';
import { KnowledgeScope, Platform, PLATFORM_META } from '../constants.js';
import { h, pickBody } from './_helpers.js';

export const router = express.Router();

// Starter content for a new per-platform section — a real first draft that
// encodes each platform's actual constraints, not an empty box.
const PLATFORM_KNOWLEDGE_SEED = {
  SHOPIFY_BLOG: {
    title: 'Shopify blog rules',
    content: 'Long-form, indexed, commercial intent. 900–1600 words, markdown, inline links.\n\nStructure: open on the reader\'s problem in 1–2 sentences; H2 sections that each answer one real buyer question; a comparison table whenever two or more options are in play; close with a plain recommendation including who should NOT buy.\n\nUse only the injected product facts for price, specs, vendor and URL. Link the product by its real onlineStoreUrl on first mention.',
    doRules: ['Include a comparison table when options are compared', 'Link the product with its real onlineStoreUrl on first mention', 'State who should not buy it', 'Keep the title under 60 characters'],
    dontRules: ['Never state a spec absent from the supplied product data', 'Never repeat the primary keyword for density', 'Never open with "in this article" or a rhetorical question'],
  },
  LINKEDIN: {
    title: 'LinkedIn rules',
    content: 'Short-form, first person, plain text (no markdown). 180–350 words, short paragraphs with line breaks between them.\n\nThe first two lines must earn the "see more" click — put the specific detail there, never the setup. One concrete thing per post: something learned, built, broken, or measured.\n\nLinks suppress reach: put any link in the first comment and make the post stand alone without it.',
    doRules: ['Put the specific detail in the first two lines', 'Name real tools, models and version numbers', 'Use exactly 3–4 specific hashtags at the end'],
    dontRules: ['Never write a listicle or predict the industry\'s future', 'Never use the one-line-paragraph broetry cadence', 'Never end with engagement bait like "Agree?"', 'Never open with a rhetorical question'],
  },
  GOOGLE_BUSINESS: {
    title: 'Google Business rules',
    content: 'Very short, local, action-oriented. Hard limit 1500 characters — aim for 40–120 words.\n\nThis is a storefront noticeboard, not a blog. One offer, update, or piece of practical news per post. Lead with what is on offer and what it costs. Include the concrete local detail: hours, address, turnaround time, price.\n\nHashtags do nothing here and are stripped automatically. Every post should carry a call-to-action button URL.',
    doRules: ['Lead with the offer and its price', 'Include a concrete local detail (hours, turnaround, address)', 'Set a call-to-action URL on every post'],
    dontRules: ['Never use hashtags — they are inert here', 'Never exceed 1500 characters', 'Never write blog-style intros; start with the offer'],
  },
  INSTAGRAM: {
    title: 'Instagram rules',
    content: 'Caption-first, visual-led. 40–150 words. Links are not clickable, so the CTA reads "link in bio".\n\nThe first line is the hook and must work alone in the feed preview. Write the caption to the image that actually exists, never to a generic one.',
    doRules: ['Make the first line work as a standalone hook', 'Write to the actual image', 'Use 8 or fewer specific hashtags'],
    dontRules: ['Never put a bare URL in the caption', 'Never write a caption that ignores the image'],
  },
  FACEBOOK: {
    title: 'Facebook rules',
    content: 'Conversational, 40–120 words, links are clickable and previewed. One idea per post. Lead with the useful part; the preview card carries the rest.',
    doRules: ['Lead with the useful part', 'Keep it to one idea'],
    dontRules: ['Never use more than 2 hashtags', 'Never open with a rhetorical question'],
  },
  CUSTOM_WEBHOOK: {
    title: 'Webhook rules',
    content: 'Payload is rendered from your template. Keep the body plain and short — the receiving system decides the formatting.',
    doRules: [], dontRules: [],
  },
};

// ── Knowledge bases (4 scopes, versioned) ────────────────────────────────────
router.get('/knowledge', requireAuth, h((req, res) => {
  let rows = store.find('knowledgeBases', (k) => k.tenantId === req.auth.tenantId);
  if (req.query.scope) rows = rows.filter((k) => k.scope === req.query.scope);
  if (req.query.platform) rows = rows.filter((k) => k.platform === req.query.platform);
  if (req.query.connectionId) rows = rows.filter((k) => k.connectionId === req.query.connectionId);
  res.json({ data: rows });
}));

router.post('/knowledge', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'EDITOR'), h((req, res) => {
  const { scope, title, content } = req.body || {};
  if (!KnowledgeScope.includes(scope)) return fail(res, 400, 'VALIDATION', 'invalid scope');
  if (!title) return fail(res, 400, 'VALIDATION', 'title required');
  const kb = store.insert('knowledgeBases', {
    tenantId: req.auth.tenantId, scope, platform: req.body.platform || null, connectionId: req.body.connectionId || null,
    title, content: content || '', doRules: req.body.doRules || [], dontRules: req.body.dontRules || [],
    examples: req.body.examples || [], version: 1, isActive: true, updatedById: req.auth.userId,
  });
  audit(req, 'knowledge.create', { entityType: 'knowledgeBase', entityId: kb.id });
  res.status(201).json({ data: kb });
}));

// Every platform gets its own knowledge section. This creates the one for
// `platform` if it doesn't exist yet, or returns the existing one — so the UI
// can offer "add a section for X" without ever creating duplicates.
router.post('/knowledge/platform/:platform', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'EDITOR'), h((req, res) => {
  const { platform } = req.params;
  if (!Platform.includes(platform)) return fail(res, 400, 'VALIDATION', 'invalid platform');
  const existing = store.findOne('knowledgeBases', (k) => k.tenantId === req.auth.tenantId && k.scope === 'PLATFORM' && k.platform === platform);
  if (existing) return res.json({ data: existing, created: false });
  const seed = PLATFORM_KNOWLEDGE_SEED[platform] || {};
  const kb = store.insert('knowledgeBases', {
    tenantId: req.auth.tenantId, scope: 'PLATFORM', platform, connectionId: null,
    title: seed.title || `${PLATFORM_META[platform].label} rules`,
    content: seed.content || `How to write natively for ${PLATFORM_META[platform].label}.`,
    doRules: seed.doRules || [], dontRules: seed.dontRules || [], examples: [],
    version: 1, isActive: true, updatedById: req.auth.userId,
  });
  audit(req, 'knowledge.platform.create', { entityType: 'knowledgeBase', entityId: kb.id, after: { platform } });
  res.status(201).json({ data: kb, created: true });
}));

router.get('/knowledge/:id', requireAuth, h((req, res) => {
  const kb = store.get('knowledgeBases', req.params.id);
  if (!kb || kb.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  res.json({ data: kb });
}));

// PATCH bumps version and keeps history (doc 05 §3).
router.patch('/knowledge/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'EDITOR'), h((req, res) => {
  const kb = store.get('knowledgeBases', req.params.id);
  if (!kb || kb.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  store.insert('knowledgeVersions', { knowledgeId: kb.id, version: kb.version, snapshot: kb, at: new Date().toISOString() });
  const patch = pickBody(req.body, ['title', 'content', 'doRules', 'dontRules', 'examples', 'isActive']);
  const updated = store.update('knowledgeBases', kb.id, { ...patch, version: (kb.version || 1) + 1, updatedById: req.auth.userId });
  audit(req, 'knowledge.update', { entityType: 'knowledgeBase', entityId: kb.id });
  res.json({ data: updated });
}));

router.delete('/knowledge/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const kb = store.get('knowledgeBases', req.params.id);
  if (!kb || kb.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  store.remove('knowledgeBases', kb.id);
  res.json({ ok: true });
}));

router.get('/knowledge/:id/versions', requireAuth, h((req, res) => {
  const kb = store.get('knowledgeBases', req.params.id);
  if (!kb || kb.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  res.json({ data: store.find('knowledgeVersions', (v) => v.knowledgeId === req.params.id) });
}));

router.post('/knowledge/:id/revert/:version', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'EDITOR'), h((req, res) => {
  const kb = store.get('knowledgeBases', req.params.id);
  if (!kb || kb.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const v = store.findOne('knowledgeVersions', (x) => x.knowledgeId === kb.id && x.version === Number(req.params.version));
  if (!v) return fail(res, 404, 'NOT_FOUND', 'Version not found');
  const s = v.snapshot;
  const updated = store.update('knowledgeBases', kb.id, { title: s.title, content: s.content, doRules: s.doRules, dontRules: s.dontRules, examples: s.examples, version: (kb.version || 1) + 1 });
  res.json({ data: updated });
}));

// ── Brand voices ──────────────────────────────────────────────────────────────
router.get('/brand-voices', requireAuth, h((req, res) => {
  res.json({ data: store.find('brandVoices', (b) => b.tenantId === req.auth.tenantId) });
}));

router.post('/brand-voices', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'EDITOR'), h((req, res) => {
  const { name } = req.body || {};
  if (!name) return fail(res, 400, 'VALIDATION', 'name required');
  const isFirst = store.count('brandVoices', (b) => b.tenantId === req.auth.tenantId) === 0;
  const bv = store.insert('brandVoices', {
    tenantId: req.auth.tenantId, name, isDefault: isFirst,
    toneAttributes: req.body.toneAttributes || [], readingLevel: req.body.readingLevel || 8,
    personPov: req.body.personPov || 'first_plural', bannedPhrases: req.body.bannedPhrases || [],
    preferredTerms: req.body.preferredTerms || {}, emojiPolicy: req.body.emojiPolicy || 'sparing',
    ctaStyle: req.body.ctaStyle || null, sampleTexts: req.body.sampleTexts || [],
  });
  res.status(201).json({ data: bv });
}));

router.patch('/brand-voices/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN', 'EDITOR'), h((req, res) => {
  const bv = store.get('brandVoices', req.params.id);
  if (!bv || bv.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  const updated = store.update('brandVoices', bv.id, pickBody(req.body, ['name', 'toneAttributes', 'readingLevel', 'personPov', 'bannedPhrases', 'preferredTerms', 'emojiPolicy', 'ctaStyle', 'sampleTexts']));
  res.json({ data: updated });
}));

router.delete('/brand-voices/:id', requireAuth, requireRole('SUPER_ADMIN', 'ADMIN'), h((req, res) => {
  const bv = store.get('brandVoices', req.params.id);
  if (!bv || bv.tenantId !== req.auth.tenantId) return fail(res, 404, 'NOT_FOUND', 'Not found');
  store.remove('brandVoices', bv.id);
  res.json({ ok: true });
}));

// Analyze sample texts → inferred tone (deterministic heuristic stand-in).
router.post('/brand-voices/:id/analyze', requireAuth, h((req, res) => {
  const samples = (req.body?.sampleTexts || []).join(' ');
  const words = samples.toLowerCase().split(/\s+/).filter(Boolean);
  const avgLen = words.length ? words.reduce((s, w) => s + w.length, 0) / words.length : 5;
  const tone = [];
  if (avgLen < 5) tone.push('direct'); else tone.push('considered');
  if (/we|our|us/.test(samples)) tone.push('first-person-plural');
  if (/fix|spec|gb|ssd|network/i.test(samples)) tone.push('technical');
  res.json({ data: { toneAttributes: tone, readingLevel: Math.min(12, Math.max(6, Math.round(avgLen + 3))), note: 'Heuristic analysis; a live model refines this.' } });
}));
