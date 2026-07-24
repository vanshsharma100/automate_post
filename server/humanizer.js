// Humanizer — doc 05 §5. A real pass, not a marketing word. Deterministic parts
// live here (banned-phrase strip, burstiness measurement, preferred-term
// swaps); the rhythm/voice rewrite is the LLM HUMANIZE role which consumes the
// guidance this module produces. humanScore is a style-consistency score — it
// is explicitly NOT an AI-detector score.
import { AI_TELLS } from './constants.js';
import { splitSentences, tokenizeWords } from './seo.js';

export function bannedList(brandVoice) {
  const custom = (brandVoice && Array.isArray(brandVoice.bannedPhrases)) ? brandVoice.bannedPhrases : [];
  return [...new Set([...AI_TELLS, ...custom.map((s) => String(s).toLowerCase())])];
}

// Remove/soften AI-tell phrases. Returns the cleaned text + what was hit.
export function stripBannedPhrases(text, banned) {
  let out = String(text || '');
  const removed = [];
  for (const phrase of banned) {
    if (!phrase) continue;
    const re = new RegExp(`\\b${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi');
    if (re.test(out)) {
      removed.push(phrase);
      // Drop stitch-words outright; blank the rest and tidy whitespace/punctuation.
      if (/^(moreover|furthermore|in conclusion|needless to say)$/i.test(phrase)) {
        out = out.replace(new RegExp(`\\b${phrase}\\b,?\\s*`, 'gi'), '');
      } else {
        out = out.replace(re, '');
      }
    }
  }
  // Tidy whitespace WITHOUT destroying newlines — paragraph breaks and markdown
  // headings must survive the strip (collapsing \s here was corrupting structure).
  out = out
    .replace(/[ \t]{2,}/g, ' ')          // runs of spaces/tabs → one space
    .replace(/ +([.,!?;:])/g, '$1')      // space before punctuation
    .replace(/([.,!?;:]){2,}/g, '$1')    // doubled punctuation
    .replace(/[ \t]+\n/g, '\n')          // trailing spaces on a line
    .replace(/\n{3,}/g, '\n\n')          // cap consecutive blank lines
    .trim();
  return { text: out, removed };
}

export function applyPreferredTerms(text, map = {}) {
  let out = String(text || '');
  for (const [from, to] of Object.entries(map)) {
    if (!from) continue;
    out = out.replace(new RegExp(`\\b${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'gi'), to);
  }
  return out;
}

// Burstiness — LLM prose clusters at 15–20 words/sentence with low variance;
// human writing swings from 4 to 35. We return the standard deviation of
// sentence length; higher is more human-like.
export function measureBurstiness(text) {
  const sentences = splitSentences(text);
  const lengths = sentences.map((s) => tokenizeWords(s).length).filter((n) => n > 0);
  if (lengths.length < 2) return { stdev: 0, mean: lengths[0] || 0, min: lengths[0] || 0, max: lengths[0] || 0, count: lengths.length };
  const mean = lengths.reduce((a, b) => a + b, 0) / lengths.length;
  const variance = lengths.reduce((a, b) => a + (b - mean) ** 2, 0) / lengths.length;
  const stdev = Math.sqrt(variance);
  return { stdev: Math.round(stdev * 10) / 10, mean: Math.round(mean * 10) / 10, min: Math.min(...lengths), max: Math.max(...lengths), count: lengths.length };
}

// Composite style-consistency score (0–100) from: banned-phrase cleanliness,
// sentence-length variance, and lexical variety.
export function humanScore(text, { banned = [] } = {}) {
  const bannedHits = stripBannedPhrases(text, banned).removed.length;
  const burst = measureBurstiness(text);
  const words = tokenizeWords(text);
  const variety = words.length ? new Set(words).size / words.length : 0;

  // Banned phrases: −8 each, floor at 0 contribution.
  const bannedScore = Math.max(0, 100 - bannedHits * 8);
  // Burstiness: stdev of 7+ is human-ish → full marks; scale below that.
  const burstScore = Math.min(100, (burst.stdev / 7) * 100);
  // Variety: 0.45+ unique-word ratio is healthy for short copy.
  const varietyScore = Math.min(100, (variety / 0.45) * 100);

  const score = Math.round(bannedScore * 0.4 + burstScore * 0.4 + varietyScore * 0.2);
  return { score, bannedHits, burstiness: burst, variety: Math.round(variety * 100) / 100 };
}

// Guidance string appended to the LLM HUMANIZE prompt when metrics are weak.
export function humanizeGuidance(text, banned) {
  const burst = measureBurstiness(text);
  const notes = [];
  if (burst.stdev < 5) notes.push('Vary sentence length hard — mix 4-word punches with 30-word runs. Current variance is too flat and reads machine-made.');
  const hits = stripBannedPhrases(text, banned).removed;
  if (hits.length) notes.push(`Remove these AI-tell phrases entirely: ${hits.join(', ')}.`);
  notes.push('Kill the intro/3-bullets/conclusion skeleton. Open mid-thought or lead with the counter-intuitive claim.');
  notes.push('Replace any generic claim with a concrete number, price, spec or named example.');
  return notes.join(' ');
}
