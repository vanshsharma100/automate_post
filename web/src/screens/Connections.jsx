import React, { useState, useEffect } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, StatusDot, StatusBadge, Modal, Field, Input, Select, Toggle, Segmented, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, PlatformTag, ModeSelect, Loading, ConfirmDialog } from '../components/common.jsx';

// Platforms with a dedicated real-connect screen (not the sandbox-only path).
const REAL_SCREEN = { LINKEDIN: '/linkedin', GOOGLE_BUSINESS: '/googlebusiness', FACEBOOK: '/facebook', INSTAGRAM: '/instagram' };

export function Connections() {
  const { platformMeta } = useApp();
  const { data, loading, reload } = useAsync(() => api.get('/connections').then((r) => r.data));
  const [adding, setAdding] = useState(false);
  const [scheduleFor, setScheduleFor] = useState(null);
  const [quotaFor, setQuotaFor] = useState(null);
  const [disconnectC, setDisconnectC] = useState(null);

  // Handle the OAuth callback redirect back to this screen.
  useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected')) { toast.success('Connected', `${p.get('connected')} account linked.`); reload(); }
    else if (p.get('oauth_error')) { toast.error('Connection failed', p.get('oauth_error')); }
    if (p.get('connected') || p.get('oauth_error')) window.history.replaceState({}, '', '/connections');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="page"><PageHeader title="Connections" /><Loading rows={4} /></div>;

  const grouped = {};
  data.forEach((c) => (grouped[c.platform] ||= []).push(c));

  return (
    <div className="page">
      <PageHeader title="Connections" sub="Every platform you publish to. Add as many accounts per platform as you like."
        actions={<Button variant="primary" icon="plus" onClick={() => setAdding(true)}>Add connection</Button>} />

      <div className="col gap-16">
        {Object.entries(grouped).map(([platform, conns]) => (
          <Card key={platform}>
            <CardHead title={<span className="row gap-8"><PlatformTag platform={platform} showLabel={false} size={10} />{platformMeta[platform]?.label}</span>} sub={`${conns.length} account${conns.length > 1 ? 's' : ''}`} />
            {conns.map((c) => (
              <div key={c.id} className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 12 }}>
                <div className="row gap-16" style={{ minWidth: 220 }}>
                  <StatusDot status={c.status} />
                  <div>
                    <div className="row gap-8"><b className="small">{c.label}</b>{c.breakerOpen && <Badge variant="danger" dot>breaker open</Badge>}</div>
                    <div className="tiny dim">{c.externalAccountName || 'not connected'} · {c.scopes?.length ? `${c.scopes.length} scopes` : 'token'}{c.tokenExpiresAt ? ` · expires ${fmt.rel(c.tokenExpiresAt)}` : ''}</div>
                  </div>
                </div>
                <div className="row gap-6 wrap">
                  <StatusBadge status={c.status} />
                  <ModeSelect connection={c} onChange={reload} />
                  <Button size="sm" variant="ghost" icon="calendar" onClick={() => setScheduleFor(c)}>Schedule</Button>
                  <Button size="sm" variant="ghost" icon="layers" onClick={() => setQuotaFor(c)}>Storage</Button>
                  <Button size="sm" variant="ghost" onClick={async () => { const r = await api.post(`/connections/${c.id}/test`); toast.success('Health checked', `Status: ${r.data.status}`); reload(); }}>Test</Button>
                  {c.breakerOpen && <Button size="sm" onClick={async () => { await api.post(`/connections/${c.id}/breaker/reset`); toast.success('Breaker reset'); reload(); }}>Reset breaker</Button>}
                  <Button size="sm" variant="ghost" onClick={() => setDisconnectC(c)}><Icon name="trash" size={14} /></Button>
                </div>
              </div>
            ))}
          </Card>
        ))}
      </div>

      {adding && <AddConnection onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {scheduleFor && <ScheduleModal connection={scheduleFor} onClose={() => setScheduleFor(null)} onSaved={reload} />}
      {quotaFor && <QuotaModal connection={quotaFor} onClose={() => setQuotaFor(null)} onSaved={reload} />}
      {disconnectC && <ConfirmDialog title={`Disconnect ${disconnectC.label}?`} danger confirmLabel="Disconnect"
        body={`This revokes stored credentials for ${disconnectC.label} and stops all publishing to it. History is kept.`}
        onConfirm={async () => { await api.del(`/connections/${disconnectC.id}`); toast.success('Disconnected'); reload(); }}
        onClose={() => setDisconnectC(null)} />}
    </div>
  );
}

function AddConnection({ onClose, onDone }) {
  const { boot, platformMeta } = useApp();
  const [platforms, setPlatforms] = useState(null);
  const [platform, setPlatform] = useState(null);
  const [label, setLabel] = useState('');
  const [cfg, setCfg] = useState({});
  const [busy, setBusy] = useState(false);
  React.useEffect(() => { api.get('/platforms').then((r) => setPlatforms(r.data)); }, []);

  const [oauthErr, setOauthErr] = useState('');
  const { navigate } = useApp();
  const meta = platforms?.find((p) => p.platform === platform);

  async function startOauth() {
    setBusy(true); setOauthErr('');
    try {
      const r = await api.get(`/connections/oauth/${platform}/start?label=${encodeURIComponent(label || meta.label)}`);
      window.location.href = r.data.authUrl;   // redirect to the provider's consent screen
    } catch (e) { setOauthErr(e.message); setBusy(false); }
  }
  async function createSandbox() {
    setBusy(true);
    try { await api.post(`/connections/oauth/${platform}/sandbox`, { label: label || meta.label }); toast.success('Sandbox connection created', 'Publishing is simulated until you connect a live app.'); onDone(); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }
  async function submitTokenConfig() {
    setBusy(true);
    try {
      if (platform === 'CUSTOM_WEBHOOK') {
        await api.post('/connections', { platform, label: label || 'Webhook', config: { url: cfg.url, method: 'POST', template: cfg.template || '{"text":"{{title}}\\n{{body}}"}' }, authHeaderName: cfg.authHeaderName, authHeaderValue: cfg.authHeaderValue });
        toast.success('Webhook connected');
        onDone();
      } else if (platform === 'SHOPIFY_BLOG') {
        onClose(); navigate('/shopify');   // Shopify uses the token-paste flow on its own screen
      }
    } catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }

  const footer = platform && (
    <>
      <Button variant="ghost" onClick={onClose}>Cancel</Button>
      {REAL_SCREEN[platform] ? (
        <>
          <Button variant="ghost" loading={busy} onClick={createSandbox}>Create sandbox</Button>
          <Button variant="primary" icon="key" onClick={() => { onClose(); navigate(REAL_SCREEN[platform]); }}>Connect {meta.label} for real</Button>
        </>
      ) : meta?.authType === 'oauth' ? (
        meta.oauthConfigured
          ? <Button variant="primary" icon="external" loading={busy} onClick={startOauth}>Connect {meta.label}</Button>
          : <Button variant="ghost" loading={busy} onClick={createSandbox}>Create sandbox</Button>
      ) : platform === 'SHOPIFY_BLOG'
        ? <Button variant="primary" icon="key" onClick={submitTokenConfig}>Open Shopify connect</Button>
        : <Button variant="primary" loading={busy} disabled={!cfg.url} onClick={submitTokenConfig}>Connect</Button>}
    </>
  );

  return (
    <Modal title="Add a connection" onClose={onClose} wide footer={footer}>
      {!platform ? (
        <div className="grid grid-3" style={{ gap: 10 }}>
          {(platforms || []).map((p) => (
            <div key={p.platform} className="card card-pad" style={{ cursor: 'pointer', textAlign: 'center' }} onClick={() => { setPlatform(p.platform); setLabel(p.label); setOauthErr(''); }}>
              <div style={{ width: 12, height: 12, borderRadius: 4, background: p.accent, margin: '0 auto 8px' }} />
              <div className="small" style={{ fontWeight: 600 }}>{p.label}</div>
              <div className="tiny dim">{p.authType === 'oauth' ? (p.oauthConfigured ? 'OAuth · ready' : 'OAuth · needs app') : p.authType === 'token' ? 'API token' : 'Webhook'}</div>
            </div>
          ))}
        </div>
      ) : (
        <div>
          <div className="row gap-8" style={{ marginBottom: 14 }}><Button size="sm" variant="ghost" onClick={() => setPlatform(null)}>← platforms</Button><PlatformTag platform={platform} /></div>
          <Field label="Label" hint="How this account shows up in your board, e.g. “Founder LinkedIn”."><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
          {platform === 'LINKEDIN' ? (
            <div className="card card-pad small" style={{ background: 'var(--surface-2)' }}>
              <div className="row gap-8"><Icon name="key" size={14} /><b>LinkedIn can publish for real right now</b></div>
              <div className="muted mt-8">Paste an access token from <span className="mono tiny">linkedin.com/developers</span> on the LinkedIn screen — the same one-minute flow as Shopify. No <span className="mono tiny">.env</span> edit and no restart.</div>
              <div className="muted mt-8">A <b>sandbox</b> connection stays available if you just want to rehearse the pipeline (publishing is simulated).</div>
            </div>
          ) : platform === 'FACEBOOK' || platform === 'INSTAGRAM' ? (
            <div className="card card-pad small" style={{ background: 'var(--surface-2)' }}>
              <div className="row gap-8"><Icon name="key" size={14} /><b>{meta.label} publishes for real</b></div>
              <div className="muted mt-8">Save your Meta App ID/Secret once (it powers both Facebook and Instagram), then Sign in with Facebook or paste a token on the {meta.label} screen. No <span className="mono tiny">.env</span> edit and no restart.</div>
              <div className="muted mt-8" style={{ color: 'var(--warning)' }}>Publishing to pages you don't own needs Meta App Review approval; your own pages work immediately in Development mode.</div>
            </div>
          ) : platform === 'GOOGLE_BUSINESS' ? (
            <div className="card card-pad small" style={{ background: 'var(--surface-2)' }}>
              <div className="row gap-8"><Icon name="key" size={14} /><b>Google Business publishes for real too</b></div>
              <div className="muted mt-8">Sign in with Google, or paste a refresh token, on the Google Business screen. No <span className="mono tiny">.env</span> edit and no restart.</div>
              <div className="muted mt-8" style={{ color: 'var(--warning)' }}>Note: Google requires an approved Business Profile API access request before any post succeeds — that approval is on Google's side and takes days to weeks. The Google Business screen explains both prerequisites.</div>
            </div>
          ) : meta.authType === 'oauth' && (meta.oauthConfigured ? (
            <div className="card card-pad small muted" style={{ background: 'var(--surface-2)' }}>
              <Icon name="shield" size={14} /> Your {meta.label} app is configured. “Connect” sends you to {meta.label} to authorize, then brings you back. Publishing scopes must be approved in your app’s App Review.
            </div>
          ) : (
            <div className="card card-pad small" style={{ background: 'var(--surface-2)' }}>
              <div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="alert" size={14} /><b>Live {meta.label} isn’t configured yet</b></div>
              <div className="muted mt-8">To publish for real: create a {meta.label} developer app, set <span className="mono tiny">{(meta.requiredEnv || []).join(', ')}</span> in <span className="mono tiny">app/.env</span>, restart, and complete App Review for the publishing scopes.</div>
              <div className="muted mt-8">Meanwhile, create a <b>sandbox</b> connection to test the full pipeline (publishing is simulated).</div>
            </div>
          ))}
          {oauthErr && <div className="card card-pad small mt-8" style={{ borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}><b style={{ color: 'var(--warning)' }}>Setup needed</b><div className="muted mt-8">{oauthErr}</div><Button size="sm" variant="ghost" className="mt-8" onClick={createSandbox}>Create sandbox instead</Button></div>}
          {platform === 'SHOPIFY_BLOG' && <div className="card card-pad small muted" style={{ background: 'var(--surface-2)' }}>Shopify connects with an Admin API token on the Shopify screen — click “Open Shopify connect”.</div>}
          {platform === 'CUSTOM_WEBHOOK' && <>
            <Field label="Webhook URL" hint="This connector really POSTs your rendered post here — great for Slack/Discord/Zapier."><Input mono value={cfg.url || ''} onChange={(e) => setCfg({ ...cfg, url: e.target.value })} placeholder="https://hooks.slack.com/services/…" /></Field>
            <Field label="Body template" hint="Handlebars-style: {{title}} {{body}} {{imageUrl}} {{link}} {{hashtags}}"><Input mono value={cfg.template || '{"text":"{{title}}\\n{{body}}"}'} onChange={(e) => setCfg({ ...cfg, template: e.target.value })} /></Field>
          </>}
        </div>
      )}
    </Modal>
  );
}

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DAYS_FULL = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const TIMEZONES = ['Asia/Kolkata', 'UTC', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Australia/Sydney'];

// Presets do the thinking for you. Each is a real cadence, not a placeholder.
const PRESETS = [
  { id: 'light', label: 'Light', sub: '1× a week', build: (t) => [{ dayOfWeek: 2, time: t }] },
  { id: 'steady', label: 'Steady', sub: '3× a week', build: (t) => [1, 3, 5].map((d) => ({ dayOfWeek: d, time: t })) },
  { id: 'weekdays', label: 'Weekdays', sub: '5× a week', build: (t) => [1, 2, 3, 4, 5].map((d) => ({ dayOfWeek: d, time: t })) },
  { id: 'daily', label: 'Daily', sub: 'every day', build: (t) => [0, 1, 2, 3, 4, 5, 6].map((d) => ({ dayOfWeek: d, time: t })) },
];

function to12h(t) {
  const [h, m] = String(t || '09:30').split(':').map(Number);
  const ampm = h >= 12 ? 'pm' : 'am';
  const hh = h % 12 === 0 ? 12 : h % 12;
  return `${hh}:${String(m).padStart(2, '0')}${ampm}`;
}

// Plain-English description of what the schedule will actually do.
function describe(s) {
  const slots = s.slots || [];
  if (!s.isEnabled) return 'Automated scheduling is off. Posts stay in Drafts until you publish them yourself.';
  if (!slots.length) return 'No posting slots yet — nothing will be scheduled. Pick a preset or add a day below.';
  const byTime = {};
  slots.forEach((sl) => { (byTime[sl.time] ||= []).push(sl.dayOfWeek); });
  const phrases = Object.entries(byTime).map(([time, days]) => {
    const sorted = [...days].sort();
    const names = sorted.length === 7 ? 'every day'
      : sorted.length === 5 && sorted.every((d) => d >= 1 && d <= 5) ? 'every weekday'
      : sorted.map((d) => DAYS[d]).join(', ');
    return `${names} at ${to12h(time)}`;
  });
  return `${slots.length} post${slots.length > 1 ? 's' : ''} a week — ${phrases.join('; ')} (${s.timezone}). At most ${s.maxPerDay} a day, ${Math.round((s.minGapMinutes || 0) / 60)}h apart minimum.`;
}

function ScheduleModal({ connection, onClose, onSaved }) {
  const { data, loading } = useAsync(() => api.get(`/connections/${connection.id}/schedule`).then((r) => r.data));
  const [s, setS] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  const [advanced, setAdvanced] = useState(false);
  React.useEffect(() => { if (data) setS(data); }, [data]);

  // Live "when will this actually post" preview, refreshed as you edit.
  React.useEffect(() => {
    if (!s) return;
    let cancelled = false;
    const t = setTimeout(async () => {
      try {
        // Preview the unsaved draft — nothing is persisted until you hit Save.
        const r = await api.post(`/connections/${connection.id}/schedule/preview`, { schedule: { isEnabled: s.isEnabled, slots: s.slots } });
        if (!cancelled) setPreview(r.data.slice(0, 5));
      } catch { if (!cancelled) setPreview(null); }
    }, 350);
    return () => { cancelled = true; clearTimeout(t); };
  }, [s, connection.id]);

  if (loading || !s) return <Modal title="Schedule" onClose={onClose}><Loading rows={2} /></Modal>;

  const slots = s.slots || [];
  const baseTime = slots[0]?.time || '09:30';
  const activeDays = new Set(slots.map((sl) => sl.dayOfWeek));

  function applyPreset(p) { setS({ ...s, slots: p.build(baseTime), isEnabled: true }); }
  function toggleDay(d) {
    const next = activeDays.has(d) ? slots.filter((sl) => sl.dayOfWeek !== d) : [...slots, { dayOfWeek: d, time: baseTime }];
    setS({ ...s, slots: next.sort((a, b) => a.dayOfWeek - b.dayOfWeek) });
  }
  function setAllTimes(time) { setS({ ...s, slots: slots.map((sl) => ({ ...sl, time })) }); }
  function setDayTime(d, time) { setS({ ...s, slots: slots.map((sl) => (sl.dayOfWeek === d ? { ...sl, time } : sl)) }); }

  const matchingPreset = PRESETS.find((p) => {
    const built = p.build(baseTime);
    return built.length === slots.length && built.every((b) => slots.some((sl) => sl.dayOfWeek === b.dayOfWeek));
  });
  const mixedTimes = new Set(slots.map((sl) => sl.time)).size > 1;

  async function save() {
    setBusy(true);
    try { await api.put(`/connections/${connection.id}/schedule`, s); toast.success('Schedule saved', describe(s)); onSaved(); onClose(); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }

  const ratio = s.categoryRatio?.PRODUCT ?? 60;
  return (
    <Modal title={`Schedule — ${connection.label}`} onClose={onClose} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save schedule</Button></>}>

      <div className="row between" style={{ marginBottom: 14 }}>
        <label className="row gap-8" style={{ cursor: 'pointer' }}>
          <Toggle on={s.isEnabled} onChange={(v) => setS({ ...s, isEnabled: v })} />
          <span className="small" style={{ fontWeight: 600 }}>Post automatically</span>
        </label>
        <span className="chip mono small">{connection.meta?.label}</span>
      </div>

      {/* What this will do, in words */}
      <div className="card card-pad small" style={{ background: 'var(--surface-2)', marginBottom: 16, opacity: s.isEnabled ? 1 : 0.6 }}>
        <div className="row gap-8"><Icon name="calendar" size={14} className="dim" /><b>{describe(s)}</b></div>
      </div>

      <div style={{ opacity: s.isEnabled ? 1 : 0.45, pointerEvents: s.isEnabled ? 'auto' : 'none' }}>
        <Field label="How often" hint="A starting point — fine-tune the days and times below.">
          <div className="row gap-8 wrap">
            {PRESETS.map((p) => (
              <div key={p.id} onClick={() => applyPreset(p)}
                className={cx('card', 'card-pad')}
                style={{ cursor: 'pointer', textAlign: 'center', flex: '1 1 100px', minWidth: 100, padding: '10px 12px',
                  borderColor: matchingPreset?.id === p.id ? 'var(--accent)' : undefined,
                  background: matchingPreset?.id === p.id ? 'color-mix(in srgb, var(--accent) 12%, transparent)' : undefined }}>
                <div className="small" style={{ fontWeight: 600 }}>{p.label}</div>
                <div className="tiny dim">{p.sub}</div>
              </div>
            ))}
          </div>
        </Field>

        <Field label="Which days" hint="Click a day to turn it on or off.">
          <div className="row gap-6 wrap">
            {DAYS.map((d, i) => (
              <div key={i} onClick={() => toggleDay(i)} title={DAYS_FULL[i]}
                style={{ cursor: 'pointer', userSelect: 'none', minWidth: 46, textAlign: 'center', padding: '8px 10px', borderRadius: 8,
                  border: '1px solid var(--border)', fontSize: 13, fontWeight: 600,
                  background: activeDays.has(i) ? 'var(--accent)' : 'var(--surface-2)',
                  color: activeDays.has(i) ? 'var(--on-accent, #0a0b0f)' : 'var(--text-dim, inherit)' }}>
                {d}
              </div>
            ))}
          </div>
        </Field>

        <Field label="What time" hint={mixedTimes ? 'Different times per day — set them individually below.' : 'Applies to every selected day.'}>
          <div className="row gap-8 wrap">
            <Input type="time" value={baseTime} onChange={(e) => setAllTimes(e.target.value)} style={{ width: 140 }} />
            {['08:30', '09:30', '12:00', '18:00'].map((t) => (
              <Button key={t} size="sm" variant="ghost" onClick={() => setAllTimes(t)}>{to12h(t)}</Button>
            ))}
          </div>
          {mixedTimes && (
            <div className="col gap-6 mt-8">
              {slots.map((sl) => (
                <div key={sl.dayOfWeek} className="row gap-8">
                  <span className="small dim" style={{ width: 90 }}>{DAYS_FULL[sl.dayOfWeek]}</span>
                  <Input type="time" value={sl.time} onChange={(e) => setDayTime(sl.dayOfWeek, e.target.value)} style={{ width: 130 }} />
                </div>
              ))}
            </div>
          )}
        </Field>

        <Field label="Timezone">
          <Select value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} style={{ maxWidth: 260 }}>
            {[...new Set([s.timezone, ...TIMEZONES])].filter(Boolean).map((tz) => <option key={tz} value={tz}>{tz}</option>)}
          </Select>
        </Field>

        {/* Proof: the actual next five publish times */}
        <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
          <div className="row between"><b className="small">Next 5 posts would go out</b>{!preview && <span className="tiny dim">calculating…</span>}</div>
          {preview?.length > 0 ? (
            <div className="col gap-4 mt-8">
              {preview.map((t) => (
                <div key={t} className="row between small">
                  <span>{new Date(t).toLocaleString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}</span>
                  <b className="mono">{new Date(t).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}</b>
                </div>
              ))}
            </div>
          ) : preview && <div className="tiny dim mt-8">Nothing scheduled — no days selected, or every slot falls in quiet hours.</div>}
        </div>

        <Field label={`Content mix — Product ${ratio}% / Knowledge ${100 - ratio}%`} hint="Product posts talk about your catalogue; knowledge posts teach something.">
          <input type="range" min="0" max="100" value={ratio} onChange={(e) => setS({ ...s, categoryRatio: { PRODUCT: +e.target.value, KNOWLEDGE: 100 - +e.target.value } })} style={{ width: '100%', accentColor: 'var(--accent)' }} />
        </Field>

        <div className="divider" />
        <Button size="sm" variant="ghost" icon={advanced ? 'chevronD' : 'chevronR'} onClick={() => setAdvanced((a) => !a)}>Advanced limits</Button>
        {advanced && (
          <div className="mt-8">
            <div className="grid grid-2" style={{ gap: 14 }}>
              <Field label="Max per day" hint="Hard ceiling, even if more slots fall on one day."><Input type="number" value={s.maxPerDay} onChange={(e) => setS({ ...s, maxPerDay: +e.target.value })} /></Field>
              <Field label="Minimum gap (minutes)" hint="Never post twice closer together than this."><Input type="number" value={s.minGapMinutes} onChange={(e) => setS({ ...s, minGapMinutes: +e.target.value })} /></Field>
              <Field label="Quiet hours start" hint="Slots inside quiet hours are skipped."><Input type="time" value={s.quietHours?.start || '22:00'} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, start: e.target.value } })} /></Field>
              <Field label="Quiet hours end"><Input type="time" value={s.quietHours?.end || '07:00'} onChange={(e) => setS({ ...s, quietHours: { ...s.quietHours, end: e.target.value } })} /></Field>
              <Field label="Auto-approve above (SEO score)" hint="Below this, posts wait for your review."><Input type="number" value={s.autoApproveAbove} onChange={(e) => setS({ ...s, autoApproveAbove: +e.target.value })} /></Field>
              <Field label="Lead time (minutes)" hint="How far ahead a post is generated before its slot."><Input type="number" value={s.leadTimeMinutes} onChange={(e) => setS({ ...s, leadTimeMinutes: +e.target.value })} /></Field>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

const STRATEGIES = ['OLDEST_FIRST', 'LARGEST_FIRST', 'PUBLISHED_ONLY', 'NEVER'];
function QuotaModal({ connection, onClose, onSaved }) {
  const { data, loading, reload } = useAsync(() => api.get(`/connections/${connection.id}/quota`).then((r) => r.data));
  const [q, setQ] = useState(null);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState(null);
  React.useEffect(() => { if (data?.quota) setQ({ ...data.quota, maxGB: Math.round(Number(data.quota.maxBytes) / 1e9) }); }, [data]);
  if (loading || !q) return <Modal title="Storage" onClose={onClose}><Loading rows={2} /></Modal>;

  async function save() {
    setBusy(true);
    try { await api.put(`/connections/${connection.id}/quota`, { maxBytes: q.maxGB * 1e9, retentionDays: +q.retentionDays, purgeStrategy: q.purgeStrategy, keepMetadata: q.keepMetadata, keepThumbnails: q.keepThumbnails, warnAtPercent: +q.warnAtPercent }); toast.success('Storage settings saved'); onSaved(); onClose(); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }
  async function dryRun() { const r = await api.post(`/connections/${connection.id}/purge`, { dryRun: true }); setPreview(r.data); }

  return (
    <Modal title={`Storage — ${connection.label}`} onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={save}>Save</Button></>}>
      <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
        <div className="row between small"><span className="muted">Used</span><b className="mono">{fmt.bytes(data.usedBytes)} / {fmt.bytes(data.maxBytes)}</b></div>
        <div className={cx('progress', data.percent >= 80 && 'warn', data.percent >= 100 && 'danger')} style={{ marginTop: 8 }}><span style={{ width: `${Math.min(100, data.percent)}%` }} /></div>
        <div className="tiny dim mt-8">{data.assetCount} assets · oldest {fmt.date(data.oldestRetained)}</div>
      </div>
      <div className="grid grid-2" style={{ gap: 14 }}>
        <Field label="Cap (GB)"><Input type="number" value={q.maxGB} onChange={(e) => setQ({ ...q, maxGB: +e.target.value })} /></Field>
        <Field label="Retention (days)"><Input type="number" value={q.retentionDays} onChange={(e) => setQ({ ...q, retentionDays: +e.target.value })} /></Field>
        <Field label="Purge strategy"><Select value={q.purgeStrategy} onChange={(e) => setQ({ ...q, purgeStrategy: e.target.value })}>{STRATEGIES.map((s) => <option key={s}>{s}</option>)}</Select></Field>
        <Field label="Warn at %"><Input type="number" value={q.warnAtPercent} onChange={(e) => setQ({ ...q, warnAtPercent: +e.target.value })} /></Field>
      </div>
      <label className="row gap-8 small" style={{ marginBottom: 8, cursor: 'pointer' }}><Toggle on={q.keepMetadata} onChange={(v) => setQ({ ...q, keepMetadata: v })} /> Keep metadata after purge (recommended — History still works)</label>
      <label className="row gap-8 small" style={{ cursor: 'pointer' }}><Toggle on={q.keepThumbnails} onChange={(v) => setQ({ ...q, keepThumbnails: v })} /> Keep thumbnails</label>
      <div className="divider" />
      <Button size="sm" variant="ghost" icon="eye" onClick={dryRun}>Dry-run purge preview</Button>
      {preview && <div className="small muted mt-8">Would free <b className="mono">{fmt.bytes(preview.freedBytes)}</b> across <b>{preview.count}</b> assets{preview.note ? ` — ${preview.note}` : ''}.</div>}
    </Modal>
  );
}
