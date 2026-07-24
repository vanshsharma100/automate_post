import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Icon, Button, cx, toast, Modal } from '../ui.jsx';

export function PageHeader({ title, sub, actions, icon }) {
  return (
    <div className="row between" style={{ marginBottom: 22, alignItems: 'flex-end' }}>
      <div>
        <div className="row gap-8">{icon && <Icon name={icon} size={20} className="dim" />}<h1 style={{ fontSize: 24 }}>{title}</h1></div>
        {sub && <p className="muted small" style={{ marginTop: 4 }}>{sub}</p>}
      </div>
      <div className="row gap-8">{actions}</div>
    </div>
  );
}

export function PlatformTag({ platform, showLabel = true, size = 8 }) {
  const { platformMeta } = useApp();
  const m = platformMeta[platform] || { label: platform, accent: '#9AA1B1' };
  return (
    <span className="row gap-6" style={{ alignItems: 'center' }}>
      <span style={{ width: size, height: size, borderRadius: 3, background: m.accent, flexShrink: 0 }} />
      {showLabel && <span className="small">{m.label}</span>}
    </span>
  );
}

const MODES = [
  { value: 'MANUAL', label: 'Manual' },
  { value: 'SHADOW', label: 'Shadow' },
  { value: 'AUTOPILOT', label: 'Autopilot' },
  { value: 'PAUSED', label: 'Paused' },
];
export function ModeSelect({ connection, onChange }) {
  const [mode, setMode] = useState(connection.mode);
  const [busy, setBusy] = useState(false);
  async function set(m) {
    setBusy(true);
    try { await api.put(`/connections/${connection.id}/mode`, { mode: m }); setMode(m); onChange?.(m); toast.success(`${connection.label} → ${m.toLowerCase()}`); }
    catch (e) { toast.error('Could not change mode', e.message); }
    setBusy(false);
  }
  const color = mode === 'AUTOPILOT' ? 'var(--accent)' : mode === 'SHADOW' ? 'var(--info)' : mode === 'PAUSED' ? 'var(--danger)' : 'var(--text-2)';
  return (
    <select className="select" value={mode} disabled={busy} onChange={(e) => set(e.target.value)}
      style={{ width: 'auto', padding: '5px 26px 5px 10px', fontSize: 12, fontWeight: 600, color, borderColor: 'var(--border)' }}>
      {MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
    </select>
  );
}

export function ConfirmDialog({ title, body, confirmLabel = 'Confirm', danger, onConfirm, onClose }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title={title} onClose={onClose} footer={
      <>
        <Button variant="ghost" onClick={onClose}>Cancel</Button>
        <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={async () => { setBusy(true); try { await onConfirm(); onClose(); } catch (e) { toast.error('Failed', e.message); setBusy(false); } }}>{confirmLabel}</Button>
      </>
    }>
      <p className="muted small">{body}</p>
    </Modal>
  );
}

export function Loading({ rows = 3 }) {
  return <div className="col gap-8">{Array.from({ length: rows }).map((_, i) => <div key={i} className="skel" style={{ height: 60 }} />)}</div>;
}

export function SectionError({ error }) {
  return <div className="card card-pad" style={{ borderColor: 'color-mix(in srgb, var(--danger) 30%, var(--border))' }}>
    <div className="row gap-8" style={{ color: 'var(--danger)' }}><Icon name="alert" size={16} /> <b className="small">Couldn’t load</b></div>
    <div className="small muted mt-8">{error?.message || 'Unknown error'}</div>
  </div>;
}
