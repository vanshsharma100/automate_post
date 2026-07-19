'use strict';

/**
 * The Content Brain.
 *
 * Given a platform (and optionally a product), it builds a prompt from your
 * Brand Voice + "Share Knowledge" guidance, then asks Claude to write the post.
 *
 * Two kinds of post:
 *   - product  → promotes one specific product (name, specs, price, link)
 *   - general  → NO product push; the AI writes helpful/value content relevant
 *                to the business (tips, buying guides, industry insight). Use it
 *                where you don't want to sell directly (e.g. LinkedIn).
 *
 * SECURITY: every provider API key (Claude / OpenAI / Gemini) is decrypted here,
 * server-side, only at call time. Keys are NEVER returned to the caller, logged,
 * or sent to the browser. With no key configured, a local template generator
 * produces a realistic preview so the system is usable before keys are added.
 */

const fs = require('fs');
const path = require('path');
const store = require('./store');
const config = require('./config');
const { decrypt } = require('./crypto');
const { PLATFORM_MAP } = require('./platforms');
const { providerLabel, IMAGE_MODELS } = require('./brain');

// Kept as PLATFORM_META for backwards compatibility with existing callers/views.
const PLATFORM_META = PLATFORM_MAP;

function inr(n) {
  return '₹' + Number(n).toLocaleString('en-IN');
}

function isGeneral(postType) {
  return postType === 'general';
}

/**
 * Builds the prompt by LAYERING knowledge:
 *   1. shared knowledge   — applies to every platform
 *   2. platform knowledge — extra rules for this platform only (wins on conflict)
 *   3. account note       — optional, for one specific account
 * `postType` decides whether we write a product promo or general value content.
 */
function buildPrompt(product, platformKey, account, postType = 'product') {
  const s = store.get();
  const shared = (s.knowledge && s.knowledge.shared) || {};
  const plat = ((s.knowledge && s.knowledge.platforms) || {})[platformKey] || {};
  const brand = s.settings.brand;
  const p = PLATFORM_META[platformKey];
  const general = isGeneral(postType);

  let system =
    `You are the social media copywriter for ${brand.name} (${brand.website}), a computer shop in ${brand.city}. ` +
    `Brand voice: ${shared.brandVoice || ''}\n` +
    `Rules: ${shared.instructions || ''}\n` +
    `DO: ${shared.dos || ''}\nDON'T: ${shared.donts || ''}\n`;

  // Platform-specific layer.
  const platBits = [];
  if (plat.instructions) platBits.push(`Rules: ${plat.instructions}`);
  if (plat.dos) platBits.push(`DO: ${plat.dos}`);
  if (plat.donts) platBits.push(`DON'T: ${plat.donts}`);
  if (platBits.length) {
    system +=
      `\nThese ${p.label}-specific rules are ADDITIONAL and take priority over the general rules above:\n` +
      platBits.join('\n') + '\n';
  }

  // Per-account layer.
  if (account && account.note) {
    system += `\nThis post is for the account "${account.label}". Account-specific guidance: ${account.note}\n`;
  }

  if (general) {
    system +=
      `\nThis is a NON-PROMOTIONAL post. Do NOT push a specific product, price or "buy now" pitch. ` +
      `Instead write genuinely useful, engaging content relevant to our field (computers, laptops, ` +
      `mini PCs, refurbished tech, IT for small business) — for example a practical tip, a short buying ` +
      `guide, a myth-buster, a maintenance reminder, or an industry insight. You may mention ${brand.name} ` +
      `naturally at the end, but the value comes first.\n`;
  }

  if (p.kind === 'blog') {
    system +=
      `\nWrite a ${p.label} article. Tone/format: ${p.style} Keep it under ${p.maxChars} characters. ` +
      `Begin with the article title on the very first line, then a blank line, then the article body. ` +
      `Return ONLY the title and body, ready to publish.`;
  } else {
    system +=
      `\nWrite for ${p.label}. Tone/format: ${p.style} Keep under ${p.maxChars} characters. ` +
      `Return ONLY the post text, ready to publish.`;
  }

  // Examples: platform examples first (more specific), then shared.
  const examples = []
    .concat(plat.examples || [], shared.examples || [])
    .filter(Boolean)
    .slice(0, 4);
  const exampleBlock = examples.length
    ? `\nHere are examples of posts we like (match this style):\n- ${examples.join('\n- ')}\n`
    : '';

  let user;
  if (general) {
    user =
      `Write one ${p.label} ${p.kind === 'blog' ? 'article' : 'post'} of helpful, non-promotional ` +
      `content for ${brand.name}. Pick a fresh, specific angle our customers would find useful.\n` +
      exampleBlock;
  } else {
    user =
      `Write one ${p.label} ${p.kind === 'blog' ? 'article' : 'post'} for this product:\n` +
      `Product: ${product.title}\n` +
      `Price: ${inr(product.price)}\n` +
      `Key tags: ${(product.tags || []).join(', ')}\n` +
      `Product link: ${product.url}\n` +
      exampleBlock;
  }

  return { system, user };
}

/* --------------------- Local fallback (no key yet) -------------------- */

function templateProductPost(product, platformKey) {
  const s = store.get();
  const brand = s.settings.brand;
  const price = inr(product.price);
  const t = product.shortTitle || product.title;
  const specs = (product.tags || []).slice(0, 4).join(' • ');

  switch (platformKey) {
    case 'gmb':
      return `New arrival at ${brand.name}: ${t} — just ${price}. ${specs}. Reliable performance at a great price. Visit us or shop at ${brand.website}. 📞 Call to reserve yours.`;
    case 'linkedin':
      return `Dependable hardware shouldn't cost a fortune. The ${t} (${specs}) delivers real value at ${price} — a smart pick for teams and professionals. Available now at ${brand.name}. ${brand.website}`;
    case 'ig':
      return `Work mode: on ⚡💻\n${t}\n${specs}\nOnly ${price}.\n🔗 Link in bio · ${brand.website}\n#laptopdeals #ftech #computershop #${(product.vendor || 'pc').toLowerCase()} #techdeals`;
    case 'blog':
      return `${t}: A Smart, Affordable Choice\n\nLooking for reliable computing without overspending? The ${t} is worth a close look.\n\nWhat you get\n${(product.tags || []).map((x) => `• ${x}`).join('\n')}\n\nWhy it makes sense\nAt ${price}, the ${t} balances performance and value — ideal for everyday work, study and small-business use. Every unit from ${brand.name} is checked and ready to go.\n\nReady to buy?\nSee full details and order at ${product.url}, or visit ${brand.name}.`;
    case 'fb':
    default:
      return `💻 ${t}\n${specs}\nNow only ${price} at ${brand.name}!\n🛒 Shop now → ${brand.website}\n#ftech #laptopdeals #${(product.vendor || 'pc').toLowerCase()}`;
  }
}

function templateGeneralPost(platformKey) {
  const s = store.get();
  const brand = s.settings.brand;

  switch (platformKey) {
    case 'gmb':
      return `Tech tip from ${brand.name}: a refurbished laptop or mini PC can save you a lot without giving up everyday performance — great for work, study and browsing. Not sure what fits your needs? Pop into the shop and we'll help you choose.`;
    case 'linkedin':
      return `Refurbished computers are an underrated win for small businesses: lower cost, less e-waste, and plenty of performance for real-world work. The key is buying from someone who tests every unit and stands behind it. That's the standard we hold ourselves to at ${brand.name}.`;
    case 'ig':
      return `💡 Quick tip: restarting your PC once a day clears memory and keeps it snappy.\nMore simple tech tips coming soon 👀\n${brand.website}\n#techtips #computertips #ftech #smallbusiness`;
    case 'blog':
      return `5 Simple Habits That Keep Your Computer Fast\n\nA slow computer is usually fixable — no new hardware required. Here are five habits that make a real difference.\n\n1. Restart regularly\nA daily restart clears memory and closes stuck processes.\n\n2. Keep some free disk space\nAim to keep at least 10–15% of your drive free so the system can breathe.\n\n3. Trim startup apps\nFewer programs launching at boot means a faster start.\n\n4. Update — but on your schedule\nInstall updates weekly rather than ignoring them for months.\n\n5. Clean the dust\nGood airflow prevents overheating and slowdowns.\n\nNeed a hand — or a machine that's fast from day one? ${brand.name} is here to help.`;
    case 'fb':
    default:
      return `💡 Friendly tip: if your PC feels slow, try a restart and clear a little disk space before buying anything new — it often does the trick!\nQuestions about your setup? Message us anytime. — ${brand.name}\n${brand.website}`;
  }
}

function templatePost(product, platformKey, postType) {
  if (isGeneral(postType) || !product) return templateGeneralPost(platformKey);
  return templateProductPost(product, platformKey);
}

/* ----------------------- Text: provider dispatch --------------------- */

// Low-level call to ONE provider. Returns the finished text, or throws.
// Adding a provider = add a `case` here + an entry in src/brain.js.
async function callProvider(providerKey, model, key, system, user, maxTokens) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    if (providerKey === 'claude') {
      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error('http ' + resp.status);
      const data = await resp.json();
      return (data.content || []).map((c) => c.text || '').join('').trim();
    }

    if (providerKey === 'openai') {
      // GPT-5.6 uses the Responses API. `instructions` is the system prompt,
      // `input` is the user prompt. Give generous output room since reasoning
      // models spend part of the budget thinking before the visible text.
      const resp = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
        body: JSON.stringify({
          model,
          instructions: system,
          input: user,
          max_output_tokens: Math.max(maxTokens * 3, 2000),
        }),
        signal: ctrl.signal,
      });
      if (!resp.ok) throw new Error('http ' + resp.status);
      const data = await resp.json();
      // Prefer the convenience field; otherwise pull text out of the output array.
      if (typeof data.output_text === 'string' && data.output_text.trim()) return data.output_text.trim();
      const parts = (data.output || []).flatMap((item) => item.content || []);
      return parts.map((c) => c.text || '').join('').trim();
    }

    if (providerKey === 'gemini') {
      const resp = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: system }] },
            contents: [{ parts: [{ text: user }] }],
          }),
          signal: ctrl.signal,
        }
      );
      if (!resp.ok) throw new Error('http ' + resp.status);
      const data = await resp.json();
      const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
      return parts.map((pt) => pt.text || '').join('').trim();
    }

    throw new Error('unknown provider ' + providerKey);
  } finally {
    clearTimeout(timer);
  }
}

// Picks the ACTIVE brain provider and writes the post. Falls back to the free
// built-in template writer whenever the provider is off, keyless, or unreachable.
async function callBrain(product, platformKey, account, postType) {
  const s = store.get();
  const brain = s.settings.brain || {};
  const providerKey = brain.active || 'claude';
  const cfg = (brain.providers || {})[providerKey] || {};
  const label = providerLabel(providerKey);

  if (!cfg.enabled) {
    return { text: templatePost(product, platformKey, postType), engine: 'template', note: `${label} is switched OFF — used the free template writer.` };
  }
  const key = decrypt(cfg.apiKey || '');
  if (!key) {
    return { text: templatePost(product, platformKey, postType), engine: 'template', note: `No ${label} key saved yet — used the free template writer.` };
  }

  const p = PLATFORM_META[platformKey];
  const maxTokens = p && p.kind === 'blog' ? 2000 : 600;
  const { system, user } = buildPrompt(product, platformKey, account, postType);

  try {
    const text = await callProvider(providerKey, cfg.model, key, system, user, maxTokens);
    return { text: text || templatePost(product, platformKey, postType), engine: providerKey };
  } catch (_) {
    // Never leak the key or request body in errors.
    return { text: templatePost(product, platformKey, postType), engine: 'template', note: `Could not reach ${label}; showing a template preview instead.` };
  }
}

/* ------------------------- Image generation -------------------------- */

function imagePrompt(product) {
  const brand = store.get().settings.brand;
  const subject = product
    ? `${product.shortTitle || product.title} on a clean modern desk`
    : `a clean modern desk with a laptop and mini PC in a bright tech shop`;
  return (
    `Professional social media marketing photo: ${subject}, soft studio lighting, ` +
    `subtle accents in ${brand.colorPrimary}, photorealistic, high quality. ` +
    `No text, no words, no logos, no watermark.`
  );
}

// Saves raw image bytes into the persistent uploads dir and returns its URL.
function saveGeneratedImage(base64, mime) {
  const dir = path.join(config.dataDir, 'generated');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const ext = (mime || 'image/png').includes('jpeg') ? 'jpg' : 'png';
  const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
  fs.writeFileSync(path.join(dir, name), Buffer.from(base64, 'base64'));
  return '/media/generated/' + name;
}

async function geminiImage(key, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 45000);
  try {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODELS.gemini}:generateContent`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
        signal: ctrl.signal,
      }
    );
    if (!resp.ok) throw new Error('http ' + resp.status);
    const data = await resp.json();
    const parts = (((data.candidates || [])[0] || {}).content || {}).parts || [];
    const img = parts.find((pt) => pt.inlineData && pt.inlineData.data);
    if (!img) throw new Error('no image');
    return saveGeneratedImage(img.inlineData.data, img.inlineData.mimeType);
  } finally {
    clearTimeout(timer);
  }
}

async function openaiImage(key, prompt) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch('https://api.openai.com/v1/images/generations', {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: IMAGE_MODELS.openai, prompt, size: '1024x1024', n: 1 }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error('http ' + resp.status);
    const data = await resp.json();
    const first = (data.data || [])[0] || {};
    if (!first.b64_json) throw new Error('no image');
    return saveGeneratedImage(first.b64_json, 'image/png');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Generates a marketing image with the chosen provider (Gemini or OpenAI) when
 * image generation is switched ON and that provider has a key. Otherwise — or on
 * any failure — it falls back to the REAL product photo when we have a product,
 * or no image for general posts, so nothing ever breaks.
 */
async function generateImage(product) {
  const s = store.get();
  const brain = s.settings.brain || {};
  const imgCfg = brain.image || {};
  const fallback = product && product.image ? product.image : '';
  const fallbackEngine = product && product.image ? 'product-photo' : 'none';

  if (!imgCfg.enabled) {
    return { url: fallback, imageEngine: fallbackEngine };
  }
  const providerKey = imgCfg.provider === 'openai' ? 'openai' : 'gemini';
  const label = providerLabel(providerKey);
  const cfg = (brain.providers || {})[providerKey] || {};
  const key = decrypt(cfg.apiKey || '');
  if (!key) {
    return {
      url: fallback,
      imageEngine: fallbackEngine,
      imageNote: `${label} image is ON but no ${label} key is saved — used ` + (fallback ? 'the real product photo.' : 'no image.'),
    };
  }

  try {
    const prompt = imagePrompt(product);
    const url = providerKey === 'openai' ? await openaiImage(key, prompt) : await geminiImage(key, prompt);
    return { url, imageEngine: providerKey };
  } catch (_) {
    return {
      url: fallback,
      imageEngine: fallbackEngine,
      imageNote: `Could not generate a ${label} image — used ` + (fallback ? 'the real product photo' : 'no image') + ' instead.',
    };
  }
}

async function generate(product, platformKey, account, opts = {}) {
  const postType = isGeneral(opts.postType) ? 'general' : 'product';
  const useProduct = postType === 'general' ? null : product;

  const result = await callBrain(useProduct, platformKey, account, postType);
  const img = await generateImage(useProduct);
  const p = PLATFORM_META[platformKey];
  return {
    platform: platformKey,
    platformLabel: p ? p.label : platformKey,
    postType,
    accountId: account ? account.id : null,
    accountLabel: account ? account.label : null,
    productId: useProduct ? useProduct.id : null,
    productTitle: useProduct
      ? useProduct.shortTitle || useProduct.title
      : (p && p.kind === 'blog' ? 'General article' : 'General post'),
    text: result.text,
    engine: result.engine,
    engineLabel: result.engine === 'template' ? 'template' : providerLabel(result.engine),
    note: result.note || null,
    image: img.url,
    imageEngine: img.imageEngine,
    imageLabel: ['gemini', 'openai'].includes(img.imageEngine) ? providerLabel(img.imageEngine) : null,
    imageNote: img.imageNote || null,
    createdAt: new Date().toISOString(),
  };
}

module.exports = { generate, generateImage, buildPrompt, PLATFORM_META };
