import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Field, Input, Select, Toggle, Modal, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, Loading } from '../components/common.jsx';

export function Settings() {
  const [tab, setTab] = useState('team');
  return (
    <div className="page">
      <PageHeader title="Settings" icon="settings" />
      <div className="pill-tabs">
        {[['team', 'Team & Access'], ['security', 'Security'], ['budget', 'Budget'], ['general', 'General']].map(([k, l]) => <button key={k} className={cx(tab === k && 'active')} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'team' && <Team />}
      {tab === 'security' && <Security />}
      {tab === 'budget' && <Budget />}
      {tab === 'general' && <General />}
    </div>
  );
}

function Team() {
  const { data, loading, reload } = useAsync(() => api.get('/users').then((r) => r.data));
  const [adding, setAdding] = useState(false);
  const [aclFor, setAclFor] = useState(null);
  if (loading) return <Loading rows={3} />;
  return (
    <div>
      <div className="row between" style={{ marginBottom: 14 }}><p className="muted small">Roles gate broad capability; the per-connection matrix decides who handles which platform.</p><Button icon="plus" onClick={() => setAdding(true)}>Add teammate</Button></div>
      <Card>
        <table className="table">
          <thead><tr><th>User</th><th>Role</th><th>Status</th><th>Last login</th><th></th></tr></thead>
          <tbody>{data.map((u) => (
            <tr key={u.id}>
              <td><div className="row gap-8"><div className="pv-avatar" style={{ width: 28, height: 28, fontSize: 12 }}>{u.username[0].toUpperCase()}</div><div><b className="small">{u.username}</b>{u.email && <div className="tiny dim">{u.email}</div>}</div></div></td>
              <td><Badge variant={u.role === 'SUPER_ADMIN' ? 'accent' : ''}>{u.role.replace('_', ' ')}</Badge></td>
              <td><Badge variant={u.status === 'ACTIVE' ? 'success' : 'warning'} dot>{u.status.toLowerCase()}</Badge>{u.mustChangePassword && <Badge variant="warning" style={{ marginLeft: 6 }}>must set password</Badge>}</td>
              <td className="tiny dim mono">{u.lastLoginAt ? fmt.rel(u.lastLoginAt) : 'never'}</td>
              <td className="right">{u.role !== 'SUPER_ADMIN' && <Button size="sm" variant="ghost" icon="shield" onClick={() => setAclFor(u)}>Access</Button>}</td>
            </tr>
          ))}</tbody>
        </table>
      </Card>
      {adding && <AddUser onClose={() => setAdding(false)} onDone={() => { setAdding(false); reload(); }} />}
      {aclFor && <AclMatrix user={aclFor} onClose={() => setAclFor(null)} />}
    </div>
  );
}

function AddUser({ onClose, onDone }) {
  const [username, setUsername] = useState('');
  const [role, setRole] = useState('EDITOR');
  const [busy, setBusy] = useState(false);
  const [temp, setTemp] = useState(null);
  return (
    <Modal title="Add teammate" onClose={onClose} footer={temp ? <Button variant="primary" onClick={onDone}>Done</Button> : <><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { const r = await api.post('/users', { username, role }); setTemp(r.data.tempPassword); } catch (e) { toast.error('Failed', e.message); setBusy(false); } }}>Create</Button></>}>
      {temp ? <div><p className="small muted">Share this one-time password with <b>{username}</b>. They’ll be forced to change it on first login.</p><div className="card card-pad mono" style={{ background: 'var(--surface-2)', fontSize: 16, textAlign: 'center', marginTop: 12 }}>{temp}</div></div> : <>
        <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus /></Field>
        <Field label="Role" hint="EDITOR works only on permitted connections; VIEWER is read-only."><Select value={role} onChange={(e) => setRole(e.target.value)}><option value="ADMIN">Admin</option><option value="EDITOR">Editor</option><option value="VIEWER">Viewer</option></Select></Field>
      </>}
    </Modal>
  );
}

const PERMS = [['canView', 'View'], ['canEdit', 'Edit'], ['canPublish', 'Publish'], ['canManageCreds', 'Creds'], ['canToggleMode', 'Mode']];
function AclMatrix({ user, onClose }) {
  const { data, loading } = useAsync(() => api.get(`/users/${user.id}/access`).then((r) => r.data));
  const [rows, setRows] = useState(null);
  const [busy, setBusy] = useState(false);
  React.useEffect(() => { if (data) setRows(data); }, [data]);
  if (loading || !rows) return <Modal title="Access" onClose={onClose}><Loading rows={2} /></Modal>;
  function toggle(cid, perm) { setRows(rows.map((r) => (r.connectionId === cid ? { ...r, [perm]: !r[perm] } : r))); }
  return (
    <Modal title={`Access — ${user.username}`} wide onClose={onClose} footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" loading={busy} onClick={async () => { setBusy(true); try { await api.put(`/users/${user.id}/access`, { access: rows }); toast.success('Access updated'); onClose(); } catch (e) { toast.error('Failed', e.message); setBusy(false); } }}>Save matrix</Button></>}>
      <p className="tiny dim" style={{ marginBottom: 10 }}>Effective permission = role allows AND box checked. Editors never get Creds/Mode regardless.</p>
      <table className="table">
        <thead><tr><th>Connection</th>{PERMS.map(([, l]) => <th key={l} className="center">{l}</th>)}</tr></thead>
        <tbody>{rows.map((r) => (
          <tr key={r.connectionId}><td className="small">{r.label}</td>
            {PERMS.map(([k]) => <td key={k} className="center"><input type="checkbox" checked={!!r[k]} onChange={() => toggle(r.connectionId, k)} style={{ accentColor: 'var(--accent)', width: 16, height: 16 }} /></td>)}
          </tr>
        ))}</tbody>
      </table>
    </Modal>
  );
}

function Security() {
  const { data, loading } = useAsync(async () => {
    const [sessions, audit] = await Promise.all([api.get('/auth/sessions'), api.get('/audit-logs?limit=30')]);
    return { sessions: sessions.data, audit: audit.data };
  });
  if (loading) return <Loading rows={3} />;
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <Card>
        <CardHead title="Active sessions" sub="Sign out remote devices" />
        {data.sessions.map((s) => (
          <div key={s.id} className="row between" style={{ padding: '10px 16px', borderBottom: '1px solid var(--border)' }}>
            <div><div className="small">{s.current ? <Badge variant="accent">this device</Badge> : 'Session'}</div><div className="tiny dim mono">{s.ipAddress || 'local'} · {fmt.rel(s.createdAt)}</div></div>
            {!s.current && <Button size="sm" variant="ghost" onClick={() => api.del(`/auth/sessions/${s.id}`).then(() => toast.success('Signed out'))}>Revoke</Button>}
          </div>
        ))}
      </Card>
      <Card>
        <CardHead title="Audit log" sub="Every security- or money-relevant action" />
        <div style={{ maxHeight: 420, overflowY: 'auto' }}>
          {data.audit.map((a) => (
            <div key={a.id} className="check-row" style={{ padding: '8px 16px' }}>
              <Icon name="shield" size={14} className="dim" style={{ marginTop: 2 }} />
              <div className="grow"><span className="small mono">{a.action}</span><div className="tiny dim">{a.username} · {a.entityType || ''} · {fmt.rel(a.createdAt)}</div></div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function Budget() {
  const { data, loading, reload } = useAsync(async () => {
    const [budget, usage] = await Promise.all([api.get('/brain/budget'), api.get('/brain/usage')]);
    return { budget: budget.data, usage: usage.data };
  });
  const [val, setVal] = useState('');
  React.useEffect(() => { if (data) setVal(data.budget.costBudgetUsd || 50); }, [data]);
  if (loading) return <Loading rows={2} />;
  const pct = data.budget.costBudgetUsd ? Math.round((data.budget.monthToDate / data.budget.costBudgetUsd) * 100) : 0;
  return (
    <div className="grid grid-2" style={{ alignItems: 'start' }}>
      <Card className="card-pad">
        <div className="card-title">Monthly AI budget</div>
        <p className="tiny dim" style={{ margin: '4px 0 14px' }}>Soft warning at 80%, hard stop at 100% — a runaway loop can’t drain your keys.</p>
        <div className="row between small"><span className="muted">Spent this month</span><b className="mono">{fmt.money(data.budget.monthToDate)} / {fmt.money(data.budget.costBudgetUsd || 0)}</b></div>
        <div className={cx('progress', pct >= 80 && 'warn', pct >= 100 && 'danger')} style={{ marginTop: 8 }}><span style={{ width: `${Math.min(100, pct)}%` }} /></div>
        <Field label="Budget (USD / month)" ><Input type="number" value={val} onChange={(e) => setVal(e.target.value)} /></Field>
        <Button variant="primary" onClick={async () => { await api.put('/brain/budget', { costBudgetUsd: +val }); toast.success('Budget saved'); reload(); }}>Save budget</Button>
      </Card>
      <Card className="card-pad">
        <div className="card-title">Usage</div>
        <div className="grid grid-2 mt-16" style={{ gap: 12 }}>
          <div className="stat"><div className="v">{fmt.money(data.usage.totalCost)}</div><div className="l">All-time cost</div></div>
          <div className="stat"><div className="v">{fmt.int(data.usage.calls)}</div><div className="l">AI calls</div></div>
          <div className="stat"><div className="v">{fmt.int(data.usage.totalIn + data.usage.totalOut)}</div><div className="l">Tokens</div></div>
          <div className="stat"><div className="v">{fmt.money(data.usage.monthToDate)}</div><div className="l">This month</div></div>
        </div>
      </Card>
    </div>
  );
}

function General() {
  const { data, loading } = useAsync(() => api.get('/settings').then((r) => r.data));
  const [name, setName] = useState('');
  React.useEffect(() => { if (data) setName(data.name); }, [data]);
  if (loading) return <Loading rows={2} />;
  return (
    <Card className="card-pad" style={{ maxWidth: 520 }}>
      <Field label="Workspace name"><Input value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field label="Timezone"><Input value={data.settings?.timezone || 'Asia/Kolkata'} readOnly /></Field>
      <Field label="Minimum SEO score for autopilot"><Input value={data.settings?.seoMinScore || 75} readOnly /></Field>
      <Button variant="primary" onClick={async () => { await api.put('/settings', { name }); toast.success('Saved'); }}>Save</Button>
    </Card>
  );
}
