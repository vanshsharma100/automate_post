import React, { useState, useEffect } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, StatusBadge, Field, Input, Textarea, Select, Segmented, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, PlatformTag, Loading } from '../components/common.jsx';
import { PlatformPreview } from '../components/PlatformPreview.jsx';
import { SeoPanel } from '../components/SeoPanel.jsx';

export function Composer() {
  const { route } = useApp();
  return route.param ? <Editor key={route.param} id={route.param} /> : <Launcher />;
}

// Manual image/video upload for a post, shared by the composer. Real bytes go
// to the server, which serves them back and hands them to the connectors.
const ACCEPT = 'image/jpeg,image/png,image/gif,image/webp,video/mp4,video/quicktime,video/webm';
const IMG_ONLY = { LINKEDIN: false, FACEBOOK: false, INSTAGRAM: true, GOOGLE_BUSINESS: true, SHOPIFY_BLOG: false };

function MediaManager({ postId, platform, media = [], caps, onChange }) {
  const fileRef = React.useRef(null);
  const [busy, setBusy] = useState(false);
  const items = (media || []).filter((m) => !m.purgedAt);
  const maxImages = caps?.media?.images?.max ?? 10;
  const igNeedsImage = platform === 'INSTAGRAM' && items.length === 0;

  async function upload(file) {
    if (!file) return;
    setBusy(true);
    try {
      const res = await api.upload(`/media/upload?postId=${encodeURIComponent(postId)}&altText=${encodeURIComponent(file.name)}`, file);
      toast.success('Media added', `${res.data.kind.toLowerCase()} · ${fmt.bytes(res.data.bytes)}`);
      onChange();
    } catch (e) { toast.error('Upload failed', e.message); }
    setBusy(false);
    if (fileRef.current) fileRef.current.value = '';
  }
  async function remove(m) {
    try { await api.del(`/media/${m.id}`); toast.success('Removed'); onChange(); } catch (e) { toast.error('Failed', e.message); }
  }

  return (
    <div>
      <div className="row between" style={{ marginBottom: 8 }}>
        <span className="card-title">Media <span className="tiny dim">({items.length}{maxImages ? `/${maxImages}` : ''})</span></span>
        <input ref={fileRef} type="file" accept={ACCEPT} style={{ display: 'none' }} onChange={(e) => upload(e.target.files?.[0])} />
        <Button size="sm" variant="ghost" icon="plus" loading={busy} disabled={items.length >= maxImages} onClick={() => fileRef.current?.click()}>Add image / video</Button>
      </div>

      {igNeedsImage && <div className="tiny mt-8" style={{ color: 'var(--warning)' }}>Instagram can't post text alone — add an image before publishing.</div>}

      {items.length === 0 ? (
        <div className="tiny dim">No media yet. {IMG_ONLY[platform] ? 'This platform needs an image.' : 'Optional for this platform.'}</div>
      ) : (
        <div className="col gap-8">
          {items.map((m) => (
            <div key={m.id} className="row gap-8" style={{ alignItems: 'center', padding: 8, border: '1px solid var(--border)', borderRadius: 8 }}>
              <div style={{ width: 54, height: 54, borderRadius: 6, overflow: 'hidden', flexShrink: 0, background: 'var(--surface-2)', display: 'grid', placeItems: 'center' }}>
                {m.kind === 'VIDEO'
                  ? <Icon name="play" size={18} className="dim" />
                  : m.publicUrl ? <img src={m.publicUrl} alt={m.altText || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                  : <Icon name="media" size={18} className="dim" />}
              </div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="row gap-6"><Badge>{m.kind}</Badge><span className="tiny dim">{fmt.bytes(m.bytes)}{m.width ? ` · ${m.width}×${m.height}` : ''}</span>{m.source === 'UPLOAD' && <Badge variant="success">uploaded</Badge>}</div>
                <AltEditor asset={m} />
              </div>
              <Button size="sm" variant="ghost" onClick={() => remove(m)}><Icon name="trash" size={13} /></Button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AltEditor({ asset }) {
  const [v, setV] = useState(asset.altText || '');
  const [saved, setSaved] = useState(true);
  return (
    <Input value={v} placeholder="Alt text / caption" style={{ marginTop: 4, fontSize: 12, height: 28 }}
      onChange={(e) => { setV(e.target.value); setSaved(false); }}
      onBlur={async () => { if (saved) return; try { await api.patch(`/media/${asset.id}`, { altText: v }); setSaved(true); } catch { /* ignore */ } }} />
  );
}

function seoFromPost(p) {
  const checks = p.seoReport || [];
  const applicable = checks.filter((c) => c.applicable);
  return { score: p.seoScore, checks, wordCount: p.wordCount, readability: p.readabilityGrade, passedCount: applicable.filter((c) => c.pass).length, applicableCount: applicable.length };
}

function Launcher() {
  const { navigate } = useApp();
  const { data, loading } = useAsync(async () => {
    const [conns, posts, providers] = await Promise.all([api.get('/connections'), api.get('/posts?status=NEEDS_REVIEW&limit=8'), api.get('/brain/providers')]);
    return { conns: conns.data, posts: posts.data, providers: providers.data };
  });
  const [conn, setConn] = useState('');
  const [category, setCategory] = useState('KNOWLEDGE');
  const [busy, setBusy] = useState(false);
  useEffect(() => { if (data && !conn) setConn(data.conns[0]?.id || ''); }, [data]);
  if (loading) return <div className="page"><PageHeader title="Composer" /><Loading rows={3} /></div>;

  const hasKey = (data.providers || []).some((p) => p.hasKey);
  const noConns = data.conns.length === 0;
  const blocked = !hasKey || noConns;

  async function generate() {
    setBusy(true);
    try { const r = await api.post('/posts/generate', { connectionId: conn, category }); toast.success('Generated', `SEO ${r.data.seoScore} · ${r.data.status.replace('_', ' ')}`); navigate(`/composer/${r.data.id}`); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }

  return (
    <div className="page">
      <PageHeader title="Composer" sub="Generate a platform-native draft, or open one to edit." icon="composer" />
      {!hasKey && (
        <Card className="card-pad" style={{ maxWidth: 640, marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}>
          <div className="row between"><div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="brain" size={16} /><b>Add an AI provider key to generate</b></div><Button size="sm" onClick={() => navigate('/brain')}>Open Brain</Button></div>
          <div className="tiny muted mt-8">Content is written by a live model — add your Anthropic, OpenAI, or Google key in Brain → Providers.</div>
        </Card>
      )}
      {noConns && (
        <Card className="card-pad" style={{ maxWidth: 640, marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}>
          <div className="row between"><div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="connections" size={16} /><b>Connect a platform first</b></div><Button size="sm" onClick={() => navigate('/connections')}>Connections</Button></div>
        </Card>
      )}
      <Card className="card-pad" style={{ maxWidth: 640 }}>
        <div className="card-title" style={{ marginBottom: 14 }}>New post</div>
        <Field label="Connection"><Select value={conn} onChange={(e) => setConn(e.target.value)} disabled={noConns}>{noConns ? <option>No connections yet</option> : data.conns.map((c) => <option key={c.id} value={c.id}>{c.label} ({c.meta?.label})</option>)}</Select></Field>
        <Field label="Post type" hint="Product posts inject real Shopify facts; knowledge posts draw from your topic bank.">
          <Segmented options={[{ value: 'PRODUCT', label: 'Product' }, { value: 'KNOWLEDGE', label: 'IT / Knowledge' }]} value={category} onChange={setCategory} accent />
        </Field>
        <Button variant="primary" icon="sparkles" loading={busy} disabled={blocked} onClick={generate}>Generate through the 8-stage pipeline</Button>
      </Card>

      {data.posts.length > 0 && <Card className="mt-24">
        <CardHead title="Awaiting review" sub={`${data.posts.length} drafts`} />
        {data.posts.map((p) => (
          <div key={p.id} className="row between click" style={{ padding: '11px 18px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => navigate(`/composer/${p.id}`)}>
            <div className="row gap-16"><PlatformTag platform={p.platform} showLabel={false} /><span className="small">{p.title}</span></div>
            <Badge>SEO {p.seoScore}</Badge>
          </div>
        ))}
      </Card>}
    </div>
  );
}

function Editor({ id }) {
  const { navigate } = useApp();
  const { data, loading, reload } = useAsync(() => api.get(`/posts/${id}/preview`).then((r) => r.data));
  const [p, setP] = useState(null);
  const [seo, setSeo] = useState(null);
  const [busy, setBusy] = useState('');
  const [dirty, setDirty] = useState(false);
  useEffect(() => { if (data) { setP(data.post); setSeo(seoFromPost(data.post)); setDirty(false); } }, [data]);
  if (loading || !p) return <div className="page"><PageHeader title="Composer" /><Loading rows={4} /></div>;

  const platform = data.platform;
  const isBlog = data.meta?.longForm;
  const caps = data.capabilities;
  const set = (patch) => { setP({ ...p, ...patch }); setDirty(true); };

  async function save() {
    setBusy('save');
    try { const r = await api.patch(`/posts/${id}`, { title: p.title, body: p.body, excerpt: p.excerpt, seoTitle: p.seoTitle, seoDescription: p.seoDescription, slug: p.slug, primaryKeyword: p.primaryKeyword, hashtags: p.hashtags, callToAction: p.callToAction }); setP({ ...p, ...r.data }); setSeo(seoFromPost(r.data)); setDirty(false); toast.success('Saved'); }
    catch (e) { toast.error('Failed', e.message); }
    setBusy('');
  }
  async function action(name, fn, label) {
    setBusy(name);
    try { const r = await fn(); if (r?.data) { setP(r.data); if (r.seo) setSeo(seoFromPost(r.data)); } toast.success(label); reload(); }
    catch (e) { toast.error('Failed', e.message); }
    setBusy('');
  }
  // Publish/retry reflects the REAL outcome — the API returns 200 even when the
  // publish itself fails (post marked FAILED), so a blanket "Published" toast
  // would lie. Inspect the returned status/result instead.
  async function publishNow(isRetry) {
    const name = isRetry ? 'retry' : 'pub';
    setBusy(name);
    try {
      const r = await api.post(`/posts/${id}/${isRetry ? 'retry' : 'publish'}`);
      if (r?.data) { setP(r.data); setDirty(false); }
      const res = r.result || {};
      if (r.data?.status === 'PUBLISHED' || res.ok) {
        toast.success(res.simulated ? 'Published (simulated)' : 'Published', r.data.externalUrl || '');
      } else if (res.retryScheduled) {
        toast('Temporary error — will retry', `Rescheduled in ${res.retryScheduled} min.`);
      } else {
        toast.error('Publish failed', res.failed || r.data?.lastError || 'See the post status for details.');
      }
      reload();
    } catch (e) { toast.error('Publish failed', e.message); }
    setBusy('');
  }

  const hashCount = (p.hashtags || []).length;
  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <div className="row between" style={{ marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
        <div className="row gap-16">
          <Button variant="ghost" onClick={() => navigate('/drafts')}><Icon name="chevronR" size={16} style={{ transform: 'rotate(180deg)' }} /> Drafts</Button>
          <PlatformTag platform={platform} /><StatusBadge status={p.status} />
          {p.generationMeta?.simulatedPublish && <Badge variant="warning">sim publish</Badge>}
        </div>
        <div className="row gap-8">
          {dirty && <span className="tiny dim">unsaved</span>}
          <Button loading={busy === 'save'} onClick={save} disabled={!dirty}>Save</Button>
          <Button variant="ghost" loading={busy === 'humanize'} icon="sparkles" onClick={() => action('humanize', () => api.post(`/posts/${id}/humanize`), 'Humanized')}>Humanize</Button>
          <Button variant="ghost" loading={busy === 'seo'} onClick={() => action('seo', () => api.post(`/posts/${id}/seo-audit`).then((r) => ({ data: { ...p, seoReport: r.data.checks, seoScore: r.data.score, wordCount: r.data.wordCount }, seo: true })), 'SEO re-scored')}>Re-run SEO</Button>
          {p.status === 'NEEDS_REVIEW' && <Button variant="primary" loading={busy === 'approve'} onClick={() => action('approve', () => api.post(`/posts/${id}/approve`), 'Approved')}>Approve</Button>}
          {(p.status === 'APPROVED' || p.status === 'NEEDS_REVIEW') && <Button variant="primary" loading={busy === 'pub'} icon="send" onClick={() => publishNow(false)}>Publish now</Button>}
          {p.status === 'FAILED' && <Button variant="danger" icon="refresh" loading={busy === 'retry'} onClick={() => publishNow(true)}>Retry</Button>}
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '1.05fr 1fr 300px', gap: 16, alignItems: 'start' }}>
        {/* Editor */}
        <Card className="card-pad">
          <div className="row between" style={{ marginBottom: 10 }}><div className="card-title">Editor</div>
            <div className="row gap-6"><Button size="sm" variant="ghost" loading={busy === 'regen'} icon="refresh" onClick={() => action('regen', () => api.post(`/posts/${id}/regenerate`, { scope: 'all' }), 'Regenerated')}>Regenerate</Button></div>
          </div>
          <Field label="Title"><Input value={p.title || ''} onChange={(e) => set({ title: e.target.value })} /></Field>
          {isBlog && <>
            <div className="grid grid-2" style={{ gap: 12 }}>
              <Field label={`SEO title · ${(p.seoTitle || '').length}/60`}><Input value={p.seoTitle || ''} onChange={(e) => set({ seoTitle: e.target.value })} /></Field>
              <Field label="Slug"><Input mono value={p.slug || ''} onChange={(e) => set({ slug: e.target.value })} /></Field>
            </div>
            <Field label={`Meta description · ${(p.seoDescription || '').length}/158`}><Textarea value={p.seoDescription || ''} onChange={(e) => set({ seoDescription: e.target.value })} style={{ minHeight: 56 }} /></Field>
          </>}
          <Field label="Primary keyword"><Input value={p.primaryKeyword || ''} onChange={(e) => set({ primaryKeyword: e.target.value })} /></Field>
          <Field label={`Body${caps ? ` · ${(p.body || '').length}/${caps.text.maxChars} chars` : ''}`}><Textarea value={p.body || ''} onChange={(e) => set({ body: e.target.value })} style={{ minHeight: isBlog ? 340 : 200, fontFamily: isBlog ? 'var(--font-mono)' : 'inherit', fontSize: 13 }} /></Field>
          {caps?.hashtags?.supported && <Field label={<span>Hashtags <span className={cx('tiny', hashCount > caps.hashtags.max ? '' : 'dim')} style={hashCount > caps.hashtags.max ? { color: 'var(--danger)' } : {}}>({hashCount}/{caps.hashtags.max})</span></span>}>
            <Input value={(p.hashtags || []).join(' ')} onChange={(e) => set({ hashtags: e.target.value.split(/\s+/).filter(Boolean) })} />
          </Field>}
          {data.validation?.warnings?.length > 0 && <div className="tiny" style={{ color: 'var(--warning)' }}>{data.validation.warnings.join(' · ')}</div>}
          <div className="divider" />
          <MediaManager postId={id} platform={platform} media={data.post.media} caps={caps} onChange={reload} />
        </Card>

        {/* Live preview */}
        <div>
          <div className="row between" style={{ marginBottom: 8 }}><span className="card-title">Live preview</span><span className="tiny dim">{data.account}</span></div>
          <div className="preview-frame"><PlatformPreview platform={platform} post={p} account={data.account} media={data.post.media} /></div>
        </div>

        {/* SEO + actions */}
        <div className="col gap-16">
          <Card className="card-pad"><SeoPanel seo={seo} /></Card>
          <Card className="card-pad">
            <div className="card-title" style={{ marginBottom: 10 }}>Policy</div>
            <Button size="sm" variant="ghost" loading={busy === 'policy'} onClick={() => action('policy', () => api.post(`/posts/${id}/policy-check`).then((r) => ({ data: { ...p, policyReport: r.data } })), 'Policy checked')}>Run policy gate</Button>
            {p.policyReport && <div className="mt-8">{p.policyReport.pass ? <Badge variant="success" dot>passed</Badge> : <Badge variant="danger" dot>{p.policyReport.issues?.length} issues</Badge>}
              {(p.policyReport.issues || []).map((i, k) => <div key={k} className="tiny dim mt-8">· {i.detail}</div>)}</div>}
          </Card>
          {p.status !== 'PUBLISHED' && <Card className="card-pad">
            <div className="card-title" style={{ marginBottom: 8 }}>Schedule</div>
            <div className="row gap-6"><Button size="sm" loading={busy === 'sched'} onClick={() => action('sched', () => api.post(`/posts/${id}/schedule`, {}), 'Scheduled')}>Next slot</Button></div>
            {p.scheduledAt && <div className="tiny dim mt-8">Scheduled {fmt.datetime(p.scheduledAt)}</div>}
          </Card>}
        </div>
      </div>
    </div>
  );
}
