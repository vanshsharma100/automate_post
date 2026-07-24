import React, { useEffect, useState, useRef } from 'react';
import { useApp } from '../App.jsx';
import { api, getToken } from '../api.js';
import { Icon, Button, Toggle, cx, toast, Badge, ErrorBoundary } from '../ui.jsx';
import { emitBus } from '../bus.js';
import { CommandPalette } from './CommandPalette.jsx';

import { Dashboard } from '../screens/Dashboard.jsx';
import { Composer } from '../screens/Composer.jsx';
import { Drafts } from '../screens/Drafts.jsx';
import { Calendar } from '../screens/Calendar.jsx';
import { Brain } from '../screens/Brain.jsx';
import { Knowledge } from '../screens/Knowledge.jsx';
import { Connections } from '../screens/Connections.jsx';
import { Shopify } from '../screens/Shopify.jsx';
import { LinkedIn } from '../screens/LinkedIn.jsx';
import { GoogleBusiness } from '../screens/GoogleBusiness.jsx';
import { Facebook, Instagram } from '../screens/Meta.jsx';
import { History } from '../screens/History.jsx';
import { Media } from '../screens/Media.jsx';
import { Settings } from '../screens/Settings.jsx';

const NAV = [
  { section: null, items: [
    { id: 'dashboard', label: 'Dashboard', icon: 'dashboard', path: '/' },
    { id: 'composer', label: 'Composer', icon: 'composer', path: '/composer' },
    { id: 'drafts', label: 'Drafts', icon: 'drafts', path: '/drafts', badge: 'drafts' },
    { id: 'calendar', label: 'Calendar', icon: 'calendar', path: '/calendar' },
  ] },
  { section: 'Configure', items: [
    { id: 'brain', label: 'Brain', icon: 'brain', path: '/brain' },
    { id: 'knowledge', label: 'Knowledge', icon: 'knowledge', path: '/knowledge' },
    { id: 'connections', label: 'Connections', icon: 'connections', path: '/connections', badge: 'connections' },
    { id: 'shopify', label: 'Shopify', icon: 'shopify', path: '/shopify' },
    { id: 'linkedin', label: 'LinkedIn', icon: 'linkedin', path: '/linkedin' },
    { id: 'googlebusiness', label: 'Google Business', icon: 'mapPin', path: '/googlebusiness' },
    { id: 'facebook', label: 'Facebook', icon: 'facebook', path: '/facebook' },
    { id: 'instagram', label: 'Instagram', icon: 'instagram', path: '/instagram' },
  ] },
  { section: 'Operate', items: [
    { id: 'history', label: 'History', icon: 'history', path: '/history' },
    { id: 'media', label: 'Media', icon: 'media', path: '/media' },
    { id: 'settings', label: 'Settings', icon: 'settings', path: '/settings' },
  ] },
];

const SCREENS = { dashboard: Dashboard, composer: Composer, drafts: Drafts, calendar: Calendar, brain: Brain, knowledge: Knowledge, connections: Connections, shopify: Shopify, linkedin: LinkedIn, googlebusiness: GoogleBusiness, facebook: Facebook, instagram: Instagram, history: History, media: Media, settings: Settings };

export function Shell() {
  const app = useApp();
  const { route, navigate } = app;
  const [collapsed, setCollapsed] = useState(false);
  const [cmdk, setCmdk] = useState(false);
  const [counts, setCounts] = useState({ drafts: 0, connections: 0, unread: 0 });

  // Nav badge counts
  const refreshCounts = async () => {
    try {
      const [drafts, conns, notifs] = await Promise.all([
        api.get('/posts?status=NEEDS_REVIEW&limit=1'),
        api.get('/connections'),
        api.get('/notifications'),
      ]);
      setCounts({ drafts: drafts.meta?.total || 0, connections: (conns.data || []).length, unread: notifs.unread || 0 });
    } catch { /* ignore */ }
  };
  useEffect(() => { refreshCounts(); }, [route.name]);

  // SSE stream — reconnects with a *fresh* token so it survives access-token
  // rotation (a stale token in the URL would otherwise loop on 401 forever).
  useEffect(() => {
    let es = null, closed = false, timer = null;
    const connect = () => {
      const token = getToken();
      if (!token || closed) return;
      es = new EventSource(`/api/v1/events/stream?token=${encodeURIComponent(token)}`);
      es.addEventListener('notification', (e) => { const d = JSON.parse(e.data); toast(d.title, { variant: d.level === 'error' ? 'error' : d.level === 'warning' ? '' : 'success' }); refreshCounts(); });
      es.addEventListener('connection.health', (e) => emitBus('connection.health', JSON.parse(e.data)));
      es.addEventListener('post.updated', (e) => emitBus('post.updated', JSON.parse(e.data)));
      es.addEventListener('run.progress', (e) => emitBus('run.progress', JSON.parse(e.data)));
      es.onerror = () => { try { es.close(); } catch { /* ignore */ } if (!closed) timer = setTimeout(connect, 5000); };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); if (es) es.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ⌘K
  useEffect(() => {
    const h = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setCmdk(true); }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, []);

  const Screen = SCREENS[route.name] || Dashboard;

  return (
    <div className={cx('shell', collapsed && 'collapsed')}>
      <Topbar app={app} onSearch={() => setCmdk(true)} unread={counts.unread} onNotif={refreshCounts} />
      <aside className="sidebar">
        {NAV.map((group, gi) => (
          <div key={gi} className="nav-group">
            {group.section && !collapsed && <div className="nav-section-label">{group.section}</div>}
            {group.section && gi > 0 && collapsed && <div className="nav-sep" />}
            {group.items.map((it) => {
              const active = route.name === it.id;
              const badge = it.badge && counts[it.badge] ? counts[it.badge] : null;
              return (
                <div key={it.id} className={cx('nav-item', active && 'active')} onClick={() => navigate(it.path)} title={it.label}>
                  <Icon name={it.icon} className="ico" size={18} />
                  {!collapsed && <span>{it.label}</span>}
                  {!collapsed && badge ? <span className="nav-badge">{badge}</span> : null}
                </div>
              );
            })}
          </div>
        ))}
        <div className="grow" />
        <div className="nav-item" onClick={() => setCollapsed((c) => !c)} title="Collapse">
          <Icon name={collapsed ? 'chevronR' : 'chevronR'} className="ico" size={16} style={{ transform: collapsed ? '' : 'rotate(180deg)' }} />
          {!collapsed && <span className="small">Collapse</span>}
        </div>
      </aside>
      <main className="main">
        <ErrorBoundary resetKey={route.name + (route.param || '')}>
          <Screen key={route.name + (route.param || '')} />
        </ErrorBoundary>
      </main>
      {cmdk && <CommandPalette onClose={() => setCmdk(false)} />}
    </div>
  );
}

function Topbar({ app, onSearch, unread, onNotif }) {
  const { user, master, setMaster, navigate, logout, theme, toggleTheme } = app;
  const [confirm, setConfirm] = useState(false);
  const [menu, setMenu] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);

  async function setMasterMode(mode) {
    try { await api.put('/automation/master', { mode }); setMaster(mode); toast.success(`Autopilot ${mode === 'AUTOPILOT' ? 'ON' : mode === 'PAUSED' ? 'PAUSED' : 'MANUAL'}`); }
    catch (e) { toast.error('Failed', e.message); }
    setConfirm(false);
  }

  const on = master === 'AUTOPILOT';
  return (
    <header className="topbar">
      <div className="brand"><span className="brand-mark">A</span><span style={{ letterSpacing: '-.03em' }}>AUTOPOST</span></div>

      <div className="row gap-8" style={{ marginLeft: 8, cursor: 'pointer' }} onClick={() => (on ? setConfirm(true) : setMasterMode('AUTOPILOT'))}
        title="Master autopilot switch — never more than one click away">
        <Toggle on={on} onChange={() => (on ? setConfirm(true) : setMasterMode('AUTOPILOT'))} />
        <span className={cx('badge', on ? 'badge-accent' : master === 'PAUSED' ? 'badge-danger' : '')}>
          <Icon name="power" size={12} /> {on ? 'AUTOPILOT ON' : master === 'PAUSED' ? 'PAUSED' : 'MANUAL'}
        </span>
      </div>

      <button className="btn btn-ghost" style={{ marginLeft: 'auto', minWidth: 200, justifyContent: 'flex-start', color: 'var(--text-3)' }} onClick={onSearch}>
        <Icon name="search" size={15} /> Search… <span className="kbd" style={{ marginLeft: 'auto' }}>⌘K</span>
      </button>

      <Button variant="ghost" onClick={toggleTheme} title="Toggle theme"><span style={{ fontSize: 15 }}>{theme === 'dark' ? '☾' : '☀'}</span></Button>

      <div style={{ position: 'relative' }}>
        <Button variant="ghost" onClick={() => { setNotifOpen((o) => !o); }} title="Notifications">
          <Icon name="bell" size={17} />
          {unread > 0 && <span style={{ position: 'absolute', top: 4, right: 4, width: 8, height: 8, borderRadius: 999, background: 'var(--danger)' }} />}
        </Button>
        {notifOpen && <NotifPanel onClose={() => { setNotifOpen(false); onNotif(); }} navigate={navigate} />}
      </div>

      <div style={{ position: 'relative' }}>
        <div className="row gap-8" style={{ cursor: 'pointer' }} onClick={() => setMenu((m) => !m)}>
          <div className="pv-avatar" style={{ width: 30, height: 30, fontSize: 13 }}>{(user.username || '?')[0].toUpperCase()}</div>
          {!menu ? <Icon name="chevronD" size={14} className="dim" /> : <Icon name="chevronD" size={14} className="dim" />}
        </div>
        {menu && (
          <div className="card" style={{ position: 'absolute', right: 0, top: 40, width: 200, zIndex: 60, boxShadow: 'var(--shadow-pop)' }}>
            <div className="card-pad" style={{ padding: 12 }}>
              <div style={{ fontWeight: 600 }}>{user.username}</div>
              <div className="dim tiny">{user.role.replace('_', ' ')}</div>
            </div>
            <div className="divider" style={{ margin: 0 }} />
            <div className="nav-item" onClick={() => { setMenu(false); navigate('/settings'); }}><Icon name="settings" size={16} /> Settings</div>
            <div className="nav-item" onClick={logout} style={{ color: 'var(--danger)' }}><Icon name="logout" size={16} /> Sign out</div>
          </div>
        )}
      </div>

      {confirm && <ConfirmPause onConfirm={() => setMasterMode('PAUSED')} onKeep={() => setMasterMode('MANUAL')} onClose={() => setConfirm(false)} />}
    </header>
  );
}

function ConfirmPause({ onConfirm, onKeep, onClose }) {
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ maxWidth: 440 }}>
        <div className="modal-head"><h3 style={{ fontSize: 15 }}>Turn off autopilot?</h3></div>
        <div className="modal-body">
          <p className="muted small">This is the global kill switch. <b>Pause everything</b> drains queues and stops all scheduled publishing across every platform. <b>Switch to manual</b> stops new autopilot cycles but lets you keep publishing by hand.</p>
        </div>
        <div className="modal-foot">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={onKeep}>Switch to manual</Button>
          <Button variant="danger" onClick={onConfirm}>Pause everything</Button>
        </div>
      </div>
    </div>
  );
}

function NotifPanel({ onClose, navigate }) {
  const [items, setItems] = useState(null);
  useEffect(() => { api.get('/notifications').then((r) => setItems(r.data)).catch(() => setItems([])); }, []);
  async function readAll() { await api.post('/notifications/read-all'); onClose(); }
  return (
    <>
      <div style={{ position: 'fixed', inset: 0, zIndex: 55 }} onClick={onClose} />
      <div className="card" style={{ position: 'absolute', right: 0, top: 40, width: 340, zIndex: 60, boxShadow: 'var(--shadow-pop)' }}>
        <div className="card-head"><div className="card-title">Notifications</div><Button size="sm" variant="ghost" onClick={readAll}>Mark all read</Button></div>
        <div style={{ maxHeight: 380, overflowY: 'auto' }}>
          {!items ? <div className="card-pad">Loading…</div> : items.length === 0 ? <div className="empty" style={{ padding: 28 }}><div className="small">No notifications</div></div> :
            items.map((n) => (
              <div key={n.id} className="check-row" style={{ padding: '10px 14px', cursor: n.link ? 'pointer' : 'default' }} onClick={() => { if (n.link) { navigate(n.link); onClose(); } }}>
                <span className={cx('status-dot', n.level === 'error' ? 's-ERROR' : n.level === 'warning' ? 's-DEGRADED' : 's-CONNECTED')} style={{ marginTop: 5 }} />
                <div><div className="small" style={{ fontWeight: 600 }}>{n.title}</div>{n.body && <div className="tiny dim">{n.body}</div>}<div className="tiny dim">{new Date(n.createdAt).toLocaleString()}</div></div>
                {!n.readAt && <span style={{ marginLeft: 'auto', width: 6, height: 6, borderRadius: 999, background: 'var(--accent)' }} />}
              </div>
            ))}
        </div>
      </div>
    </>
  );
}
