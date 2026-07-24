import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Field, Input, Textarea, Select, useAsync, cx, toast } from '../ui.jsx';
import { PageHeader, Loading, PlatformTag } from '../components/common.jsx';

const SCOPE_LABEL = { BRAIN_GLOBAL: 'Brain global', PLATFORM: 'Per-platform', CONNECTION: 'Per-connection', PRODUCT_RULES: 'Topic bank', BRAND_VOICE: 'Brand voice' };
const SCOPE_ORDER = ['BRAIN_GLOBAL', 'PLATFORM', 'CONNECTION', 'PRODUCT_RULES', 'BRAND_VOICE'];

export function Knowledge() {
  const { platformMeta } = useApp();
  const { data, loading, reload } = useAsync(async () => {
    const [kb, bv, conns] = await Promise.all([api.get('/knowledge'), api.get('/brand-voices'), api.get('/connections')]);
    return { kb: kb.data, bv: bv.data, conns: conns.data };
  });
  const [selId, setSelId] = useState(null);
  const [adding, setAdding] = useState('');
  if (loading) return <div className="page"><PageHeader title="Knowledge" /><Loading rows={4} /></div>;

  const items = [...data.kb.map((k) => ({ ...k, _type: 'kb' })), ...data.bv.map((v) => ({ ...v, _type: 'bv', scope: 'BRAND_VOICE', title: v.name }))];
  const sel = items.find((i) => i.id === selId) || items[0];
  const groups = {};
  items.forEach((i) => (groups[i.scope] ||= []).push(i));

  // Platforms you actually publish to that have no section of their own yet.
  const connected = [...new Set(data.conns.map((c) => c.platform))];
  const haveSection = new Set((groups.PLATFORM || []).map((k) => k.platform));
  const missing = connected.filter((p) => !haveSection.has(p));

  async function addPlatform(platform) {
    setAdding(platform);
    try {
      const r = await api.post(`/knowledge/platform/${platform}`);
      toast.success(r.created ? 'Section created' : 'Section already existed', `${platformMeta[platform]?.label} now has its own brain.`);
      setSelId(r.data.id);
      reload();
    } catch (e) { toast.error('Failed', e.message); }
    setAdding('');
  }

  return (
    <div className="page">
      <PageHeader title="Knowledge" sub="What the brain knows about you. Every platform gets its own section — specific “never do” rules are where quality actually comes from." icon="knowledge" />
      <div className="grid" style={{ gridTemplateColumns: '280px 1fr', alignItems: 'start' }}>
        <Card>
          {SCOPE_ORDER.filter((s) => groups[s]?.length).map((scope) => (
            <div key={scope}>
              <div className="nav-section-label">{SCOPE_LABEL[scope] || scope}</div>
              {groups[scope].map((i) => (
                <div key={i.id} className={cx('nav-item', (sel?.id === i.id) && 'active')} onClick={() => setSelId(i.id)} style={{ margin: '0 6px' }}>
                  {i.scope === 'PLATFORM' && i.platform
                    ? <span className="ico" style={{ display: 'grid', placeItems: 'center', width: 15 }}><PlatformTag platform={i.platform} showLabel={false} size={9} /></span>
                    : <Icon name={i._type === 'bv' ? 'sparkles' : 'knowledge'} size={15} className="ico" />}
                  <span className="small" style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{i.title}</span>
                  {i.version > 1 && <span className="nav-badge">v{i.version}</span>}
                </div>
              ))}
            </div>
          ))}

          {missing.length > 0 && (
            <>
              <div className="nav-section-label">Add a platform section</div>
              <div className="col gap-4" style={{ padding: '0 6px 8px' }}>
                {missing.map((p) => (
                  <Button key={p} size="sm" variant="ghost" icon="plus" loading={adding === p} onClick={() => addPlatform(p)} style={{ justifyContent: 'flex-start' }}>
                    {platformMeta[p]?.label || p}
                  </Button>
                ))}
              </div>
            </>
          )}
        </Card>
        {sel && (sel._type === 'bv' ? <BrandVoiceEditor key={sel.id} voice={sel} onSaved={reload} /> : <KnowledgeEditor key={sel.id} kb={sel} platformMeta={platformMeta} onSaved={reload} />)}
      </div>
    </div>
  );
}

function ListEditor({ label, placeholder, items, onChange, accent }) {
  return (
    <Field label={label}>
      <div className="col gap-6">
        {(items || []).map((it, i) => (
          <div key={i} className="row gap-6">
            <span style={{ color: accent ? 'var(--danger)' : 'var(--success)', width: 14 }}>{accent ? '✕' : '✓'}</span>
            <Input value={it} onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))} />
            <Button size="sm" variant="ghost" onClick={() => onChange(items.filter((_, j) => j !== i))}><Icon name="x" size={13} /></Button>
          </div>
        ))}
        <Button size="sm" variant="ghost" icon="plus" onClick={() => onChange([...(items || []), ''])} style={{ alignSelf: 'flex-start' }}>{placeholder}</Button>
      </div>
    </Field>
  );
}

function KnowledgeEditor({ kb, platformMeta, onSaved }) {
  const [d, setD] = useState(kb);
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.patch(`/knowledge/${kb.id}`, { title: d.title, content: d.content, doRules: (d.doRules || []).filter(Boolean), dontRules: (d.dontRules || []).filter(Boolean), examples: (d.examples || []).filter(Boolean) }); toast.success('Saved', `Version bumped to v${(kb.version || 1) + 1}`); onSaved(); } catch (e) { toast.error('Failed', e.message); } setBusy(false); }

  const scopeNote = {
    BRAIN_GLOBAL: 'Applies to every platform. Platform sections stack on top of this and win on conflict.',
    PLATFORM: `Applies to every ${platformMeta?.[d.platform]?.label || 'platform'} account. Stacks on top of the global brain.`,
    CONNECTION: 'Applies to this one account only. The most specific layer — it wins over everything.',
    PRODUCT_RULES: 'Topic bank the ideation step draws from.',
  }[d.scope];

  return (
    <Card className="card-pad">
      <div className="row between" style={{ marginBottom: 12 }}>
        <div className="row gap-8">
          <Badge>{SCOPE_LABEL[d.scope]}</Badge>
          {d.scope === 'PLATFORM' && d.platform && <PlatformTag platform={d.platform} />}
          <Badge variant="">v{d.version}</Badge>
        </div>
        <Button variant="primary" loading={busy} onClick={save}>Save (new version)</Button>
      </div>
      {scopeNote && <div className="card card-pad small muted" style={{ background: 'var(--surface-2)', marginBottom: 14 }}><Icon name="knowledge" size={14} /> {scopeNote}</div>}
      <Field label="Title"><Input value={d.title} onChange={(e) => setD({ ...d, title: e.target.value })} /></Field>
      <Field label="Description" hint="Free markdown: what a good post here contains."><Textarea value={d.content} onChange={(e) => setD({ ...d, content: e.target.value })} style={{ minHeight: 120 }} /></Field>
      <ListEditor label="Always do" placeholder="Add a rule" items={d.doRules} onChange={(v) => setD({ ...d, doRules: v })} />
      <ListEditor label="Never do" placeholder="Add a prohibition" items={d.dontRules} onChange={(v) => setD({ ...d, dontRules: v })} accent />
      <ListEditor label="Examples (few-shot)" placeholder="Add an example" items={d.examples} onChange={(v) => setD({ ...d, examples: v })} />
      <div className="tiny dim mt-8">All three lists are sent to the model with every generation, alongside the description.</div>
    </Card>
  );
}

function BrandVoiceEditor({ voice, onSaved }) {
  const [d, setD] = useState(voice);
  const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { await api.patch(`/brand-voices/${voice.id}`, { name: d.name, toneAttributes: d.toneAttributes, readingLevel: +d.readingLevel, personPov: d.personPov, bannedPhrases: (d.bannedPhrases || []).filter(Boolean), emojiPolicy: d.emojiPolicy, ctaStyle: d.ctaStyle }); toast.success('Brand voice saved'); onSaved(); } catch (e) { toast.error('Failed', e.message); } setBusy(false); }
  return (
    <Card className="card-pad">
      <div className="row between" style={{ marginBottom: 12 }}><div className="row gap-8"><Icon name="sparkles" size={16} /><Badge variant="accent">Brand voice</Badge></div><Button variant="primary" loading={busy} onClick={save}>Save</Button></div>
      <Field label="Name"><Input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} /></Field>
      <div className="grid grid-2" style={{ gap: 14 }}>
        <Field label="Tone (comma-separated)"><Input value={(d.toneAttributes || []).join(', ')} onChange={(e) => setD({ ...d, toneAttributes: e.target.value.split(',').map((s) => s.trim()).filter(Boolean) })} /></Field>
        <Field label="Reading level (grade)"><Input type="number" value={d.readingLevel} onChange={(e) => setD({ ...d, readingLevel: e.target.value })} /></Field>
        <Field label="Point of view"><Select value={d.personPov} onChange={(e) => setD({ ...d, personPov: e.target.value })}><option value="first_plural">We / us</option><option value="first_singular">I / me</option><option value="third">Third person</option></Select></Field>
        <Field label="Emoji policy"><Select value={d.emojiPolicy} onChange={(e) => setD({ ...d, emojiPolicy: e.target.value })}><option>none</option><option>sparing</option><option>liberal</option></Select></Field>
      </div>
      <ListEditor label="Banned phrases (AI-tells)" placeholder="Add a banned phrase" items={d.bannedPhrases} onChange={(v) => setD({ ...d, bannedPhrases: v })} accent />
      <Field label="CTA style"><Input value={d.ctaStyle || ''} onChange={(e) => setD({ ...d, ctaStyle: e.target.value })} /></Field>
    </Card>
  );
}
