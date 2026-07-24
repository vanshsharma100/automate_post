import React, { useState } from 'react';
import { api, setToken } from '../api.js';
import { Card, Field, Input, Button, Icon, toast } from '../ui.jsx';

export function Login({ onLoggedIn, forcedUser }) {
  if (forcedUser?.mustChangePassword) return <ChangePassword user={forcedUser} onLoggedIn={onLoggedIn} />;
  return <SignIn onLoggedIn={onLoggedIn} />;
}

function SignIn({ onLoggedIn }) {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true); setErr('');
    try {
      const r = await api.post('/auth/login', { username, password });
      setToken(r.accessToken);
      await onLoggedIn(r.user);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <div className="row" style={{ justifyContent: 'center', marginBottom: 22 }}>
          <div className="brand" style={{ fontSize: 20 }}><span className="brand-mark">A</span>AUTOPOST</div>
        </div>
        <Card pad>
          <h2 style={{ fontSize: 18, marginBottom: 4 }}>Sign in</h2>
          <p className="muted small" style={{ marginBottom: 18 }}>Control room for autonomous content.</p>
          <form onSubmit={submit}>
            <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus autoComplete="username" /></Field>
            <Field label="Password"><Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" placeholder="••••••••" /></Field>
            {err && <div className="small" style={{ color: 'var(--danger)', marginBottom: 12 }}>{err}</div>}
            <Button variant="primary" block type="submit" loading={busy}>Sign in <Icon name="chevronR" size={15} /></Button>
          </form>
        </Card>
        <p className="dim tiny center mt-16">First login uses the bootstrap credentials from your <span className="mono">.env</span> and forces a password change.</p>
      </div>
    </div>
  );
}

function ChangePassword({ user, onLoggedIn }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  async function submit(e) {
    e.preventDefault();
    if (next !== confirm) return setErr('Passwords do not match');
    setBusy(true); setErr('');
    try {
      const r = await api.post('/auth/change-password', { currentPassword: current, newPassword: next });
      setToken(r.accessToken);
      toast.success('Password updated', 'Welcome in.');
      await onLoggedIn(r.user);
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  return (
    <div className="login-wrap">
      <div className="login-card">
        <Card pad>
          <div className="row gap-8" style={{ marginBottom: 6 }}><Icon name="shield" size={18} className="dim" /><h2 style={{ fontSize: 17 }}>Set a new password</h2></div>
          <p className="muted small" style={{ marginBottom: 18 }}>The bootstrap password is considered public. Choose a new one to continue — everything else is locked until you do.</p>
          <form onSubmit={submit}>
            <Field label="Current (bootstrap) password"><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoFocus /></Field>
            <Field label="New password" hint="At least 12 characters. Not a common password, not your username."><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></Field>
            <Field label="Confirm new password"><Input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} /></Field>
            {err && <div className="small" style={{ color: 'var(--danger)', marginBottom: 12 }}>{err}</div>}
            <Button variant="primary" block type="submit" loading={busy}>Update password & continue</Button>
          </form>
        </Card>
      </div>
    </div>
  );
}
