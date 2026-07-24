import React, { useEffect, useMemo, useState } from 'react';
import { useApp } from '../App.jsx';
import { Icon, cx } from '../ui.jsx';

export function CommandPalette({ onClose }) {
  const { navigate } = useApp();
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);

  const commands = useMemo(() => [
    { label: 'Go to Dashboard', icon: 'dashboard', run: () => navigate('/') },
    { label: 'Open Composer', icon: 'composer', run: () => navigate('/composer') },
    { label: 'Go to Drafts', icon: 'drafts', run: () => navigate('/drafts') },
    { label: 'Open Calendar', icon: 'calendar', run: () => navigate('/calendar') },
    { label: 'Configure the Brain', icon: 'brain', run: () => navigate('/brain') },
    { label: 'Edit Knowledge boxes', icon: 'knowledge', run: () => navigate('/knowledge') },
    { label: 'Manage Connections', icon: 'connections', run: () => navigate('/connections') },
    { label: 'Shopify catalogue', icon: 'shopify', run: () => navigate('/shopify') },
    { label: 'View History', icon: 'history', run: () => navigate('/history') },
    { label: 'Media library', icon: 'media', run: () => navigate('/media') },
    { label: 'Team & Settings', icon: 'settings', run: () => navigate('/settings') },
  ], [navigate]);

  const filtered = commands.filter((c) => c.label.toLowerCase().includes(q.toLowerCase()));
  useEffect(() => setI(0), [q]);

  function onKey(e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(filtered.length - 1, x + 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
    if (e.key === 'Enter') { e.preventDefault(); filtered[i]?.run(); onClose(); }
    if (e.key === 'Escape') onClose();
  }

  return (
    <div className="overlay" style={{ alignItems: 'flex-start' }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal cmdk" onKeyDown={onKey}>
        <div className="row" style={{ padding: '0 6px', borderBottom: '1px solid var(--border)' }}>
          <Icon name="search" size={18} className="dim" style={{ marginLeft: 12 }} />
          <input className="input" style={{ border: 'none', background: 'transparent', fontSize: 16 }} autoFocus placeholder="Jump to…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
        <div style={{ padding: '6px 0', maxHeight: 340, overflowY: 'auto' }}>
          {filtered.map((c, idx) => (
            <div key={c.label} className={cx('cmdk-item', idx === i && 'active')} onMouseEnter={() => setI(idx)} onClick={() => { c.run(); onClose(); }}>
              <Icon name={c.icon} size={16} /> {c.label}
              {idx === i && <span className="kbd k">↵</span>}
            </div>
          ))}
          {filtered.length === 0 && <div className="dim small" style={{ padding: '14px 18px' }}>No matches</div>}
        </div>
      </div>
    </div>
  );
}
