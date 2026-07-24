import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Input, Select, Field, Modal, useAsync, fmt, toast } from '../ui.jsx';
import { PageHeader, Loading, ConfirmDialog } from '../components/common.jsx';

export function LinkedIn() {
  const { data, loading, reload } = useAsync(() => api.get('/linkedin/status').then((r) => r.data));
  const [connecting, setConnecting] = useState(false);
  const [appModal, setAppModal] = useState(false);
  const [removing, setRemoving] = useState(null);
  const [testing, setTesting] = useState(null);
  if (loading) return <div className="page"><PageHeader title="LinkedIn" /><Loading rows={4} /></div>;

  const live = data.connections.filter((c) => !c.sandbox);
  const sandboxes = data.connections.filter((c) => c.sandbox);

  async function test(c) {
    setTesting(c.id);
    try {
      const r = await api.post(`/linkedin/connections/${c.id}/test`);
      if (r.data.status === 'CONNECTED') toast.success('LinkedIn is live', r.data.detail);
      else toast.error(`Status: ${r.data.status}`, r.data.detail);
      reload();
    } catch (e) { toast.error('Check failed', e.message); }
    setTesting(null);
  }

  async function startOauth() {
    try {
      const r = await api.get('/connections/oauth/LINKEDIN/start?label=LinkedIn');
      window.location.href = r.data.authUrl;
    } catch (e) { toast.error('Cannot start OAuth', e.message); }
  }

  return (
    <div className="page">
      <PageHeader title="LinkedIn" icon="connections"
        sub="Connect a real LinkedIn account and publish for real — same as the Shopify token flow."
        actions={<>
          <Button variant="primary" icon="key" onClick={() => setConnecting(true)}>Connect LinkedIn</Button>
          <Button variant="ghost" icon="shield" onClick={() => setAppModal(true)}>{data.app.configured ? 'App credentials' : 'Add app credentials'}</Button>
        </>} />

      {live.length === 0 && (
        <Card className="card-pad" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}>
          <div className="row between wrap gap-16">
            <div className="row gap-16">
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 18%, transparent)', color: 'var(--warning)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={20} /></div>
              <div>
                <b>No live LinkedIn account connected</b>
                <div className="tiny dim">{sandboxes.length ? `You have ${sandboxes.length} sandbox connection(s) — publishing there is simulated.` : 'Paste an access token to go live in under a minute.'}</div>
              </div>
            </div>
            <Button variant="primary" icon="key" onClick={() => setConnecting(true)}>Connect for real</Button>
          </div>
        </Card>
      )}

      <Card className="card-pad" style={{ marginBottom: 16 }}>
        <div className="row between wrap gap-16">
          <div className="row gap-16">
            <div style={{ width: 42, height: 42, borderRadius: 10, background: '#0A66C2', display: 'grid', placeItems: 'center', color: '#fff', fontWeight: 700 }}>in</div>
            <div>
              <div className="row gap-8"><b>OAuth app</b>{data.app.configured ? <Badge variant="success" dot>configured ({data.app.source})</Badge> : <Badge variant="warning" dot>not set</Badge>}</div>
              <div className="tiny dim">Optional. Needed only for the “Sign in with LinkedIn” button, token refresh and scope introspection.</div>
            </div>
          </div>
          {data.app.configured && <Button size="sm" icon="external" onClick={startOauth}>Sign in with LinkedIn</Button>}
        </div>
        <div className="divider" />
        <div className="tiny dim">Redirect URL to register in your LinkedIn app → <span className="mono">{data.redirectUri}</span></div>
      </Card>

      <Card>
        <CardHead title="LinkedIn connections" sub={`${live.length} live · ${sandboxes.length} sandbox`} />
        {data.connections.length === 0 && <div className="empty" style={{ padding: 30 }}><div className="small">Nothing connected yet.</div></div>}
        {data.connections.map((c) => (
          <div key={c.id} className="row between" style={{ padding: '14px 18px', borderBottom: '1px solid var(--border)', flexWrap: 'wrap', gap: 12 }}>
            <div style={{ minWidth: 240 }}>
              <div className="row gap-8">
                <b className="small">{c.label}</b>
                {c.sandbox ? <Badge variant="warning" dot>sandbox · simulated</Badge> : <Badge variant="success" dot>live</Badge>}
                <Badge>{c.authorKind === 'ORGANIZATION' ? 'Company Page' : 'Member'}</Badge>
              </div>
              <div className="tiny dim">{c.authorName || 'unknown author'} · <span className="mono">{c.authorUrn || '—'}</span></div>
              <div className="tiny dim">
                {c.scopes?.length ? `${c.scopes.join(' ')}` : 'no scopes recorded'}
                {c.tokenExpiresAt ? ` · token expires ${fmt.rel(c.tokenExpiresAt)}` : ''}
                {c.canRefresh ? ' · auto-refresh on' : ''}
                {` · ${c.publishedCount} published`}
              </div>
            </div>
            <div className="row gap-6 wrap">
              {!c.sandbox && c.availableTargets?.length > 1 && <AuthorPicker connection={c} onDone={reload} />}
              {!c.sandbox && <Button size="sm" variant="ghost" loading={testing === c.id} onClick={() => test(c)}>Test live</Button>}
              <Button size="sm" variant="ghost" onClick={() => setRemoving(c)}><Icon name="trash" size={14} /></Button>
            </div>
          </div>
        ))}
      </Card>

      {connecting && <ConnectModal status={data} onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); reload(); }} />}
      {appModal && <AppModal status={data} onClose={() => setAppModal(false)} onDone={() => { setAppModal(false); reload(); }} />}
      {removing && <ConfirmDialog title={`Disconnect ${removing.label}?`} danger confirmLabel="Disconnect"
        body="The stored LinkedIn token is deleted and publishing to this account stops. History is kept."
        onConfirm={async () => { await api.del(`/connections/${removing.id}`); toast.success('Disconnected'); reload(); }}
        onClose={() => setRemoving(null)} />}
    </div>
  );
}

function AuthorPicker({ connection, onDone }) {
  const [busy, setBusy] = useState(false);
  async function change(e) {
    const authorUrn = e.target.value;
    if (authorUrn === connection.authorUrn) return;
    setBusy(true);
    try { await api.put(`/linkedin/connections/${connection.id}/author`, { authorUrn }); toast.success('Author changed'); onDone(); }
    catch (err) { toast.error('Failed', err.message); }
    setBusy(false);
  }
  return (
    <Select value={connection.authorUrn || ''} onChange={change} disabled={busy} style={{ width: 200 }}>
      {connection.availableTargets.map((t) => <option key={t.id} value={t.id}>{t.kind === 'ORGANIZATION' ? `Page — ${t.name}` : `You — ${t.name}`}</option>)}
    </Select>
  );
}

function ConnectModal({ status, onClose, onDone }) {
  const [accessToken, setAccessToken] = useState('');
  const [refreshToken, setRefreshToken] = useState('');
  const [label, setLabel] = useState('LinkedIn');
  const [authorUrn, setAuthorUrn] = useState('');
  const [probe, setProbe] = useState(null);
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(true);

  async function inspect() {
    setBusy(true);
    try {
      const r = await api.post('/linkedin/inspect', { accessToken });
      setProbe(r.data);
      if (r.data.member) {
        setAuthorUrn(r.data.member.id);
        setLabel(`LinkedIn — ${r.data.member.name}`);
      } else if (r.data.organizations?.length) {
        setAuthorUrn(r.data.organizations[0].id);
        setLabel(`LinkedIn — ${r.data.organizations[0].name}`);
      }
      if (r.data.identityError) toast.error('Token works, but LinkedIn won’t name the owner', 'Add the OpenID Connect product, or enter the author URN manually below.');
      else if (!r.data.canPublish) toast.error('Token cannot publish', 'Missing w_member_social — add the “Share on LinkedIn” product to your app.');
      else toast.success('Token is valid', `Signed in as ${r.data.member.name}`);
    } catch (e) { setProbe(null); toast.error('Token rejected', e.message); }
    setBusy(false);
  }

  async function connect() {
    setBusy(true);
    try {
      const r = await api.post('/linkedin/connect-token', { accessToken, refreshToken: refreshToken || undefined, label, authorUrn: authorUrn || undefined });
      toast.success('LinkedIn connected — live', `Publishing as ${r.data.connection.authorName}`);
      onDone();
    } catch (e) { toast.error('Could not connect', e.message); setBusy(false); }
  }

  return (
    <Modal title="Connect LinkedIn for real" onClose={onClose} wide
      footer={<>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="ghost" loading={busy} disabled={!accessToken} onClick={inspect}>Validate token</Button>
        <Button variant="primary" icon="key" loading={busy} disabled={!accessToken} onClick={connect}>Connect live</Button>
      </>}>
      <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 16 }}>
        <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setShowHelp((s) => !s)}>
          <b className="small">How to get a LinkedIn access token</b>
          <Icon name={showHelp ? 'chevronD' : 'chevronR'} size={15} className="dim" />
        </div>
        {showHelp && (
          <ol className="small muted" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
            <li>Go to <b>linkedin.com/developers/apps</b> → <b>Create app</b> (a LinkedIn Company Page is required to own the app).</li>
            <li>On the <b>Products</b> tab add <b>Share on LinkedIn</b> and <b>Sign In with LinkedIn using OpenID Connect</b> — both are self-serve and approve instantly.</li>
            <li>Open the <b>Auth</b> tab → <b>OAuth 2.0 tools</b> → <b>Create token</b>, and tick <b>all</b> of <span className="mono tiny">openid profile email w_member_social</span>, then authorize.</li>
            <li><b>Both products matter.</b> <span className="mono tiny">w_member_social</span> alone lets the token post but not identify you, so there is no author to post <i>as</i> — that is the “403 Not enough permissions… me.GET” error. Scopes are baked into a token when it is minted, so after adding a product you must generate a <b>new</b> token.</li>
            <li>Copy the access token and paste it below. It is valid for 60 days.</li>
            <li>To post as a <b>Company Page</b>, also request the <b>Community Management API</b> product and include <span className="mono tiny">w_organization_social</span>.</li>
          </ol>
        )}
      </div>

      <Field label="Access token" hint="Encrypted at rest (AES-256-GCM). Validated against the LinkedIn API before it is saved.">
        <Input mono type="password" value={accessToken} onChange={(e) => { setAccessToken(e.target.value); setProbe(null); }} placeholder="AQV…" autoFocus />
      </Field>

      {probe && (
        <div className="card card-pad small" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
          {probe.member ? (
            <div className="row gap-8"><Icon name="check" size={14} style={{ color: 'var(--success)' }} /><b>{probe.member.name}</b><span className="mono tiny dim">{probe.member.id}</span></div>
          ) : (
            <div className="row gap-8" style={{ color: 'var(--warning)' }}><Icon name="alert" size={14} /><b>Token is live, but LinkedIn won’t say who owns it</b></div>
          )}
          <div className="tiny dim mt-8">
            {probe.introspected ? `Scopes: ${probe.scopes.join(' ') || 'none reported'}` : 'Scopes unknown — save your app Client ID/Secret to enable introspection'}
            {probe.expiresAt ? ` · expires ${fmt.rel(probe.expiresAt)}` : ''}
          </div>
          {probe.organizations.length > 0 && <div className="tiny dim mt-8">{probe.organizations.length} Company Page(s) available.</div>}
          {!probe.canPublish && <div className="tiny mt-8" style={{ color: 'var(--warning)' }}>This token is missing w_member_social — it cannot publish.</div>}
          {probe.identityError && <div className="tiny muted mt-8">{probe.identityError}</div>}
        </div>
      )}

      {probe?.needsAuthorUrn ? (
        <Field label="Author URN" hint="Paste the URN to publish as. Recommended instead: add the OpenID Connect product to your app and generate a fresh token — then this is filled in automatically.">
          <Input mono value={authorUrn} onChange={(e) => setAuthorUrn(e.target.value)} placeholder="urn:li:person:AbC123xYz  or  urn:li:organization:12345678" />
        </Field>
      ) : (
        <Field label="Publish as" hint="Your member profile, or a Company Page you administer.">
          <Select value={authorUrn} onChange={(e) => setAuthorUrn(e.target.value)} disabled={!probe}>
            {!probe && <option value="">Validate the token first…</option>}
            {(probe?.targets || []).map((t) => <option key={t.id} value={t.id}>{t.kind === 'ORGANIZATION' ? `Page — ${t.name}` : `You — ${t.name}`}</option>)}
          </Select>
        </Field>
      )}

      <Field label="Label" hint="How this account shows up on your board."><Input value={label} onChange={(e) => setLabel(e.target.value)} /></Field>

      <Field label="Refresh token (optional)" hint={status.app.configured ? 'If your app has refresh tokens enabled, paste it and the access token renews itself automatically.' : 'Save your app Client ID/Secret first to enable automatic refresh.'}>
        <Input mono type="password" value={refreshToken} onChange={(e) => setRefreshToken(e.target.value)} placeholder="optional" />
      </Field>
    </Modal>
  );
}

function AppModal({ status, onClose, onDone }) {
  const [clientId, setClientId] = useState('');
  const [clientSecret, setClientSecret] = useState('');
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try { await api.put('/linkedin/app', { clientId, clientSecret }); toast.success('LinkedIn app saved', 'No restart needed.'); onDone(); }
    catch (e) { toast.error('Failed', e.message); setBusy(false); }
  }
  async function clear() {
    try { await api.del('/linkedin/app'); toast.success('Cleared'); onDone(); } catch (e) { toast.error('Failed', e.message); }
  }

  return (
    <Modal title="LinkedIn app credentials" onClose={onClose}
      footer={<>
        {status.app.configured && status.app.source === 'ui' && <Button variant="ghost" onClick={clear}>Remove</Button>}
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant="primary" loading={busy} disabled={!clientId || !clientSecret} onClick={save}>Save</Button>
      </>}>
      <div className="card card-pad small muted" style={{ background: 'var(--surface-2)', marginBottom: 14 }}>
        Optional — a pasted access token already publishes for real. Add these to unlock the “Sign in with LinkedIn” button, automatic token refresh and scope introspection.
        <div className="mt-8">Register this redirect URL in your app’s <b>Auth</b> tab: <span className="mono tiny">{status.redirectUri}</span></div>
      </div>
      <Field label="Client ID"><Input mono value={clientId} onChange={(e) => setClientId(e.target.value)} placeholder={status.app.clientId || '86xxxxxxxxxxxx'} /></Field>
      <Field label="Client Secret" hint="Encrypted at rest. Never sent back to the browser."><Input mono type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} placeholder="WPL_AP1…" /></Field>
    </Modal>
  );
}
