import React, { useState } from 'react';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Input, Select, Field, Modal, useAsync, fmt, toast } from '../ui.jsx';
import { PageHeader, Loading, ConfirmDialog } from '../components/common.jsx';

// One screen powers both /facebook and /instagram — they share a Meta app and
// differ only in copy and which endpoint publishes.
const CONF = {
  facebook: { platform: 'FACEBOOK', label: 'Facebook', accent: '#1877F2', icon: 'facebook', unit: 'Page', route: '/facebook' },
  instagram: { platform: 'INSTAGRAM', label: 'Instagram', accent: '#E1306C', icon: 'instagram', unit: 'account', route: '/instagram' },
};

export function Facebook() { return <MetaScreen network="facebook" />; }
export function Instagram() { return <MetaScreen network="instagram" />; }

function MetaScreen({ network }) {
  const cfg = CONF[network];
  const { data, loading, reload } = useAsync(() => api.get(`/meta/${network}/status`).then((r) => r.data));
  const [connecting, setConnecting] = useState(false);
  const [appModal, setAppModal] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [testing, setTesting] = useState(null);

  React.useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected')) toast.success(`${cfg.label} connected`, 'Account linked.');
    else if (p.get('oauth_error')) toast.error(`${cfg.label} sign-in failed`, p.get('oauth_error'));
    if (p.get('connected') || p.get('oauth_error')) window.history.replaceState({}, '', cfg.route);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="page"><PageHeader title={cfg.label} /><Loading rows={4} /></div>;

  const live = data.connections.filter((c) => !c.sandbox);
  const sandboxes = data.connections.filter((c) => c.sandbox);

  async function test(c) {
    setTesting(c.id);
    try {
      const r = await api.post(`/meta/connections/${c.id}/test`);
      if (r.data.status === 'CONNECTED') toast.success(`${cfg.label} is live`, r.data.detail);
      else toast.error(`Status: ${r.data.status}`, r.data.detail);
      reload();
    } catch (e) { toast.error('Check failed', e.message); }
    setTesting(null);
  }
  async function startOauth() {
    try {
      const r = await api.get(`/connections/oauth/${cfg.platform}/start?label=${encodeURIComponent(cfg.label)}`);
      window.location.href = r.data.authUrl;
    } catch (e) { toast.error('Cannot start OAuth', e.message); }
  }

  return (
    <div className="page">
      <PageHeader title={cfg.label} icon={cfg.icon}
        sub={`Publish real posts to your ${cfg.label} ${cfg.unit}${network === 'instagram' ? 's' : 's'} — same connect flow as LinkedIn.`}
        actions={data.app.configured ? <>
          <Button variant="primary" icon="key" onClick={() => setConnecting(true)}>Connect {cfg.label}</Button>
          <Button variant="ghost" icon="shield" onClick={() => setAppModal(true)}>Meta app</Button>
        </> : <Button variant="primary" icon="shield" onClick={() => setAppModal(true)}>Step 1 — Add Meta app</Button>} />

      {network === 'instagram' && (
        <Card className="card-pad" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 22%, var(--border))' }}>
          <div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="alert" size={14} /><b className="small">Instagram prerequisites</b></div>
          <div className="muted small mt-8">Instagram publishing works only when your IG account is a <b>Business or Creator</b> account, <b>linked to a Facebook Page</b>. Instagram also cannot post text alone — <b>every post needs a publicly reachable image URL</b>.</div>
        </Card>
      )}

      {live.length === 0 && (
        <Card className="card-pad" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}>
          <div className="row between wrap gap-16">
            <div className="row gap-16">
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 18%, transparent)', color: 'var(--warning)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={20} /></div>
              <div>
                <b>No live {cfg.label} {cfg.unit} connected</b>
                <div className="tiny dim">{!data.app.configured ? 'Start by saving your Meta App ID and Secret.' : sandboxes.length ? `You have ${sandboxes.length} sandbox connection(s) — publishing there is simulated.` : 'Sign in with Facebook, or paste a token.'}</div>
              </div>
            </div>
            {data.app.configured
              ? <Button variant="primary" icon="external" onClick={startOauth}>Sign in with Facebook</Button>
              : <Button variant="primary" icon="shield" onClick={() => setAppModal(true)}>Add Meta app</Button>}
          </div>
        </Card>
      )}

      <Card className="card-pad" style={{ marginBottom: 16 }}>
        <div className="row between wrap gap-16">
          <div className="row gap-16">
            <div style={{ width: 42, height: 42, borderRadius: 10, background: cfg.accent, display: 'grid', placeItems: 'center', color: '#fff' }}><Icon name={cfg.icon} size={22} /></div>
            <div>
              <div className="row gap-8"><b>Meta app</b>{data.app.configured ? <Badge variant="success" dot>configured ({data.app.source})</Badge> : <Badge variant="warning" dot>not set</Badge>}</div>
              <div className="tiny dim">One Meta app powers both Facebook and Instagram. Set it once on either screen.</div>
            </div>
          </div>
          {data.app.configured && <Button size="sm" icon="external" onClick={startOauth}>Sign in with Facebook</Button>}
        </div>
        <div className="divider" />
        <div className="tiny dim">Valid OAuth redirect URI for your Meta app → <span className="mono">{data.redirectUri}</span></div>
      </Card>

      <Card>
        <CardHead title={`${cfg.label} connections`} sub={`${live.length} live · ${sandboxes.length} sandbox`} />
        {data.connections.length === 0 && <div className="empty" style={{ padding: 30 }}><div className="small">Nothing connected yet.</div></div>}
        {data.connections.map((c) => (
          <div key={c.id} className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ minWidth: 240 }}>
              <div className="row gap-8">
                <b className="small">{c.label}</b>
                {c.sandbox ? <Badge variant="warning" dot>sandbox · simulated</Badge> : <Badge variant="success" dot>live</Badge>}
              </div>
              <div className="tiny dim">{c.targetName || `no ${cfg.unit}`}{c.pageName && network === 'instagram' ? ` · via ${c.pageName}` : ''} · <span className="mono">{c.targetId || '—'}</span></div>
              <div className="tiny dim">
                {c.scopes?.length ? c.scopes.join(' ') : 'no scopes recorded'}
                {c.tokenExpiresAt ? ` · token expires ${fmt.rel(c.tokenExpiresAt)}` : ''}
                {` · ${c.publishedCount} published`}
              </div>
            </div>
            <div className="row gap-6 wrap">
              {!c.sandbox && c.availableTargets?.length > 1 && <TargetPicker connection={c} onDone={reload} />}
              {!c.sandbox && <Button size="sm" variant="ghost" loading={testing === c.id} onClick={() => test(c)}>Test live</Button>}
              <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}><Icon name="trash" size={14} /></Button>
            </div>
          </div>
        ))}
      </Card>

      {connecting && <ConnectModal cfg={cfg} network={network} status={data} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); reload(); }} onNeedApp={() => { setConnecting(false); setAppModal(true); }} />}
      {appModal && <AppModal status={data} onClose={() => setAppModal(false)} onDone={() => { setAppModal(false); reload(); }} />}
      {removing && <ConfirmDialog title={`Disconnect ${removing.label}?`} danger confirmLabel="Disconnect"
        body="The stored token is deleted and publishing to this account stops. History is kept."
        onConfirm={async () => { await api.del(`/connections/${removing.id}`); toast.success('Disconnected'); reload(); }}
        onClose={() => setRemoving(null)} />}
    </div>
  );
}

function TargetPicker({ connection, onDone }) {
  const [busy, setBusy] = useState(false);
  async function change(e) {
    const targetId = e.target.value;
    if (targetId === connection.targetId) return;
    setBusy(true);
    try { await api.put(`/meta/connections/${connection.id}/target`, { targetId }); toast.success('Target changed'); onDone(); }
    catch (err) { toast.error('Failed', err.message); }
    setBusy(false);
  }
  return (
    <Select value={connection.targetId || ''} onChange={change} disabled={busy} style={{ width: 200 }}>
      {connection.availableTargets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
    </Select>
  );
}

function ConnectModal({ cfg, network, status, onClose, onDone, onNeedApp }) {
  const [accessToken, setAccessToken] = useState('');
  const [label, setLabel] = useState(cfg.label);
  const [targetId, setTargetId] = useState('');
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(true);

  async function inspect() {
    setBusy(true);
    try {
      const r = await api.post(`/meta/${network}/inspect`, { accessToken });
      setProbe(r.data);
      if (r.data.targets.length) { setTargetId(r.data.targets[0].id); setLabel(`${cfg.label} — ${r.data.targets[0].name}`); }
      if (!r.data.targets.length) toast.error(`No ${cfg.unit} found`, network === 'instagram' ? 'Link an IG Business account to a Facebook Page first.' : 'This login manages no Facebook Pages.');
      else if (!r.data.canPublish) toast.error('Token cannot publish', `Missing ${r.data.neededScope} — add it in App Review.`);
      else toast.success('Token is valid', `${r.data.targetCount} ${cfg.unit}(s) available`);
    } catch (e) { setProbe(null); toast.error('Token rejected', e.message); }
    setBusy(false);
  }
  async function connect() {
    setBusy(true);
    try {
      const r = await api.post(`/meta/${network}/connect-token`, { accessToken, label, targetId: targetId || undefined });
      toast.success(`${cfg.label} connected — live`, `Publishing as ${r.data.connection.targetName}`);
      onDone();
    } catch (e) { toast.error('Could not connect', e.message); setBusy(false); }
  }

  return (
    <Modal title={`Connect ${cfg.label} for real`} onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="ghost" loading={busy} disabled={!accessToken} onClick={inspect}>Validate token</Button>
        <Button variant="primary" icon="key" loading={busy} disabled={!accessToken} onClick={connect}>Connect live</Button>
      </>}>
      {!status.app.configured && (
        <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 40%, var(--border))' }}>
          <div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="alert" size={14} /><b className="small">Save your Meta App ID and Secret first</b></div>
          <div className="muted small mt-8">The token below is exchanged and long-lived using your app credentials — without them there is nothing to validate against.</div>
          <Button variant="primary" icon="shield" className="mt-8" onClick={onNeedApp}>Add Meta app</Button>
        </div>
      )}

      <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 16 }}>
        <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setShowHelp((s) => !s)}>
          <b className="small">How to get a {cfg.label} access token</b>
          <Icon name={showHelp ? 'chevronD' : 'chevronR'} size={15} className="dim" />
        </div>
        {showHelp && (
          <ol className="small muted" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Easiest: save your App ID/Secret here, then use <b>Sign in with Facebook</b> — no token to copy.</li>
            <li>Manual: developers.facebook.com → your app → <b>Tools → Graph API Explorer</b>.</li>
            <li>Pick your app, then add permissions: <span className="mono tiny">{status.scopes.join(', ')}</span>.</li>
            <li>Click <b>Generate Access Token</b> and approve. Paste the <b>User</b> token below — we long-live it to ~60 days and derive the {cfg.unit} token automatically.</li>
            {network === 'instagram' && <li>Your IG account must be Business/Creator and linked to a Page you admin, or it won't appear.</li>}
          </ol>
        )}
      </div>

      <Field label="User access token" hint="Encrypted at rest. Validated against the Graph API and extended to a long-lived token before saving.">
        <Input mono type="password" value={accessToken} onChange={(e) => { setAccessToken(e.target.value); setProbe(null); }} placeholder="EAAG…" autoFocus />
      </Field>

      {probe && (
        <div className="card card-pad small" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
          <div className="row gap-8"><Icon name="check" size={14} style={{ color: 'var(--success)' }} /><b>{probe.targetCount} {cfg.unit}(s) available</b>{probe.longLived && <Badge variant="success">long-lived</Badge>}</div>
          <div className="tiny dim mt-8">{probe.scopes.length ? `Scopes: ${probe.scopes.join(' ')}` : 'Scopes unknown (add Meta app to enable introspection)'}{probe.expiresAt ? ` · expires ${fmt.rel(probe.expiresAt)}` : ''}</div>
          {!probe.canPublish && <div className="tiny mt-8" style={{ color: 'var(--warning)' }}>Missing {probe.neededScope} — this token cannot publish.</div>}
        </div>
      )}

      <Field label={`Publish to which ${cfg.unit}`}>
        <Select value={targetId} onChange={(e) => setTargetId(e.target.value)} disabled={!probe}>
          {!probe && <option value="">Validate the token first…</option>}
          {(probe?.targets || []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </Select>
      </Field>

      <Field label="Label" hint="How this account shows up on your board."><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>
    </Modal>
  );
}

function AppModal({ status, onClose, onDone }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try { await api.put('/meta/app', { clientId, clientSecret }); toast.success('Meta app saved', 'Powers both Facebook and Instagram. No restart needed.'); onDone(); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }
  async function clear() { try { await api.del('/meta/app'); toast.success('Cleared'); onDone(); } catch (e) { toast.error('Failed', e.message); } }

  return (
    <Modal title="Meta app credentials" onClose={onClose}
      footer={<>
        {status.app.configured && status.app.source === 'ui' && <Button variant="ghost" onClick={clear}>Remove</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!clientId || !clientSecret} onClick={save}>Save</Button>
      </>}>
      <div className="card card-pad small muted" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
        developers.facebook.com → your app → <b>Settings → Basic</b> for the App ID and App Secret. One app serves both Facebook and Instagram.
        <div className="mt-8">In <b>Facebook Login → Settings</b>, add this Valid OAuth Redirect URI: <span className="mono tiny">{status.redirectUri}</span></div>
      </div>
      <Field label="App ID"><Input mono value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={status.app.clientId || '000000000000000'} /></Field>
      <Field label="App Secret" hint="Encrypted at rest. Never sent back to the browser."><Input mono type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="abcdef0123…" /></Field>
    </Modal>
  );
}
