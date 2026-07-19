'use strict';

/**
 * The "Brain" registry — every AI provider the tool can use, in ONE place.
 *
 * To add another writing provider later, add an entry to TEXT_PROVIDERS and a
 * matching `case` in src/contentBrain.js `callProvider()`. Everything else
 * (the Brain page, the model dropdowns, the migration) reads from here.
 */

// Model lists are the current, official API model IDs (verified against each
// provider's docs). The FIRST entry in each list is the default.
const TEXT_PROVIDERS = [
  {
    key: 'claude',
    label: 'Claude',
    vendor: 'Anthropic',
    icon: '🧠',
    keyHint: 'sk-ant-...',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    models: ['claude-sonnet-5', 'claude-opus-4-8', 'claude-fable-5', 'claude-haiku-4-5'],
    blurb: 'Excellent, human-sounding writing. Great default for posts and blogs.',
  },
  {
    key: 'openai',
    label: 'ChatGPT',
    vendor: 'OpenAI',
    icon: '🤖',
    keyHint: 'sk-...',
    keyUrl: 'https://platform.openai.com/api-keys',
    // gpt-5.6 = Sol (frontier); Terra balances cost; Luna is cheapest.
    models: ['gpt-5.6', 'gpt-5.6-terra', 'gpt-5.6-luna'],
    blurb: 'Versatile and fast. Good all-rounder for social copy.',
  },
  {
    key: 'gemini',
    label: 'Gemini',
    vendor: 'Google',
    icon: '✨',
    keyHint: 'AIza...',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    models: ['gemini-3.5-flash', 'gemini-3.1-pro-preview', 'gemini-2.5-pro', 'gemini-2.5-flash'],
    blurb: 'Has a generous free tier. Solid writing and image generation.',
  },
];

const IMAGE_PROVIDERS = [
  { key: 'gemini', label: 'Gemini (Nano Banana)', vendor: 'Google', note: 'Free tier available. Uses your Gemini key.' },
  { key: 'openai', label: 'ChatGPT (GPT Image 2)', vendor: 'OpenAI', note: 'Top-quality images. Uses your OpenAI key (paid).' },
];

// The image models each provider actually calls (kept here so there's one place
// to update). These are distinct from the text models above.
const IMAGE_MODELS = {
  gemini: 'gemini-3.1-flash-image', // Nano Banana 2
  openai: 'gpt-image-2',
};

const TEXT_KEYS = TEXT_PROVIDERS.map((p) => p.key);
const TEXT_MAP = TEXT_PROVIDERS.reduce((m, p) => ((m[p.key] = p), m), {});

function providerLabel(key) {
  return (TEXT_MAP[key] && TEXT_MAP[key].label) || key;
}

module.exports = { TEXT_PROVIDERS, IMAGE_PROVIDERS, IMAGE_MODELS, TEXT_KEYS, TEXT_MAP, providerLabel };
