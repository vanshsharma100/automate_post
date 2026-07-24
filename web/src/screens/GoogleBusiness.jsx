import React, { useState } from 'react';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Input, Select, Field, Modal, useAsync, fmt, toast } from '../ui.jsx';
import { PageHeader, Loading, ConfirmDialog } from '../components/common.jsx';

export function GoogleBusiness() {
  const { data, loading, reload } = useAsync(() => api.get('/google-business/status').then((r) => r.data));
  const [connecting, setConnecting] = useState(false);
  const [appModal, setAppModal] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [testing, setTesting] = useState(null);
  const [syncing, setSyncing] = useState(null);

  // The OAuth callback returns here, so report its outcome here.
  React.useEffect(() => {
    const p = new URLSearchParams(window.location.search);
    if (p.get('connected')) toast.success('Signed in with Google', 'Credentials stored.');
    else if (p.get('oauth_error')) toast.error('Google sign-in failed', p.get('oauth_error'));
    if (p.get('connected') || p.get('oauth_error')) window.history.replaceState({}, '', '/googlebusiness');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="page"><PageHeader title="Google Business" /><Loading rows={4} /></div>;

  const live = data.connections.filter((c) => !c.sandbox);
  const sandboxes = data.connections.filter((c) => c.sandbox);

  async function test(c) {
    setTesting(c.id);
    try {
      const r = await api.post(`/google-business/connections/${c.id}/test`);
      if (r.data.status === 'CONNECTED') toast.success('Google Business is live', r.data.detail);
      else toast.error(`Status: ${r.data.status}`, r.data.detail);
      reload();
    } catch (e) { toast.error('Check failed', e.message); }
    setTesting(null);
  }

  async function finishSetup(c) {
    setSyncing(c.id);
    try {
      const r = await api.post(`/google-business/connections/${c.id}/sync`);
      toast.success('Connection completed', `Now posting to ${r.data.connection.locationName}`);
      reload();
    } catch (e) { toast.error('Still not available', e.message); }
    setSyncing(null);
  }

  async function startOauth() {
    try {
      const r = await api.get('/connections/oauth/GOOGLE_BUSINESS/start?label=Google Business');
      window.location.href = r.data.authUrl;
    } catch (e) { toast.error('Cannot start OAuth', e.message); }
  }

  return (
    <div className="page">
      <PageHeader title="Google Business" icon="mapPin"
        sub="Publish real posts to your Business Profile locations — same connect flow as LinkedIn and Shopify."
        // Until the app credentials exist, connecting is impossible — so that is
        // the primary action, not the one that leads to a dead end.
        actions={data.app.configured ? <>
          <Button variant="primary" icon="key" onClick={() => setConnecting(true)}>Connect Google Business</Button>
          <Button variant="ghost" icon="shield" onClick={() => setAppModal(true)}>App credentials</Button>
        </> : <>
          <Button variant="primary" icon="shield" onClick={() => setAppModal(true)}>Step 1 — Add app credentials</Button>
        </>} />

      {live.length === 0 && (
        <Card className="card-pad" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}>
          <div className="row between wrap gap-16">
            <div className="row gap-16">
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 18%, transparent)', color: 'var(--warning)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={20} /></div>
              <div>
                <b>No live Business Profile connected</b>
                <div className="tiny dim">{data.app.configured
                  ? 'Credentials saved. Click “Sign in with Google” below to finish.'
                  : 'Start by saving your Google Client ID and Secret — nothing else can work without them.'}</div>
              </div>
            </div>
            {data.app.configured
              ? <Button variant="primary" icon="external" onClick={startOauth}>Sign in with Google</Button>
              : <Button variant="primary" icon="shield" onClick={() => setAppModal(true)}>Add app credentials</Button>}
          </div>
        </Card>
      )}

      <Card className="card-pad" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 22%, var(--border))' }}>
        <div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="alert" size={14} /><b className="small">Google gates this API — read before you start</b></div>
        <div className="muted small mt-8">
          Unlike LinkedIn, Business Profile API access is <b>not self-serve</b>. Two things must be true before any post succeeds:
        </div>
        <ol className="small muted" style={{ margin: '8px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
          <li>In Google Cloud Console, enable <span className="mono tiny">My Business Account Management API</span>, <span className="mono tiny">My Business Business Information API</span> and <span className="mono tiny">Google My Business API</span>.</li>
          <li>Submit the one-time <b>GBP API access request</b> (developers.google.com/my-business → Request access) and wait for approval — days to weeks.</li>
        </ol>
        <div className="muted small mt-8">Until step 2 is approved, Google answers every call with 403 no matter how valid your token is. This connector detects that exact case and tells you which of the two is missing.</div>
      </Card>

      <Card className="card-pad" style={{ marginBottom: 16 }}>
        <div className="row between wrap gap-16">
          <div className="row gap-16">
            <div style={{ width: 42, height: 42, borderRadius: 10, background: '#4285F4', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700 }}>G</div>
            <div>
              <div className="row gap-8"><b>OAuth app</b>{data.app.configured ? <Badge variant="success" dot>configured ({data.app.source})</Badge> : <Badge variant="warning" dot>not set</Badge>}</div>
              <div className="tiny dim">Required. Google has no long-lived pasteable token — the client id/secret is what mints and renews access tokens.</div>
            </div>
          </div>
          {data.app.configured && <Button size="sm" icon="external" onClick={startOauth}>Sign in with Google</Button>}
        </div>
        <div className="divider" />
        <div className="tiny dim">Authorized redirect URI for Google Cloud Console → <span className="mono">{data.redirectUri}</span></div>
      </Card>

      <Card>
        <CardHead title="Business Profile connections" sub={`${live.length} live · ${sandboxes.length} sandbox`} />
        {data.connections.length === 0 && <div className="empty" style={{ padding: 30 }}><div className="small">Nothing connected yet.</div></div>}
        {data.connections.map((c) => (
          <div key={c.id} className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ minWidth: 240, flex: 1 }}>
              <div className="row gap-8">
                <b className="small">{c.label}</b>
                {c.sandbox ? <Badge variant="warning" dot>sandbox · simulated</Badge>
                  : c.pendingDiscovery ? <Badge variant="warning" dot>signed in · waiting on Google</Badge>
                  : <Badge variant="success" dot>live</Badge>}
                {!c.sandbox && (c.durable ? <Badge variant="success">auto-refresh</Badge> : <Badge variant="warning">expires hourly</Badge>)}
              </div>
              <div className="tiny dim">{c.locationName || 'no location'}{c.locationId ? <> · <span className="mono">{c.locationId}</span></> : ''}</div>
              <div className="tiny dim">
                {c.tokenExpiresAt ? `token expires ${fmt.rel(c.tokenExpiresAt)}` : 'no expiry recorded'}
                {` · ${c.publishedCount} published`}
              </div>
              {c.pendingDiscovery && (
                <div className="tiny mt-8" style={{ color: 'var(--warning)', maxWidth: 620 }}>
                  Your Google sign-in is saved and safe — you will not need to authorise again. Google is still refusing to list your locations:
                  <div className="muted mt-8">{c.pendingReason}</div>
                  <div className="muted mt-8">When your API access request is approved, click <b>Finish setup</b> to complete this connection.</div>
                </div>
              )}
            </div>
            <div className="row gap-6 wrap">
              {!c.sandbox && c.pendingDiscovery && (
                <Button size="sm" variant="primary" icon="refresh" loading={syncing === c.id} onClick={() => finishSetup(c)}>Finish setup</Button>
              )}
              {!c.sandbox && !c.pendingDiscovery && c.availableTargets?.length > 1 && <LocationPicker connection={c} onDone={reload} />}
              {!c.sandbox && <Button size="sm" variant="ghost" loading={testing === c.id} onClick={() => test(c)}>Test live</Button>}
              <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}><Icon name="trash" size={14} /></Button>
            </div>
          </div>
        ))}
      </Card>

      {connecting && <ConnectModal status={data} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); reload(); }}
        onNeedApp={() => { setConnecting(false); setAppModal(true); }} />}
      {appModal && <AppModal status={data} onClose={() => setAppModal(false)} onDone={() => { setAppModal(false); reload(); }} />}
      {removing && <ConfirmDialog title={`Disconnect ${removing.label}?`} danger confirmLabel="Disconnect"
        body="The stored Google credentials are deleted and publishing to this location stops. History is kept."
        onConfirm={async () => { await api.del(`/connections/${removing.id}`); toast.success('Disconnected'); reload(); }}
        onClose={() => setRemoving(null)} />}
    </div>
  );
}

function LocationPicker({ connection, onDone }) {
  const [busy, setBusy] = useState(false);
  async function change(e) {
    const locationId = e.target.value;
    if (locationId === connection.locationId) return;
    setBusy(true);
    try { await api.put(`/google-business/connections/${connection.id}/location`, { locationId }); toast.success('Location changed'); onDone(); }
    catch (err) { toast.error('Failed', err.message); }
    setBusy(false);
  }
  return (
    <Select value={connection.locationId || ''} onChange={change} disabled={busy} style={{ width: 220 }}>
      {connection.availableTargets.map((t) => <option key={t.id} value={t.id}>{t.label || t.name}</option>)}
    </Select>
  );
}

function ConnectModal({ status, onClose, onDone, onNeedApp }) {
  const [refreshToken, setRefreshToken] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [label, setLabel] = useState('Google Business');
  const [locationId, setLocationId] = useState('');
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(true);

  const hasCreds = !!(refreshToken || accessToken);

  async function inspect() {
    setBusy(true);
    try {
      const r = await api.post('/google-business/inspect', { refreshToken: refreshToken || undefined, accessToken: accessToken || undefined });
      setProbe(r.data);
      if (r.data.targets.length) {
        setLocationId(r.data.targets[0].id);
        setLabel(`Google Business — ${r.data.targets[0].name}`);
      }
      toast.success('Credentials valid', `${r.data.locationCount} location(s) manageable`);
    } catch (e) { setProbe(null); toast.error('Rejected', e.message); }
    setBusy(false);
  }

  async function connect() {
    setBusy(true);
    try {
      const r = await api.post('/google-business/connect-token', { refreshToken: refreshToken || undefined, accessToken: accessToken || undefined, label, locationId: locationId || undefined });
      toast.success('Google Business connected — live', `Posting to ${r.data.connection.locationName}`);
      onDone();
    } catch (e) { toast.error('Could not connect', e.message); setBusy(false); }
  }

  return (
    <Modal title="Connect Google Business for real" onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="ghost" loading={busy} disabled={!hasCreds} onClick={inspect}>Validate</Button>
        <Button variant="primary" icon="key" loading={busy} disabled={!hasCreds} onClick={connect}>Connect live</Button>
      </>}>
      {!status.app.configured && (
        <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 40%, var(--border))' }}>
          <div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="alert" size={14} /><b className="small">Save your Client ID and Secret first</b></div>
          <div className="muted small mt-8">
            Neither field below can work without them — a refresh token is exchanged <i>using</i> your client credentials, so there is nothing to paste here yet.
          </div>
          <div className="muted small mt-8">
            Google never gives you a ready-made access token to copy. Save the Client ID and Secret, then use <b>Sign in with Google</b> and the token is captured for you automatically.
          </div>
          <Button variant="primary" icon="shield" className="mt-8" onClick={onNeedApp}>Add app credentials</Button>
        </div>
      )}

      <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 16 }}>
        <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setShowHelp((s) => !s)}>
          <b className="small">How to get a Google refresh token</b>
          <Icon name={showHelp ? 'chevronD' : 'chevronR'} size={15} className="dim" />
        </div>
        {showHelp && (
          <ol className="small muted" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Easiest path: save your Client ID/Secret here, then use <b>Sign in with Google</b> on this screen — the redirect stores a refresh token automatically.</li>
            <li>Manual path: developers.google.com/oauthplayground → gear icon → tick <b>Use your own OAuth credentials</b> and paste your client id/secret.</li>
            <li>In the scope box enter <span className="mono tiny">https://www.googleapis.com/auth/business.manage</span> and authorize.</li>
            <li>Click <b>Exchange authorization code for tokens</b> and copy the <b>refresh token</b>.</li>
            <li>A refresh token does not expire — the connector mints a fresh access token every hour on its own.</li>
          </ol>
        )}
      </div>

      <Field label="Refresh token" hint="Recommended. Durable — the connector renews access tokens forever. Requires your Client ID/Secret to be saved.">
        <Input mono type="password" value={refreshToken} onChange={(e) => { setRefreshToken(e.target.value); setProbe(null); }} placeholder="1//0g…" autoFocus />
      </Field>
      {!status.app.configured && refreshToken && (
        <div className="tiny mt-8" style={{ color: 'var(--warning)' }}>Save your Client ID and Secret first — a refresh token cannot mint access tokens without them.</div>
      )}

      <Field label="Or an access token" hint="Works right now but dies in about 60 minutes. Testing only — scheduled posts will start failing.">
        <Input mono type="password" value={accessToken} onChange={(e) => { setAccessToken(e.target.value); setProbe(null); }} placeholder="ya29.…" />
      </Field>

      {probe && (
        <div className="card card-pad small" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
          <div className="row gap-8"><Icon name="check" size={14} style={{ color: 'var(--success)' }} /><b>{probe.locationCount} location(s) manageable</b></div>
          {probe.expiresAt && <div className="tiny dim mt-8">Access token expires {fmt.rel(probe.expiresAt)} — renewed automatically.</div>}
        </div>
      )}

      <Field label="Post to which location" hint="One connection publishes to one location. Add another connection for a second location.">
        <Select value={locationId} onChange={(e) => setLocationId(e.target.value)} disabled={!probe}>
          {!probe && <option value="">Validate first…</option>}
          {(probe?.targets || []).map((t) => <option key={t.id} value={t.id}>{t.label || t.name}</option>)}
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
    try { await api.put('/google-business/app', { clientId, clientSecret }); toast.success('Google app saved', 'No restart needed.'); onDone(); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }
  async function clear() {
    try { await api.del('/google-business/app'); toast.success('Cleared'); onDone(); } catch (e) { toast.error('Failed', e.message); }
  }

  return (
    <Modal title="Google OAuth app credentials" onClose={onClose}
      footer={<>
        {status.app.configured && status.app.source === 'ui' && <Button variant="ghost" onClick={clear}>Remove</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!clientId || !clientSecret} onClick={save}>Save</Button>
      </>}>
      <div className="card card-pad small muted" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
        Google Cloud Console → APIs &amp; Services → Credentials → <b>Create OAuth client ID</b> → Web application.
        <div className="mt-8">Add this exact Authorized redirect URI: <span className="mono tiny">{status.redirectUri}</span></div>
        <div className="mt-8">Unlike LinkedIn these are required, not optional — they are what renews access tokens.</div>
      </div>
      <Field label="Client ID"><Input mono value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={status.app.clientId || '1234…apps.googleusercontent.com'} /></Field>
      <Field label="Client Secret" hint="Encrypted at rest. Never sent back to the browser."><Input mono type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="GOCSPX-…" /></Field>
    </Modal>
  );
}
