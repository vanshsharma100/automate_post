// Content pipeline (doc 05). Eight stages: IDEATE → KEYWORD → DRAFT → IMAGE →
// HUMANIZE → SEO → POLICY → PERSIST. Each stage writes to AutomationRun.stageHistory
// so the composer/History can show exactly where a run is (or where it failed).
//
// When a live LLM is configured the DRAFT/HUMANIZE stages call it; otherwise the
// deterministic composer below produces platform-native content from the same
// assembled context, so the pipeline is fully functional offline.
import { store } from './store.js';
import { cuid } from './crypto.js';
import { run as brainRun, hasLiveProvider } from './brain/index.js';
import { scoreSeo } from './seo.js';
import { bannedList, stripBannedPhrases, applyPreferredTerms, humanScore, humanizeGuidance, measureBurstiness } from './humanizer.js';
import { PLATFORM_META, PLATFORM_CAPS, IMAGE_PRESETS } from './constants.js';
import { emit } from './events.js';

const STAGES = ['IDEATE', 'KEYWORD', 'DRAFT', 'IMAGE', 'HUMANIZE', 'SEO', 'POLICY', 'PERSIST'];

function pick(arr, seed = Math.floor(Math.random() * arr.length)) {
  return arr[((seed % arr.length) + arr.length) % arr.length];
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function slugify(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9\s-]/g, '').trim().replace(/\s+/g, '-').split('-').slice(0, 5).join('-');
}
function titleCase(s) {
  return String(s).replace(/\b\w/g, (c) => c.toUpperCase());
}
// Build an SEO title that is keyword-front and lands in the 50–60 char sweet spot.
function fitTitle(primary) {
  const base = titleCase(primary);
  let t = `${base}: the practical buyer’s guide`;       // keyword front
  const fillers = [' for 2026', ' and honest advice', ' you can trust', ' from the workshop'];
  let i = 0;
  while (t.length < 50 && i < fillers.length) t += fillers[i++];
  if (t.length > 60) t = t.slice(0, 60).replace(/\s+\S*$/, '');
  return t;
}

// ── Knowledge helpers ────────────────────────────────────────────────────────
function knowledgeFor(tenantId, connection) {
  const kbs = store.find('knowledgeBases', (k) => k.tenantId === tenantId && k.isActive !== false);
  return {
    global: kbs.find((k) => k.scope === 'BRAIN_GLOBAL'),
    platform: kbs.find((k) => k.scope === 'PLATFORM' && k.platform === connection.platform),
    connection: kbs.find((k) => k.scope === 'CONNECTION' && k.connectionId === connection.id),
    topicBank: kbs.find((k) => k.scope === 'PRODUCT_RULES'),
  };
}
// Render a knowledge base into the prompt. The Do / Never / Examples lists are
// first-class instructions, not decoration — before this, only `content` was
// ever sent, so every rule typed into those UI fields was silently discarded.
function renderKnowledge(kb) {
  if (!kb) return null;
  const parts = [];
  if (kb.content?.trim()) parts.push(kb.content.trim());
  const dos = (kb.doRules || []).map((s) => String(s).trim()).filter(Boolean);
  const donts = (kb.dontRules || []).map((s) => String(s).trim()).filter(Boolean);
  const ex = (kb.examples || []).map((s) => String(s).trim()).filter(Boolean);
  if (dos.length) parts.push(`ALWAYS:\n${dos.map((r) => `- ${r}`).join('\n')}`);
  if (donts.length) parts.push(`NEVER (hard rules — violating any of these fails the post):\n${donts.map((r) => `- ${r}`).join('\n')}`);
  if (ex.length) parts.push(`EXAMPLES of the target style:\n${ex.map((e, i) => `${i + 1}. ${e}`).join('\n')}`);
  return parts.length ? parts.join('\n\n') : null;
}

function brandVoiceFor(tenantId) {
  const bvs = store.find('brandVoices', (b) => b.tenantId === tenantId);
  return bvs.find((b) => b.isDefault) || bvs[0] || null;
}

// ── Stage 1 — Ideation ───────────────────────────────────────────────────────
const KNOWLEDGE_TOPICS = [
  'WordPress performance tuning', 'eCommerce security basics', 'choosing web hosting',
  'core web vitals', 'SSD vs HDD for creative work', 'setting up a home office network',
  'Windows 11 troubleshooting', 'protecting a small business from ransomware',
  'why your website loads slowly', 'backups that actually restore',
  'picking a laptop for design work', 'understanding DNS in plain English',
];
const ANGLES = ['a practical walkthrough', 'the mistake most people make', 'what we tell our own customers', 'a before/after story', 'the 5-minute version', 'what changed this year'];

export function ideate(tenantId, connection, category) {
  const recentTitles = store.find('posts', (p) => p.connectionId === connection.id).slice(-10).map((p) => p.title);
  if (category === 'PRODUCT') {
    const stores = store.find('shopifyStores', (s) => s.tenantId === tenantId);
    const storeIds = new Set(stores.map((s) => s.id));
    const products = store.find('shopifyProducts', (p) => storeIds.has(p.storeId))
      .sort((a, b) => new Date(a.lastPostedAt || 0) - new Date(b.lastPostedAt || 0));
    const product = products.find((p) => (p.status || 'ACTIVE') === 'ACTIVE') || products[0];
    if (product) {
      const topic = `${product.title}`;
      return {
        category, topic, product,
        angle: pick(['why it’s worth it', 'who it’s for', 'how to get the most from it', 'a real use case']),
        rationale: `Least-recently-posted in-stock product (last posted ${product.lastPostedAt || 'never'}).`,
        primaryKeyword: product.productType ? `${product.productType.toLowerCase()}` : product.title.toLowerCase().split(' ').slice(0, 3).join(' '),
      };
    }
  }
  // KNOWLEDGE (or PRODUCT with no catalogue): topic bank + gap analysis.
  const bank = KNOWLEDGE_TOPICS.filter((t) => !recentTitles.some((rt) => (rt || '').toLowerCase().includes(t.split(' ')[0].toLowerCase())));
  const topic = pick(bank.length ? bank : KNOWLEDGE_TOPICS);
  return {
    category: category === 'PRODUCT' ? 'KNOWLEDGE' : category, topic,
    angle: pick(ANGLES),
    rationale: 'Selected from the IT/web topic bank, filtered against the last 10 posts to avoid repetition.',
    primaryKeyword: topic.toLowerCase(),
  };
}

// ── Stage 2 — Keyword brief (LLM_ESTIMATE default) ───────────────────────────
export function keywordBrief(idea) {
  const primary = idea.primaryKeyword || idea.topic.toLowerCase();
  const base = primary.split(' ').slice(0, 3).join(' ');
  const secondary = [
    `best ${base}`, `${base} guide`, `${base} tips`, `how to ${base}`, `${base} 2026`,
  ].slice(0, 4).map((term) => ({ term, volume: 200 + Math.floor(Math.random() * 1800), difficulty: 20 + Math.floor(Math.random() * 45) }));
  return {
    primary: { term: primary, volume: 500 + Math.floor(Math.random() * 3000), difficulty: 25 + Math.floor(Math.random() * 40), intent: 'informational', source: 'estimated' },
    secondary,
    questions: [`What is ${base}?`, `How do I choose ${base}?`, `Is ${base} worth it?`],
    entities: [base, ...base.split(' ')].slice(0, 5),
  };
}

// ── Stage 3 — Draft (deterministic composer used in simulation) ──────────────
function factLine(product) {
  if (!product) return '';
  const bits = [];
  if (product.priceMin) bits.push(`priced from ${product.currency || '$'}${product.priceMin}`);
  if (product.vendor) bits.push(`made by ${product.vendor}`);
  if (product.totalInventory != null) bits.push(`${product.totalInventory} in stock`);
  return bits.join(', ');
}

function composeBlog(ctx) {
  const { idea, kw, product, brandVoice } = ctx;
  const topic = idea.topic;
  const primary = kw.primary.term;
  const title = product
    ? `${titleCase(topic)}: is it the right pick for you?`
    : `${titleCase(topic)}: a straight-talking guide`;
  const seoTitle = fitTitle(primary);
  const excerpt = `A clear, no-hype look at ${primary}. What matters, what doesn't, and how to decide fast.`;
  const seoDescription = `${titleCase(primary)} explained without the fluff: the real trade-offs, a simple buyer’s checklist, the two things most guides quietly skip, and how to decide in five minutes.`.slice(0, 158);

  const pf = product ? `Take ${product.title}${factLine(product) ? ` — ${factLine(product)}` : ''}.` : '';
  const openings = [
    `Let's skip the throat-clearing. ${titleCase(primary)} comes down to three decisions, and most guides bury them under an intro nobody asked for.`,
    `Here's the short version, because your time matters. Get ${primary} slightly wrong and you feel it every single day; get it right and you never think about it again.`,
    `Most advice about ${primary} is written to fill a page and rank for a search term. This isn't. We service this stuff for a living, so we'll tell you what we actually see.`,
  ];
  // Rich, long-form sections (varied sentence length for burstiness, keyword
  // in the opening and in a subheading, real product facts woven in).
  const sections = [
    { heading: `What ${primary} actually means`, body:
`${pick(openings)} We will keep it concrete the whole way through. ${pf} Below is the version we give our own clients when they call and ask us straight.\n\nStrip away the marketing and ${primary} is really one question: does this remove friction from the job in front of you, or does it just look good on a spec sheet? Those are not the same thing. A headline number impresses in a tab full of comparisons. It rarely survives a real Tuesday. So we start where the work is, not where the benchmark is.` },
    { heading: `The mistake almost everyone makes with ${primary}`, body:
`The common trap is buying for the demonstration instead of the decade, because people optimise for the one flashy figure and forget the hundred small interactions they will genuinely have with it. Raw speed matters, of course, but dependable reliability matters considerably more over the years you actually own the thing. Warranty coverage, responsive support, and the unglamorous middle years are precisely where expensive regret tends to accumulate quietly.\n\nSo write down the three activities you perform most often, rather than the aspirational ones you imagine performing, and then deliberately choose the option that makes those three effortless while letting everything else remain merely adequate. That single disciplined habit prevents the majority of disappointing purchases we are later asked to rescue and replace.` },
    { heading: `A practical checklist`, body:
`Here is the same checklist we run internally before we recommend anything:\n\n1. Match it to your real workload, measured over a week, not a benchmark run.\n2. Budget for the boring parts — cables, backups, the warranty you hope you never use.\n3. Read the reviews that mention month six, not day one. Honeymoon opinions are worthless.\n4. Prefer boring reliability over a headline feature you will use twice.\n5. Write down the one thing that would make you regret this, then design around avoiding it.\n\nFive lines. It has saved our clients more money than any coupon we have ever handed out.` },
    { heading: `Where ${primary} quietly pays off`, body:
`${product ? `With ${product.title}, the payoff shows up in the small moments — fewer stalls, less waiting, one less thing to think about before the day even starts. ` : ''}Good ${primary} is invisible. You notice bad ${primary} constantly and good ${primary} almost never, which is exactly why it is easy to under-value while you shop and impossible to ignore once you live with it.\n\nThink in hours reclaimed, not features owned. A setup that saves you ten minutes a day gives you a full working week back every year. Framed like that, the cheaper option is often the expensive one.` },
    { heading: `How to decide in five minutes`, body:
`If you only have five minutes, do this. Name the job. Name the budget ceiling you will not cross. Pick the two features that genuinely matter for that job and ignore the rest of the sheet entirely. Shortlist two options, not nine — choice overload is how good decisions die. Then sleep on it once, and buy.\n\nWe would rather you buy once and forget about it than upgrade twice and resent it. If ${primary} is not right for your situation, we will say so to your face. That is the difference between making a sale and keeping a client.` },
    { heading: `The questions we hear across the counter`, body:
`Every week the same worries walk through our door, and they are good worries. "Will this be obsolete in a year?" Usually not, if you bought for the job and not the hype. "Am I overpaying?" Maybe — but the cheap option that fails in month seven is the truly expensive one. "Can I set it up myself?" Almost always, and we will walk you through the one step that trips most people.\n\nNotice a pattern. None of those questions are about raw specifications. They are about confidence, cost over time, and not being left stranded. That is what a good purchase actually buys you, and it is what we try to protect when we make a recommendation.` },
    { heading: `What we would buy ourselves`, body:
`Here is the honest tell. When our own team spends our own money, we ignore the flashiest tier and the rock-bottom tier both. The top costs double for a gain you will feel twice a year. The bottom saves a little now and charges you back in downtime later. The sensible middle wins almost every time, and it is rarely the one with the loudest marketing.\n\n${product ? `For what it is worth, ${product.title} sits in exactly that sensible middle, which is why it keeps coming up in these conversations. ` : ''}Buy for the years, not the unboxing. Keep the receipt, keep the box for the warranty window, and get back to the work the thing was supposed to help you do.` },
  ];
  const faq = kw.questions.map((q, i) => ({
    q,
    a: i === 0 ? `In plain terms, ${primary} is the setup that gets a specific job done reliably. Skip the jargon; focus on fit.`
      : i === 1 ? `Start from your workload. Write down the three things you do most, then pick the option that makes those three effortless.`
      : `For most people, yes — if it removes daily friction. If it only wins on paper, wait.`,
  }));
  const internalLinks = [
    { anchor: product ? product.title : `our ${primary} collection`, url: product?.onlineStoreUrl || `/collections/${slugify(primary)}` },
    { anchor: `related ${kw.secondary[0]?.term || primary}`, url: `/blog/${slugify(kw.secondary[0]?.term || primary)}` },
  ];
  const externalLinks = [{ anchor: 'independent testing from a reputable source', url: 'https://www.example.org/standards' }];
  const bodyMd = sections.map((s) => `## ${s.heading}\n\n${s.body}`).join('\n\n')
    + `\n\n## Frequently asked questions\n\n` + faq.map((f) => `**${f.q}**\n\n${f.a}`).join('\n\n')
    + `\n\nFurther reading: [${externalLinks[0].anchor}](${externalLinks[0].url}). See also our [${internalLinks[0].anchor}](${internalLinks[0].url}) and [${internalLinks[1].anchor}](${internalLinks[1].url}).`;

  return {
    kind: 'blog', title, slug: slugify(primary), seoTitle, seoDescription, excerpt,
    body: bodyMd, sections, faq, internalLinks, externalLinks, jsonLd: true,
    tags: [primary, ...kw.entities].slice(0, 5),
    hashtags: [], primaryKeyword: primary, keywords: [primary, ...kw.secondary.map((s) => s.term)],
    imageBrief: buildImageBrief(ctx),
  };
}

function composeSocial(platform, ctx) {
  const { idea, kw, product, brandVoice } = ctx;
  const primary = kw.primary.term;
  const cap = PLATFORM_CAPS[platform];
  const emojiOk = (brandVoice?.emojiPolicy || 'sparing') !== 'none';
  const hooks = [
    `The ${primary} question we get most weeks:`,
    `Quick one on ${primary}.`,
    `Nobody tells you this about ${primary}.`,
    product ? `We restocked ${product.title}. Here's who it's for.` : `Small thing, big difference: ${primary}.`,
  ];
  const hook = pick(hooks);
  const long = platform === 'LINKEDIN'; // LinkedIn rewards ~200-word posts
  const bodyLines = [
    product && factLine(product) ? `${product.title} — ${factLine(product)}.` : '',
    `Most people overthink ${primary}. They stare at spec sheets and forget the only question that matters: does this make the actual job easier?`,
    long ? `Here's how we frame it for clients. Name the job first. Match the tool to what you do most, not to a benchmark. Budget for the boring parts — cables, backups, the warranty you hope you never touch. Then buy once and stop shopping.` : `Start with the job, not the spec. Match it to what you actually do, then buy once.`,
    long ? `The mistake we see weekly: buying for the demo instead of the decade. A flashy number impresses in a comparison tab. It rarely survives a real Tuesday. Reliability beats headline features every single time.` : `Reliability beats headline features every time.`,
    `That's the whole playbook. No hype, no ten-point funnel — just ${primary} that quietly works.`,
  ].filter(Boolean);
  const cta = product?.onlineStoreUrl
    ? (platform === 'INSTAGRAM' ? 'Link in bio.' : `See it here: ${product.onlineStoreUrl}`)
    : 'Ask us anything below.';
  const hashPool = [primary, ...kw.entities, 'smallbusiness', 'tech', 'ecommerce'].map((t) => '#' + t.replace(/[^a-z0-9]/gi, ''));
  const hashtags = cap.hashtags.supported ? shuffle(hashPool).slice(0, cap.hashtags.recommended) : [];
  const caption = `${hook}\n\n${bodyLines.join('\n')}${emojiOk ? '' : ''}`;

  const base = {
    primaryKeyword: primary, keywords: [primary, ...kw.secondary.map((s) => s.term)],
    hashtags, callToAction: cta, imageBrief: buildImageBrief(ctx),
    altText: `${titleCase(primary)} — ${product ? product.title : 'illustrative image'} for a ${PLATFORM_META[platform].label} post`,
  };
  if (platform === 'LINKEDIN') {
    return { kind: 'linkedin', ...base, title: hook, body: `${caption}\n\n${cta === 'Ask us anything below.' ? cta : ''}`.trim(), firstComment: product?.onlineStoreUrl ? `More detail here: ${product.onlineStoreUrl}` : '' };
  }
  if (platform === 'INSTAGRAM') {
    return { kind: 'instagram', ...base, title: hook, body: `${caption}\n\n${cta}\n\n${hashtags.join(' ')}`.trim() };
  }
  if (platform === 'GOOGLE_BUSINESS') {
    return { kind: 'gbp', ...base, title: hook, body: `${bodyLines.join(' ')} ${cta}`.slice(0, 1400), gbpCta: 'LEARN_MORE' };
  }
  // FACEBOOK / CUSTOM_WEBHOOK / default
  return { kind: 'social', ...base, title: hook, body: `${caption}\n\n${cta}${hashtags.length ? '\n\n' + hashtags.join(' ') : ''}`.trim() };
}

function buildImageBrief(ctx) {
  const { idea, kw, product, brandVoice } = ctx;
  return {
    subject: product ? `${product.title}${product.featuredImageUrl ? ' (real product)' : ''}` : titleCase(kw.primary.term),
    composition: 'product-forward, shallow depth of field, rule-of-thirds',
    lighting: 'soft daylight / high-key',
    palette: (brandVoice?.toneAttributes || []).includes('technical') ? 'cool neutrals with one accent' : 'warm neutrals',
    mood: 'clean, confident, trustworthy',
    style: 'editorial product photography',
    negative: 'no text overlay, no watermark, no distorted hands, no logos',
  };
}

export function composeDraft(platform, ctx) {
  return PLATFORM_META[platform]?.longForm ? composeBlog(ctx) : composeSocial(platform, ctx);
}

// Robustly parse an LLM draft response — models often wrap JSON in ```json
// fences or add prose around it. Returns the object, or null if unparseable.
function parseDraftJson(text) {
  let s = String(text || '').trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const start = s.indexOf('{'), end = s.lastIndexOf('}');
  if (start >= 0 && end > start) s = s.slice(start, end + 1);
  try { const o = JSON.parse(s); return o && typeof o === 'object' && !Array.isArray(o) ? o : null; } catch { return null; }
}

// Merge an LLM draft onto the composed shape: take non-empty LLM fields, build
// the body from sections when present, and keep the composed (full) body if the
// LLM's is too thin for a blog — so a post is never empty or 200-word short.
function mergeDraft(composed, p, isBlog) {
  const out = { ...composed };
  for (const k of ['title', 'slug', 'seoTitle', 'seoDescription', 'excerpt', 'callToAction', 'firstComment', 'altText', 'primaryKeyword']) {
    if (typeof p[k] === 'string' && p[k].trim()) out[k] = p[k].trim();
  }
  if (Array.isArray(p.hashtags) && p.hashtags.length) out.hashtags = p.hashtags.map((h) => String(h).startsWith('#') ? String(h) : `#${String(h).replace(/[^a-z0-9]/gi, '')}`);
  if (Array.isArray(p.keywords) && p.keywords.length) out.keywords = p.keywords.map(String);
  if (Array.isArray(p.faq) && p.faq.length) out.faq = p.faq;
  if (Array.isArray(p.internalLinks) && p.internalLinks.length) out.internalLinks = p.internalLinks;

  let body = '';
  if (Array.isArray(p.sections) && p.sections.length) {
    body = p.sections.map((s) => `## ${s.heading || ''}\n\n${s.body || ''}`.trim()).join('\n\n');
    out.sections = p.sections;
  } else if (typeof p.body === 'string' && p.body.trim()) body = p.body.trim();
  else if (typeof p.caption === 'string' && p.caption.trim()) body = p.caption.trim();
  else if (typeof p.hook === 'string') body = [p.hook, p.body].filter(Boolean).join('\n\n');

  // Keep the LLM body unless it's too thin for a blog (then keep the full composed one).
  if (body && (!isBlog || body.length >= 500)) out.body = body;
  if (out.faq && out.faq.length) out.jsonLd = true;
  if (!out.slug && out.primaryKeyword) out.slug = slugify(out.primaryKeyword);
  return out;
}

// ── Prompt assembly (doc 03 §7) — real, shown in the Playground ──────────────
export function assemblePrompt({ tenantId, connection, idea, kw, product }) {
  const k = knowledgeFor(tenantId, connection);
  const bv = brandVoiceFor(tenantId);
  const cap = PLATFORM_CAPS[connection.platform];
  const recent = store.find('posts', (p) => p.connectionId === connection.id).slice(-10).map((p) => p.title).filter(Boolean);
  const blocks = [];
  blocks.push(['Brain global instructions', renderKnowledge(k.global) || '(not set — using safe defaults)']);
  blocks.push([`Platform knowledge — ${PLATFORM_META[connection.platform].label}`, renderKnowledge(k.platform) || `Write natively for ${PLATFORM_META[connection.platform].label}.`]);
  blocks.push(['Connection knowledge', renderKnowledge(k.connection) || `Account: ${connection.label}.`]);
  blocks.push(['Brand voice', bv ? `Tone: ${(bv.toneAttributes || []).join(', ')} · POV: ${bv.personPov} · Reading level: grade ${bv.readingLevel} · Emoji: ${bv.emojiPolicy}. Banned: ${(bv.bannedPhrases || []).join(', ')}` : '(default voice)']);
  blocks.push(['Platform format contract', `Max ${cap.text.maxChars} chars · ${cap.text.markdown ? 'markdown' : 'plain text'} · links: ${cap.text.links} · hashtags: ${cap.hashtags.supported ? `${cap.hashtags.recommended} recommended (max ${cap.hashtags.max})` : 'none'} · media required: ${cap.requiresMedia}`]);
  blocks.push(['── cache breakpoint ──', '']);
  blocks.push(['Post brief', `Category: ${idea.category} · Topic: ${idea.topic} · Angle: ${idea.angle} · CTA style: ${bv?.ctaStyle || 'helpful, low-pressure'}`]);
  blocks.push(['Keyword brief', JSON.stringify(kw)]);
  blocks.push(['Product facts', product ? JSON.stringify({ title: product.title, price: product.priceMin, url: product.onlineStoreUrl, vendor: product.vendor, type: product.productType }) : '(knowledge post — no product)']);
  blocks.push(['Recent posts (avoid repeating)', recent.length ? recent.join(' | ') : '(none yet)']);
  const isBlogTarget = !!PLATFORM_META[connection.platform]?.longForm;
  const label = PLATFORM_META[connection.platform].label;
  const contract = isBlogTarget
    ? `Return ONLY a JSON object (no code fences, no commentary) with EXACTLY these keys: {"title": string, "slug": string (lowercase-hyphenated, ≤5 words), "seoTitle": string (50–60 chars), "seoDescription": string (120–158 chars), "excerpt": string, "sections": [{"heading": string, "body": string}], "faq": [{"q": string, "a": string}], "primaryKeyword": string, "keywords": [string]}. Write 5–7 sections, each 2–3 full paragraphs; the whole article MUST total at least 900 words. Weave in the real product facts and keyword brief above. Be concrete and specific; never use AI-tell phrases.`
    : `Return ONLY a JSON object (no code fences, no commentary) with keys: {"body": string, "hashtags": [string], "callToAction": string, "altText": string, "primaryKeyword": string}. "body" is the full ${label} post copy, within the platform length limits above — specific, human, hook in the first line, no AI-tell phrases.`;
  blocks.push(['Output contract', contract]);
  const system = `You are the content brain for ${connection.label}, writing a ${label} post. Write specific, human, useful copy grounded in the facts provided. Never use AI-tell phrases. Output only the JSON described in the output contract.`;
  const prompt = blocks.map(([h, b]) => (b ? `### ${h}\n${b}` : `\n${h}\n`)).join('\n\n');
  return { system, prompt, blocks };
}

// ── AutomationRun helpers ────────────────────────────────────────────────────
function startRun(tenantId, connectionId, trigger, postId) {
  return store.insert('automationRuns', {
    tenantId, connectionId, postId: postId || null, trigger, status: 'RUNNING',
    stage: STAGES[0], stageHistory: [], inputTokens: 0, outputTokens: 0, costUsd: 0,
    startedAt: new Date().toISOString(),
  });
}
function markStage(run, stage, ok, ms, extra = {}) {
  const hist = run.stageHistory || [];
  hist.push({ stage, ok, ms, at: new Date().toISOString(), ...extra });
  store.update('automationRuns', run.id, { stage, stageHistory: hist });
  emit(run.tenantId, 'run.progress', { runId: run.id, stage, index: STAGES.indexOf(stage) + 1, total: STAGES.length, ok });
}

// ── The orchestrator ─────────────────────────────────────────────────────────
export async function runPipeline(opts) {
  const { tenantId, connectionId, category = 'KNOWLEDGE', trigger = 'MANUAL' } = opts;
  const connection = store.get('connections', connectionId);
  if (!connection) throw new Error('connection not found');
  // Real content is written by a live model — require a configured AI key.
  if (!hasLiveProvider(tenantId, 'DRAFT')) {
    const e = new Error('No AI provider is configured. Add an API key in Brain → Providers to generate content.');
    e.code = 'NO_PROVIDER';
    throw e;
  }
  const platform = connection.platform;
  const isBlog = !!PLATFORM_META[platform]?.longForm;
  const cap = PLATFORM_CAPS[platform];
  const bv = brandVoiceFor(tenantId);
  const banned = bannedList(bv);
  const schedule = store.findOne('platformSchedules', (s) => s.connectionId === connectionId);
  const threshold = schedule?.autoApproveAbove ?? 75;
  const shadow = opts.shadow ?? (connection.mode === 'SHADOW');

  const run = startRun(tenantId, connectionId, trigger);
  const post = store.insert('posts', {
    tenantId, connectionId, category, status: 'GENERATING', language: 'en',
    isManual: false, generationMeta: { runId: run.id },
  });
  store.update('automationRuns', run.id, { postId: post.id });
  emit(tenantId, 'post.updated', { postId: post.id, status: 'GENERATING' });

  try {
    // 1 IDEATE
    let t = Date.now();
    const idea = opts.idea || ideate(tenantId, connection, category);
    if (opts.topic) idea.topic = opts.topic;
    let product = idea.product || (opts.productId ? store.get('shopifyProducts', opts.productId) : null);
    if (product) idea.product = product;
    markStage(run, 'IDEATE', true, Date.now() - t, { topic: idea.topic });
    const ideaRow = store.insert('contentIdeas', {
      tenantId, category: idea.category, topic: idea.topic, angle: idea.angle, rationale: idea.rationale,
      sourceProductId: product?.id || null, primaryKeyword: idea.primaryKeyword, status: 'used', usedByPostId: post.id,
    });

    // 2 KEYWORD
    t = Date.now();
    const kw = keywordBrief(idea);
    markStage(run, 'KEYWORD', true, Date.now() - t, { primary: kw.primary.term });

    // Assemble the real prompt (used live or shown in Playground).
    const assembled = assemblePrompt({ tenantId, connection, idea, kw, product });

    // 3 DRAFT — live LLM if configured, else deterministic composer.
    t = Date.now();
    const composed = composeDraft(platform, { idea, kw, product, brandVoice: bv });
    const draftRes = await brainRun({
      tenantId, role: 'DRAFT', system: assembled.system, prompt: assembled.prompt,
      postId: post.id, runId: run.id, expectJson: true, maxTokens: isBlog ? 5000 : 1200,
      simulate: () => JSON.stringify(composed),
    });
    let content = composed;
    if (!draftRes.simulated && draftRes.text) {
      const parsed = parseDraftJson(draftRes.text);
      content = parsed ? mergeDraft(composed, parsed, isBlog) : composed;
    }
    markStage(run, 'DRAFT', true, Date.now() - t, { model: draftRes.model, simulated: draftRes.simulated, words: (content.body || '').replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length });

    // 4 IMAGE — brief → (simulated) generate → vision QA → attach placeholder
    t = Date.now();
    const preset = IMAGE_PRESETS[platform] || IMAGE_PRESETS.LINKEDIN;
    const media = createPlaceholderImage(tenantId, connection, post, content, preset);
    markStage(run, 'IMAGE', true, Date.now() - t, { preset: `${preset.w}x${preset.h}` });

    // 5 HUMANIZE — banned-phrase strip + preferred terms + (live) rhythm pass
    t = Date.now();
    let body = content.body || '';
    const before = measureBurstiness(body);
    const strip = stripBannedPhrases(body, banned);
    body = applyPreferredTerms(strip.text, bv?.preferredTerms || {});
    const humanRes = await brainRun({
      tenantId, role: 'HUMANIZE', postId: post.id, runId: run.id,
      prompt: `Rewrite for rhythm and voice. ${humanizeGuidance(body, banned)}\n\n${body}`,
      simulate: () => body, // deterministic path keeps the stripped text
    });
    if (!humanRes.simulated && humanRes.text) body = humanRes.text;
    const hScore = humanScore(body, { banned });
    content.body = body;
    markStage(run, 'HUMANIZE', true, Date.now() - t, { humanScore: hScore.score, removed: strip.removed.length, burstiness: hScore.burstiness.stdev });

    // Map composed content → Post fields
    applyContentToPost(post.id, platform, content, media);

    // 6 SEO — deterministic scorer + one repair loop if below threshold
    t = Date.now();
    let full = store.get('posts', post.id);
    let seo = scoreSeo(full, { isBlog, wordBand: cap.wordBand, media: [media].filter(Boolean), hashtags: content.hashtags });
    if (seo.score < threshold) {
      const repaired = repairSeo(full, seo, isBlog);
      applyContentToPost(post.id, platform, { ...content, ...repaired }, media);
      full = store.get('posts', post.id);
      seo = scoreSeo(full, { isBlog, wordBand: cap.wordBand, media: [media].filter(Boolean), hashtags: content.hashtags });
    }
    store.update('posts', post.id, { seoScore: seo.score, seoReport: seo.checks, readabilityGrade: seo.readability, wordCount: seo.wordCount });
    markStage(run, 'SEO', true, Date.now() - t, { score: seo.score });

    // 7 POLICY — rule engine + duplicate check
    t = Date.now();
    const policy = policyCheck(store.get('posts', post.id), product);
    store.update('posts', post.id, { policyPassed: policy.pass, policyReport: policy });
    markStage(run, 'POLICY', policy.pass, Date.now() - t, { issues: policy.issues.length });

    // 8 PERSIST — decide status
    t = Date.now();
    const humanPassed = hScore.score >= 55;
    store.update('posts', post.id, { humanizePassed: humanPassed });
    // Autopilot (non-shadow) auto-schedules only when the SEO gate and policy
    // gate both pass; everything else lands in the review inbox.
    let status;
    if (!shadow && connection.mode === 'AUTOPILOT' && seo.score >= threshold && policy.pass) status = 'SCHEDULED';
    else status = 'NEEDS_REVIEW';
    if (status === 'SCHEDULED') {
      const when = opts.scheduledAt || nextSlotFor(connectionId) || new Date(Date.now() + 3600e3).toISOString();
      store.update('posts', post.id, { status, scheduledAt: when, idempotencyKey: cuid('idem') });
    } else {
      store.update('posts', post.id, { status });
    }
    if (product) store.update('shopifyProducts', product.id, { lastPostedAt: new Date().toISOString(), postCount: (product.postCount || 0) + 1 });

    // Save a first revision snapshot
    store.insert('postRevisions', { postId: post.id, version: 1, snapshot: store.get('posts', post.id), reason: 'ai_generate' });

    markStage(run, 'PERSIST', true, Date.now() - t, { status });
    const finalPost = store.get('posts', post.id);
    store.update('automationRuns', run.id, {
      status: 'SUCCEEDED', finishedAt: new Date().toISOString(),
      inputTokens: (draftRes.usage?.inputTokens || 0) + (humanRes.usage?.inputTokens || 0),
      outputTokens: (draftRes.usage?.outputTokens || 0) + (humanRes.usage?.outputTokens || 0),
      costUsd: (draftRes.costUsd || 0) + (humanRes.costUsd || 0),
    });
    emit(tenantId, 'post.updated', { postId: post.id, status: finalPost.status, seoScore: seo.score });
    return { post: finalPost, run: store.get('automationRuns', run.id), seo };
  } catch (e) {
    store.update('posts', post.id, { status: 'FAILED' });
    store.update('automationRuns', run.id, { status: 'FAILED', errorMessage: e.message, finishedAt: new Date().toISOString() });
    emit(tenantId, 'post.updated', { postId: post.id, status: 'FAILED' });
    if (e.code === 'BUDGET_EXCEEDED') throw e;
    throw e;
  }
}

// Map the composed content object onto Post columns for a given platform.
export function applyContentToPost(postId, platform, content, media) {
  const patch = {
    title: content.title || null,
    body: content.body || '',
    excerpt: content.excerpt || null,
    hashtags: content.hashtags || [],
    callToAction: content.callToAction || content.gbpCta || null,
    linkUrl: content.internalLinks?.[0]?.url || null,
    seoTitle: content.seoTitle || null,
    seoDescription: content.seoDescription || null,
    slug: content.slug || null,
    primaryKeyword: content.primaryKeyword || null,
    keywords: content.keywords || [],
    internalLinks: content.internalLinks || [],
    externalLinks: content.externalLinks || [],
    faq: content.faq || [],
    jsonLd: !!content.jsonLd,
    imageBrief: content.imageBrief || null,
  };
  store.update('posts', postId, patch);
  return store.get('posts', postId);
}

function repairSeo(post, seo, isBlog) {
  const kw = (post.primaryKeyword || '').trim();
  const patch = {};
  for (const f of seo.failed) {
    if (f.id === 'title_length') {
      let t = post.seoTitle || post.title || titleCase(kw);
      if (t.length < 50) t = `${t} — a practical guide`.slice(0, 60);
      if (t.length > 60) t = t.slice(0, 60);
      patch.seoTitle = t;
    }
    if (f.id === 'kw_in_title' && kw) patch.seoTitle = `${titleCase(kw)}: ${post.title || 'a guide'}`.slice(0, 60);
    if (f.id === 'meta_length') {
      let d = post.seoDescription || post.excerpt || `${titleCase(kw)} explained clearly.`;
      if (d.length < 120) d = `${d} Here's the short, honest version with a simple checklist you can use today.`.slice(0, 158);
      if (d.length > 158) d = d.slice(0, 158);
      patch.seoDescription = d;
    }
    if (f.id === 'kw_in_meta' && kw) patch.seoDescription = `${titleCase(kw)}: ${(post.seoDescription || 'a clear, practical guide with a simple checklist and honest trade-offs.')}`.slice(0, 158);
    if (f.id === 'slug' && kw) patch.slug = slugify(kw);
  }
  return patch;
}

export function policyCheck(post, product) {
  const issues = [];
  const text = `${post.title || ''} ${post.body || ''}`.toLowerCase();
  const superlatives = ['best', 'guaranteed', '#1', 'number one', 'cures', 'miracle', 'cheapest'];
  for (const s of superlatives) if (new RegExp(`\\b${s}\\b`).test(text)) issues.push({ type: 'claim', detail: `Unverifiable/absolute claim: "${s}"` });
  const banned = ['politics', 'election'];
  for (const b of banned) if (text.includes(b)) issues.push({ type: 'banned_topic', detail: `Banned topic reference: "${b}"` });
  // PII scan
  if (/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/.test(post.body || '')) issues.push({ type: 'pii', detail: 'Email address found in body' });
  if (/\b(?:\+?\d[\d -]{8,}\d)\b/.test(post.body || '')) issues.push({ type: 'pii', detail: 'Possible phone number in body' });
  // Duplicate check vs last 90 days (title similarity)
  const cutoff = new Date(Date.now() - 90 * 864e5).toISOString();
  const recent = store.find('posts', (p) => p.connectionId === post.connectionId && p.id !== post.id && (p.publishedAt || p.createdAt) >= cutoff);
  const dup = recent.find((p) => similarity(p.title || '', post.title || '') > 0.85);
  if (dup) issues.push({ type: 'duplicate', detail: `Very similar to an existing post: "${dup.title}"` });
  return { pass: issues.filter((i) => i.type !== 'claim').length === 0, issues };
}

function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\s+/));
  const wb = new Set(b.toLowerCase().split(/\s+/));
  if (!wa.size || !wb.size) return 0;
  let inter = 0;
  for (const w of wa) if (wb.has(w)) inter++;
  return inter / Math.max(wa.size, wb.size);
}

function createPlaceholderImage(tenantId, connection, post, content, preset) {
  const bytes = 120000 + Math.floor(Math.random() * 400000);
  return store.insert('mediaAssets', {
    tenantId, postId: post.id, connectionId: connection.id, kind: 'IMAGE', source: 'AI_GENERATED',
    storageKey: `sim/${post.id}.svg`, publicUrl: null, thumbnailKey: `sim/${post.id}-thumb.svg`,
    mimeType: 'image/svg+xml', bytes, width: preset.w, height: preset.h,
    altText: content.altText || `${content.primaryKeyword || 'illustration'} for ${connection.label}`,
    aiMeta: { brief: content.imageBrief, visionQa: { matchesPost: true, hasGarbledText: false, brandSafe: true, onPalette: true, score: 88 } },
  });
}

// ── Scheduling helper: next slot from a connection's schedule ────────────────
// NOTE ON TIMEZONE: slot day/time are matched against the *server's* local
// clock, which is correct when the server runs in the tenant's timezone (set
// the container TZ to schedule.timezone — the documented single-tenant
// deployment assumption). Full per-tenant, DST-correct scheduling would compute
// the slot instant via Intl in schedule.timezone; that's a v2 item.
export function nextSlotFor(connectionId, fromDate = new Date(), scheduleOverride = null) {
  // scheduleOverride lets the UI preview an unsaved schedule — without it,
  // previewing would have to persist first, and "Cancel" would not cancel.
  const sched = scheduleOverride || store.findOne('platformSchedules', (s) => s.connectionId === connectionId);
  if (!sched || !sched.isEnabled || !(sched.slots || []).length) return null;
  const candidates = [];
  for (let d = 0; d < 14; d++) {
    const day = new Date(fromDate.getTime() + d * 864e5);
    for (const slot of sched.slots) {
      if (!slot || typeof slot.time !== 'string' || slot.dayOfWeek !== day.getDay()) continue;
      const [h, m] = slot.time.split(':').map(Number);
      if (!Number.isFinite(h) || !Number.isFinite(m)) continue;
      const when = new Date(day); when.setHours(h, m, 0, 0);
      if (when > fromDate) candidates.push(when.toISOString());
    }
  }
  candidates.sort();
  return candidates[0] || null;
}

export { STAGES };
