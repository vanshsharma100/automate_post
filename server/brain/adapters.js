// Provider adapters (doc 03 §2–3). Each speaks its vendor's wire shape behind a
// single interface. Real HTTP calls fire when the provider has a decrypted key;
// otherwise the caller falls back to deterministic simulation so the whole
// pipeline still runs on a fresh install with zero keys.
import { decryptSecret } from '../crypto.js';
import seedModels from './seed-models.json' with { type: 'json' };

const TIMEOUT_MS = 45000;

async function fetchJson(url, opts = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), opts.timeout || TIMEOUT_MS);
  try {
    const res = await fetch(url, { ...opts, signal: ctrl.signal });
    const text = await res.text();
    let json;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const err = new Error(json?.error?.message || json?.message || `HTTP ${res.status}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  } finally {
    clearTimeout(t);
  }
}

// Build a concrete adapter for a stored provider row + its tenant (for decrypt).
export function getAdapter(provider, tenant) {
  const key = provider.apiKeyEnc ? safeDecrypt(tenant, provider.apiKeyEnc) : '';
  const kind = provider.kind;
  const baseUrl = provider.baseUrl || defaultBaseUrl(kind);
  const hasKey = !!key || kind === 'CUSTOM_HTTP';

  return {
    kind,
    hasKey,
    async validate() {
      if (!hasKey) return { ok: false, error: 'no API key set' };
      try {
        const models = await this.listModels();
        return { ok: true, modelCount: models.length };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    },
    async listModels() {
      if (!hasKey) return seedFor(kind);
      try {
        return await listModelsLive(kind, key, baseUrl);
      } catch {
        return seedFor(kind); // graceful fallback to seed catalogue
      }
    },
    async generate(req) {
      if (!hasKey) throw new Error('no live key');
      return generateLive(kind, key, baseUrl, req);
    },
    async generateImage(req) {
      if (!hasKey) throw new Error('no live key');
      return generateImageLive(kind, key, baseUrl, req);
    },
  };
}

function safeDecrypt(tenant, enc) {
  try { return decryptSecret(tenant, enc); } catch { return ''; }
}

function defaultBaseUrl(kind) {
  switch (kind) {
    case 'ANTHROPIC': return 'https://api.anthropic.com';
    case 'OPENAI': return 'https://api.openai.com/v1';
    case 'GOOGLE': return 'https://generativelanguage.googleapis.com/v1beta';
    default: return '';
  }
}

export function seedFor(kind) {
  const list = seedModels[kind] || seedModels.OPENAI_COMPATIBLE || [];
  return list.map((m) => ({ ...m, source: 'seed' }));
}

// ── Live model catalogues ────────────────────────────────────────────────────
async function listModelsLive(kind, key, baseUrl) {
  if (kind === 'ANTHROPIC') {
    const json = await fetchJson(`${baseUrl}/v1/models`, {
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    });
    return (json.data || []).map((m) => ({
      modelId: m.id, displayName: m.display_name || m.id, modality: 'TEXT',
      capabilities: { json: true, vision: true }, source: 'api',
    }));
  }
  if (kind === 'OPENAI' || kind === 'OPENAI_COMPATIBLE' || kind === 'AZURE_OPENAI') {
    const json = await fetchJson(`${baseUrl}/models`, { headers: { Authorization: `Bearer ${key}` } });
    return (json.data || []).map((m) => ({
      modelId: m.id, displayName: m.id,
      modality: /image|dall|imagen/i.test(m.id) ? 'IMAGE' : 'TEXT',
      capabilities: {}, source: 'api',
    }));
  }
  if (kind === 'GOOGLE') {
    const json = await fetchJson(`${baseUrl}/models?key=${encodeURIComponent(key)}`);
    return (json.models || []).map((m) => ({
      modelId: (m.name || '').replace('models/', ''), displayName: m.displayName || m.name,
      modality: /image|imagen/i.test(m.name) ? 'IMAGE' : 'TEXT',
      contextWindow: m.inputTokenLimit, maxOutput: m.outputTokenLimit,
      capabilities: { methods: m.supportedGenerationMethods || [] }, source: 'api',
    }));
  }
  return seedFor(kind);
}

// ── Live text generation ─────────────────────────────────────────────────────
async function generateLive(kind, key, baseUrl, req) {
  const started = Date.now();
  if (kind === 'ANTHROPIC') {
    const json = await fetchJson(`${baseUrl}/v1/messages`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        max_tokens: req.maxTokens || 2000,
        system: req.system || undefined,
        messages: [{ role: 'user', content: req.prompt }],
        temperature: req.temperature ?? 0.7,
      }),
    });
    const text = (json.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { text, usage: { inputTokens: json.usage?.input_tokens || 0, outputTokens: json.usage?.output_tokens || 0 }, model: json.model || req.model, latencyMs: Date.now() - started, raw: json };
  }
  if (kind === 'OPENAI' || kind === 'OPENAI_COMPATIBLE' || kind === 'AZURE_OPENAI') {
    const json = await fetchJson(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: req.model,
        messages: [
          ...(req.system ? [{ role: 'system', content: req.system }] : []),
          { role: 'user', content: req.prompt },
        ],
        temperature: req.temperature ?? 0.7,
        max_tokens: req.maxTokens || 2000,
        ...(req.jsonSchema ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    const text = json.choices?.[0]?.message?.content || '';
    return { text, usage: { inputTokens: json.usage?.prompt_tokens || 0, outputTokens: json.usage?.completion_tokens || 0 }, model: json.model || req.model, latencyMs: Date.now() - started, raw: json };
  }
  if (kind === 'GOOGLE') {
    const json = await fetchJson(`${baseUrl}/models/${req.model}:generateContent?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: req.system ? { parts: [{ text: req.system }] } : undefined,
        contents: [{ role: 'user', parts: [{ text: req.prompt }] }],
        generationConfig: {
          temperature: req.temperature ?? 0.7,
          maxOutputTokens: req.maxTokens || 2000,
          ...(req.jsonSchema ? { responseMimeType: 'application/json' } : {}),
        },
      }),
    });
    const text = (json.candidates?.[0]?.content?.parts || []).map((p) => p.text).join('');
    const um = json.usageMetadata || {};
    return { text, usage: { inputTokens: um.promptTokenCount || 0, outputTokens: um.candidatesTokenCount || 0 }, model: req.model, latencyMs: Date.now() - started, raw: json };
  }
  throw new Error(`generate not implemented for ${kind}`);
}

async function generateImageLive(kind, key, baseUrl, req) {
  if (kind === 'OPENAI') {
    const json = await fetchJson(`${baseUrl}/images/generations`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: req.model || 'gpt-image-1', prompt: req.prompt, size: req.size || '1024x1024', n: 1 }),
    });
    const b64 = json.data?.[0]?.b64_json;
    return { images: [{ dataUrl: b64 ? `data:image/png;base64,${b64}` : null, revisedPrompt: json.data?.[0]?.revised_prompt }], model: req.model };
  }
  throw new Error(`image generation not implemented for ${kind}`);
}
