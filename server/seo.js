// Deterministic SEO scorer — doc 05 §6. This is CODE, not an LLM asking itself
// "is this SEO friendly?". Real checks, real weights, reproducible score. The
// identical function runs in the API, the worker and (bundled) the browser, so
// the composer's live ring matches the server's gate exactly.

// ── Text utilities ───────────────────────────────────────────────────────────
export function toPlainText(input = '') {
  let t = String(input);
  t = t.replace(/```[\s\S]*?```/g, ' ');           // code fences
  t = t.replace(/<[^>]+>/g, ' ');                   // html tags
  t = t.replace(/!\[[^\]]*\]\([^)]*\)/g, ' ');      // md images
  t = t.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');    // md links → anchor text
  t = t.replace(/[#>*_`~]/g, ' ');                  // md punctuation
  return t.replace(/\s+/g, ' ').trim();
}

export function tokenizeWords(text = '') {
  const m = String(text).toLowerCase().match(/[a-z0-9']+/g);
  return m || [];
}

export function splitSentences(text = '') {
  return String(text)
    .replace(/\s+/g, ' ')
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"'])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function countSyllables(word) {
  const w = word.toLowerCase().replace(/[^a-z]/g, '');
  if (w.length <= 3) return 1;
  const groups = w.replace(/e$/, '').match(/[aeiouy]+/g);
  return Math.max(1, groups ? groups.length : 1);
}

export function fleschReadingEase(text) {
  const words = tokenizeWords(text);
  const sentences = splitSentences(text);
  if (words.length === 0 || sentences.length === 0) return 0;
  const syll = words.reduce((s, w) => s + countSyllables(w), 0);
  const asl = words.length / sentences.length;
  const asw = syll / words.length;
  return Math.round((206.835 - 1.015 * asl - 84.6 * asw) * 10) / 10;
}

// Headings from markdown (#, ##) and HTML (<h1>..<h6>). Returns [{level,text}].
export function extractHeadings(body = '') {
  const out = [];
  for (const line of String(body).split('\n')) {
    const md = line.match(/^(#{1,6})\s+(.*)$/);
    if (md) out.push({ level: md[1].length, text: md[2].trim() });
  }
  const htmlRe = /<h([1-6])[^>]*>(.*?)<\/h\1>/gi;
  let m;
  while ((m = htmlRe.exec(body)) !== null) {
    out.push({ level: Number(m[1]), text: m[2].replace(/<[^>]+>/g, '').trim() });
  }
  return out;
}

function countOccurrences(haystackWords, needle) {
  const parts = tokenizeWords(needle);
  if (parts.length === 0) return 0;
  let count = 0;
  for (let i = 0; i + parts.length <= haystackWords.length; i++) {
    let ok = true;
    for (let j = 0; j < parts.length; j++) {
      if (haystackWords[i + j] !== parts[j]) { ok = false; break; }
    }
    if (ok) count++;
  }
  return count;
}

function passiveRatio(sentences) {
  const be = /\b(am|is|are|was|were|be|been|being)\b/;
  const irregular = /\b(made|done|taken|given|seen|known|shown|held|built|found|sent|kept|told|written|driven|chosen|broken|spoken)\b/;
  let passive = 0;
  for (const s of sentences) {
    const lower = s.toLowerCase();
    if (be.test(lower) && (/\b\w+ed\b/.test(lower) || irregular.test(lower))) passive++;
  }
  return sentences.length ? passive / sentences.length : 0;
}

// ── The scorer ───────────────────────────────────────────────────────────────
// opts: { isBlog:boolean, wordBand:[min,max], media:[{altText}], hashtags:[] }
export function scoreSeo(post = {}, opts = {}) {
  const isBlog = !!opts.isBlog;
  const band = opts.wordBand || (isBlog ? [900, 1600] : [40, 200]);
  const media = opts.media || [];
  const body = post.body || '';
  const plain = toPlainText(body);
  const words = tokenizeWords(plain);
  const wordCount = words.length;
  const sentences = splitSentences(plain);
  const kw = String(post.primaryKeyword || '').toLowerCase().trim();
  const hasKw = kw.length > 0;
  const seoTitle = post.seoTitle || post.title || '';
  const seoDesc = post.seoDescription || post.excerpt || '';
  const headings = extractHeadings(body);
  const first100 = words.slice(0, 100).join(' ');
  const checks = [];

  const add = (id, label, weight, applicable, pass, detail, fix) =>
    checks.push({ id, label, weight, applicable, pass: applicable ? !!pass : null, detail, fix });

  // 1 — SEO title length 50–60
  add('title_length', 'SEO title length', 8, true,
    seoTitle.length >= 50 && seoTitle.length <= 60,
    `${seoTitle.length} chars`, 'Aim for 50–60 characters so it isn’t truncated in search.');

  // 2 — primary keyword in title (bonus if first half)
  const kwInTitle = hasKw && seoTitle.toLowerCase().includes(kw);
  const kwFirstHalf = kwInTitle && seoTitle.toLowerCase().indexOf(kw) < seoTitle.length / 2;
  add('kw_in_title', 'Primary keyword in title', 10, hasKw, kwInTitle,
    kwInTitle ? (kwFirstHalf ? 'present, front-loaded' : 'present') : 'missing',
    'Put the primary keyword in the title, ideally in the first half.');

  // 3 — meta description length 120–158 (blog)
  add('meta_length', 'Meta description length', 6, isBlog,
    seoDesc.length >= 120 && seoDesc.length <= 158,
    `${seoDesc.length} chars`, 'Write a 120–158 character meta description.');

  // 4 — keyword in meta description (blog)
  add('kw_in_meta', 'Keyword in meta description', 5, isBlog && hasKw,
    hasKw && seoDesc.toLowerCase().includes(kw), hasKw ? '' : 'no keyword set',
    'Include the primary keyword in the meta description.');

  // 5 — keyword in first 100 words
  add('kw_first_100', 'Keyword in first 100 words', 8, hasKw,
    hasKw && first100.includes(kw), '', 'Mention the keyword within the opening 100 words.');

  // 6 — keyword density 0.5–2.5%
  const occ = hasKw ? countOccurrences(words, kw) : 0;
  const kwWordLen = tokenizeWords(kw).length || 1;
  const density = wordCount ? (occ * kwWordLen / wordCount) * 100 : 0;
  add('kw_density', 'Keyword density', 6, hasKw && wordCount > 0,
    density >= 0.5 && density <= 2.5, `${density.toFixed(2)}%`,
    density > 2.5 ? 'Reduce keyword repetition — this reads as over-optimised.' : 'Use the keyword a little more (0.5–2.5%).');

  // 7 — heading hierarchy (blog): title is the single H1; body H2+, no skipped levels
  let hierarchyOk = true;
  if (headings.some((h) => h.level === 1)) hierarchyOk = false; // H1 belongs to the title, not the body
  let prev = 1;
  for (const h of headings) { if (h.level > prev + 1) { hierarchyOk = false; break; } prev = h.level; }
  add('heading_hierarchy', 'Heading hierarchy', 7, isBlog, headings.length > 0 && hierarchyOk,
    `${headings.length} headings`, 'Use one H1 (the title) then H2/H3 without skipping levels.');

  // 8 — keyword/variant in ≥1 H2 (blog)
  const kwParts = tokenizeWords(kw);
  const kwInH2 = headings.some((h) => h.level === 2 && kwParts.some((p) => h.text.toLowerCase().includes(p)));
  add('kw_in_h2', 'Keyword in a subheading', 5, isBlog && hasKw, kwInH2, '',
    'Work the keyword (or a variant) into at least one H2.');

  // 9 — word count vs content type
  const wcPass = isBlog ? wordCount >= band[0] : (wordCount >= band[0] && wordCount <= band[1]);
  add('word_count', 'Word count', 8, true, wcPass, `${wordCount} words`,
    isBlog ? `Blog posts should be ≥ ${band[0]} words.` : `Keep this within ${band[0]}–${band[1]} words for the platform.`);

  // 10 — readability (Flesch) 55–75
  const flesch = fleschReadingEase(plain);
  add('readability', 'Readability (Flesch)', 7, wordCount > 20, flesch >= 55 && flesch <= 75,
    `${flesch}`, flesch < 55 ? 'Shorten sentences and simplify words.' : 'Add a little substance — it reads very light.');

  // 11 — internal links ≥2 (blog), descriptive anchors
  const internal = (post.internalLinks || []).filter((l) => l && l.url && (l.anchor || '').trim().length > 2);
  add('internal_links', 'Internal links', 7, isBlog, internal.length >= 2, `${internal.length}`,
    'Add at least two internal links with descriptive anchor text.');

  // 12 — external authority link ≥1 (blog)
  const external = post.externalLinks || [];
  add('external_link', 'External authority link', 3, isBlog, external.length >= 1, `${external.length}`,
    'Cite at least one authoritative external source.');

  // 13 — image alt text: every image has alt, keyword in ≥1
  const imgApplicable = media.length > 0 || isBlog;
  const allAlt = media.length > 0 && media.every((m) => (m.altText || '').trim().length > 0);
  const kwInAlt = hasKw && media.some((m) => (m.altText || '').toLowerCase().includes(kw));
  add('image_alt', 'Image alt text', 6, imgApplicable, media.length > 0 && allAlt && (!hasKw || kwInAlt),
    media.length ? `${media.length} image(s)` : 'no image', 'Add descriptive alt text to every image; include the keyword in one.');

  // 14 — slug quality (blog)
  const slug = post.slug || '';
  const slugWords = slug.split('-').filter(Boolean);
  const slugPass = /^[a-z0-9-]+$/.test(slug) && slugWords.length > 0 && slugWords.length <= 5 && (!hasKw || slug.includes(kw.replace(/\s+/g, '-')));
  add('slug', 'Slug quality', 4, isBlog, slugPass, slug || '(none)',
    'Use a lowercase, hyphenated slug of ≤5 words containing the keyword.');

  // 15 — structured data (blog)
  add('structured_data', 'Structured data (JSON-LD)', 5, isBlog,
    !!post.jsonLd && (post.faq || []).length > 0, post.jsonLd ? 'Article + FAQ' : 'missing',
    'Emit Article + FAQPage JSON-LD (a FAQ block enables this).');

  // 16 — paragraph length avg ≤4 sentences
  const paras = plain ? String(body).split(/\n{2,}/).map(toPlainText).filter((p) => p.length > 0) : [];
  const avgSent = paras.length ? paras.reduce((s, p) => s + splitSentences(p).length, 0) / paras.length : 0;
  add('paragraph_length', 'Paragraph length', 3, paras.length > 0, avgSent <= 4,
    `${avgSent.toFixed(1)} sentences/para`, 'Break long paragraphs up — aim for ≤4 sentences each.');

  // 17 — passive voice <15%
  const passive = passiveRatio(sentences);
  add('passive_voice', 'Passive voice', 2, sentences.length > 3, passive < 0.15,
    `${Math.round(passive * 100)}%`, 'Rewrite passive sentences in the active voice.');

  // Weighted score across applicable checks only.
  const applicable = checks.filter((c) => c.applicable);
  const totalWeight = applicable.reduce((s, c) => s + c.weight, 0) || 1;
  const earned = applicable.reduce((s, c) => s + (c.pass ? c.weight : 0), 0);
  const score = Math.round((earned / totalWeight) * 100);

  return {
    score,
    wordCount,
    readability: flesch,
    checks,
    failed: applicable.filter((c) => !c.pass),
    passedCount: applicable.filter((c) => c.pass).length,
    applicableCount: applicable.length,
  };
}
