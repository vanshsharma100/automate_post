import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Field, Input, Select, Textarea, Segmented, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, Loading } from '../components/common.jsx';

export function Brain() {
  const [tab, setTab] = useState('routing');
  return (
    <div className="page">
      <PageHeader title="The Brain" sub="Bring your own keys. Route each job to the right model, with automatic fallback." icon="brain" />
      <div className="pill-tabs">
        {[['providers', 'Providers'], ['routing', 'Model routing'], ['playground', 'Playground']].map(([k, l]) => (
          <button key={k} className={cx(tab === k && 'active')} onClick={() => setTab(k)}>{l}</button>
        ))}
      </div>
      {tab === 'providers' && <Providers />}
      {tab === 'routing' && <Routing />}
      {tab === 'playground' && <Playground />}
    </div>
  );
}

function Providers() {
  const { data, loading, reload } = useAsync(() => api.get('/brain/providers').then((r) => r.data));
  const [adding, setAdding] = useState(false);
  const [keyFor, setKeyFor] = useState(null);
  if (loading) return <Loading rows={3} />;
  return (
    <div>
      <div className="row between" style={{ marginBottom: 14 }}>
        <p className="muted small">API keys are encrypted at rest (AES-256-GCM). Without a key, that provider runs in simulation.</p>
        <Button icon="plus" onClick={() => setAdding(true)}>Add provider</Button>
      </div>
      <div className="grid grid-2">
        {data.map((p) => (
          <Card key={p.id} className="card-pad">
            <div className="row between">
              <div className="row gap-8"><Icon name="brain" size={16} /><b>{p.label}</b><Badge>{p.kind}</Badge></div>
              <Badge variant={p.hasKey && !p.validationError ? 'success' : p.validationError ? 'warning' : ''} dot>{p.hasKey ? (p.validationError ? 'unverified' : 'live') : 'simulation'}</Badge>
            </div>
            <div className="row between mt-16">
              <span className="mono small dim">{p.hasKey ? p.keyPreview : 'no key set'}</span>
              <span className="tiny dim">{p.modelCount} models</span>
            </div>
            {p.validationError && <div className="tiny muted mt-8">{p.validationError}</div>}
            <div className="row gap-6 mt-16">
              <Button size="sm" icon="key" onClick={() => setKeyFor(p)}>{p.hasKey ? 'Rotate key' : 'Add key'}</Button>
              <Button size="sm" variant="ghost" icon="refresh" onClick={async () => { toast('Syncing models…'); try { const r = await api.post(`/brain/providers/${p.id}/sync`); toast.success('Synced', `${r.data.count} models`); reload(); } catch (e) { toast.error('Sync failed', e.message); } }}>Sync models</Button>
              <Button size="sm" variant="ghost" onClick={async () => { if (confirm(`Delete ${p.label}?`)) { await api.del(`/brain/providers/${p.id}`); reload(); } }}><Icon name="trash" size={14} /></Button>
            </div>
          </Card>
        ))}
      </div>
      {adding && <ProviderModal onClose={() => setAdding(false)} onSaved={() => { setAdding(false); reload(); }} />}
      {keyFor && <KeyModal provider={keyFor} onClose={() => setKeyFor(null)} onSaved={() => { setKeyFor(null); reload(); }} />}
    </div>
  );
}

function ProviderModal({ onClose, onSaved }) {
  const { enums } = useApp();
  const [kind, setKind] = useState('ANTHROPIC');
  const [label, setLabel] = useState('');
  const [apiKey, setApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const needsBase = kind === 'OPENAI_COMPATIBLE' || kind === 'CUSTOM_HTTP' || kind === 'AZURE_OPENAI';
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="modal-head"><h3 style={{ fontSize: 15 }}>Add provider</h3><Button variant="ghost" onClick={onClose}><Icon name="x" size={16} /></Button></div>
        <div className="modal-body">
          <Field label="Provider type"><Select value={kind} onChange={(e) => setKind(e.target.value)}>{(enums.ProviderKind || []).map((k) => <option key={k}>{k}</option>)}</Select></Field>
          <Field label="Label" hint="e.g. “My Anthropic key”, “OpenRouter”"><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          {needsBase && <Field label="Base URL"><Input mono value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://openrouter.ai/api/v1" /></Field>}
          <Field label="API key" hint="Encrypted at rest, never returned in full."><Input mono type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" /></Field>
        </div>
        <div className="modal-foot"><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api.post('/brain/providers', { kind, label: label || kind, apiKey, baseUrl }); toast.success('Provider added'); onSaved(); } catch (e) { toast.error('Failed', e.message); setBusy(false); } }}>Add</Button></div>
      </div>
    </div>
  );
}

function KeyModal({ provider, onClose, onSaved }) {
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal"><div className="modal-head"><h3 style={{ fontSize: 15 }}>{provider.hasKey ? 'Rotate' : 'Add'} key — {provider.label}</h3><Button variant="ghost" onClick={onClose}><Icon name="x" size={16} /></Button></div>
        <div className="modal-body">
          <Field label="API key" hint="Stored encrypted. Add your real key to route this provider's roles to live models."><Input mono type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} placeholder="sk-…" autoFocus /></Field>
        </div>
        <div className="modal-foot"><Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="primary" loading={busy} disabled={!apiKey} onClick={async () => { setBusy(true); try { await api.patch(`/brain/providers/${provider.id}`, { apiKey }); const r = await api.post(`/brain/providers/${provider.id}/validate`); toast[r.data.ok ? 'success' : 'error'](r.data.ok ? 'Key saved & validated' : 'Saved, but validation failed', r.data.error || `${r.data.count} models`); onSaved(); } catch (e) { toast.error('Failed', e.message); setBusy(false); } }}>Save & validate</Button></div>
      </div>
    </div>
  );
}

function Routing() {
  const { data, loading, reload } = useAsync(async () => {
    const [profiles, models] = await Promise.all([api.get('/brain/profiles'), api.get('/brain/models?available=true')]);
    return { profiles: profiles.data, models: models.data };
  });
  const [bindings, setBindings] = useState(null);
  const [busy, setBusy] = useState(false);
  React.useEffect(() => { if (data) { const p = data.profiles.find((x) => x.isDefault) || data.profiles[0]; setBindings(p?.bindings || []); } }, [data]);
  if (loading || !bindings) return <Loading rows={5} />;

  const profile = data.profiles.find((x) => x.isDefault) || data.profiles[0];
  const textModels = data.models.filter((m) => m.modality === 'TEXT');
  const imageModels = data.models.filter((m) => m.modality === 'IMAGE');
  const ROLES = ['IDEATION', 'KEYWORD', 'DRAFT', 'HUMANIZE', 'SEO_AUDIT', 'IMAGE_PROMPT', 'IMAGE_GEN', 'VISION_QA', 'POLICY'];
  const byRole = Object.fromEntries(bindings.map((b) => [b.role, b]));
  const modelName = (id) => data.models.find((m) => m.id === id)?.displayName || '—';
  const priceOf = (id) => { const m = data.models.find((x) => x.id === id); return m?.outputPricePerM ? `$${m.outputPricePerM}/M out` : m?.imagePriceEach ? `$${m.imagePriceEach}/img` : ''; };

  function setBinding(role, field, value) {
    const exists = bindings.find((b) => b.role === role);
    if (exists) setBindings(bindings.map((b) => (b.role === role ? { ...b, [field]: value } : b)));
    else setBindings([...bindings, { role, modelId: field === 'modelId' ? value : '', [field]: value }]);
  }

  async function applyPreset(preset) { setBusy(true); try { await api.patch(`/brain/profiles/${profile.id}`, { preset }); toast.success(`Applied "${preset}" preset`); await reload(); } catch (e) { toast.error('Failed', e.message); } setBusy(false); }
  async function save() { setBusy(true); try { await api.put(`/brain/profiles/${profile.id}/bindings`, { bindings: bindings.filter((b) => b.modelId) }); toast.success('Routing saved'); await reload(); } catch (e) { toast.error('Failed', e.message); } setBusy(false); }

  return (
    <div>
      <div className="row between wrap gap-8" style={{ marginBottom: 14 }}>
        <div className="row gap-8"><Badge variant="accent">{profile?.name}</Badge><span className="muted small">Each role → a model + a fallback. Presets resolve against your live catalogue.</span></div>
        <div className="row gap-8">
          <div className="seg"><button onClick={() => applyPreset('max')} disabled={busy}>Max quality</button><button onClick={() => applyPreset('balanced')} disabled={busy}>Balanced</button><button onClick={() => applyPreset('budget')} disabled={busy}>Budget</button></div>
          <Button variant="primary" loading={busy} onClick={save}>Save routing</Button>
        </div>
      </div>
      <Card>
        <table className="table">
          <thead><tr><th>Role</th><th>Model</th><th>Fallback</th><th>Effort</th><th className="right">Price</th></tr></thead>
          <tbody>
            {ROLES.map((role) => {
              const b = byRole[role] || {};
              const pool = role === 'IMAGE_GEN' ? imageModels : textModels;
              return (
                <tr key={role}>
                  <td><b className="small mono">{role}</b></td>
                  <td><Select value={b.modelId || ''} onChange={(e) => setBinding(role, 'modelId', e.target.value)} style={{ minWidth: 190 }}><option value="">— none —</option>{pool.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</Select></td>
                  <td><Select value={b.fallbackModelId || ''} onChange={(e) => setBinding(role, 'fallbackModelId', e.target.value)} style={{ minWidth: 160 }}><option value="">— none —</option>{pool.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}</Select></td>
                  <td><Select value={b.effort || 'low'} onChange={(e) => setBinding(role, 'effort', e.target.value)} style={{ width: 90 }}>{['low', 'medium', 'high', 'xhigh', 'max'].map((x) => <option key={x}>{x}</option>)}</Select></td>
                  <td className="right mono tiny dim">{priceOf(b.modelId)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Playground() {
  const [role, setRole] = useState('DRAFT');
  const [input, setInput] = useState('Write a punchy hook about upgrading to an NVMe SSD.');
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState(null);
  const ROLES = ['IDEATION', 'KEYWORD', 'DRAFT', 'HUMANIZE', 'SEO_AUDIT', 'IMAGE_PROMPT', 'POLICY'];
  async function run() { setBusy(true); setRes(null); try { const r = await api.post('/brain/test', { role, input }); setRes(r); } catch (e) { toast.error('Failed', e.message); } setBusy(false); }
  return (
    <div className="grid grid-2" style={{ gridTemplateColumns: '1fr 1fr' }}>
      <Card className="card-pad">
        <Field label="Role"><Select value={role} onChange={(e) => setRole(e.target.value)}>{ROLES.map((r) => <option key={r}>{r}</option>)}</Select></Field>
        <Field label="Input"><Textarea value={input} onChange={(e) => setInput(e.target.value)} style={{ minHeight: 160 }} /></Field>
        <Button variant="primary" icon="play" loading={busy} onClick={run}>Run</Button>
      </Card>
      <Card className="card-pad">
        <div className="card-title" style={{ marginBottom: 12 }}>Result</div>
        {!res ? <div className="empty" style={{ padding: 30 }}><div className="em-ico">◇</div><div className="small">Run a role to see the resolved model, output, tokens and cost.</div></div> :
          <div>
            <div className="row gap-8 wrap" style={{ marginBottom: 12 }}>
              <Badge variant="accent">{res.resolvedModel?.displayName || res.model}</Badge>
              <Badge>{res.provider}</Badge>
              {res.simulated && <Badge variant="warning">simulated</Badge>}
              <Badge>{fmt.int(res.usage?.inputTokens)}→{fmt.int(res.usage?.outputTokens)} tok</Badge>
              <Badge>{fmt.money(res.costUsd)}</Badge>
            </div>
            <div className="card card-pad" style={{ background: 'var(--surface-2)', whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.6, maxHeight: 320, overflowY: 'auto' }}>{res.output}</div>
          </div>}
      </Card>
    </div>
  );
}
