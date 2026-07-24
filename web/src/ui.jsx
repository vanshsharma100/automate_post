import React, { useState, useEffect, useCallback, createContext, useContext } from 'react';

export const cx = (...a) => a.filter(Boolean).join(' ');

// Catches any render-time throw (e.g. a screen destructuring null after an API
// error) so a single bad request can never blank the whole app.
export class ErrorBoundary extends React.Component {
  constructor(p) { super(p); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidUpdate(prev) { if (prev.resetKey !== this.props.resetKey && this.state.error) this.setState({ error: null }); }
  render() {
    if (this.state.error) {
      return (
        <div className="page">
          <div className="card card-pad" style={{ maxWidth: 560, margin: '10vh auto', borderColor: 'color-mix(in srgb, var(--danger) 30%, var(--border))' }}>
            <div className="row gap-8" style={{ color: 'var(--danger)' }}><span style={{ fontSize: 20 }}>⚠</span><b>Something went wrong on this screen</b></div>
            <div className="small muted mt-8" style={{ fontFamily: 'var(--font-mono)' }}>{String(this.state.error?.message || this.state.error)}</div>
            <div className="row gap-8 mt-16">
              <button className="btn" onClick={() => this.setState({ error: null })}>Try again</button>
              <button className="btn btn-primary" onClick={() => { window.location.href = '/'; }}>Back to dashboard</button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

// ── Formatters ────────────────────────────────────────────────────────────────
export const fmt = {
  bytes(n) {
    n = Number(n || 0);
    if (n < 1024) return `${n} B`;
    const u = ['KB', 'MB', 'GB', 'TB'];
    let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
  },
  money(n) { return `$${Number(n || 0).toFixed(2)}`; },
  int(n) { return Number(n || 0).toLocaleString('en-US'); },
  date(d) { if (!d) return '—'; return new Date(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }); },
  datetime(d) { if (!d) return '—'; return new Date(d).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }); },
  rel(d) {
    if (!d) return '—';
    const diff = new Date(d).getTime() - Date.now();
    const abs = Math.abs(diff);
    const m = Math.round(abs / 60000), h = Math.round(abs / 3600000), day = Math.round(abs / 86400000);
    const s = diff < 0 ? 'ago' : '';
    const p = diff < 0 ? '' : 'in ';
    if (m < 1) return 'just now';
    if (m < 60) return `${p}${m}m ${s}`.trim();
    if (h < 24) return `${p}${h}h ${s}`.trim();
    return `${p}${day}d ${s}`.trim();
  },
};

// ── Icons ─────────────────────────────────────────────────────────────────────
const P = {
  dashboard: 'M3 3h7v9H3zM14 3h7v5h-7zM14 12h7v9h-7zM3 15h7v6H3z',
  composer: 'M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z',
  drafts: 'M22 12h-6l-2 3h-4l-2-3H2M5 5h14l3 7v6a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2v-6z',
  calendar: 'M3 4h18v18H3zM3 10h18M8 2v4M16 2v4',
  brain: 'M9 3a3 3 0 0 0-3 3v1a3 3 0 0 0 0 6v1a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM15 3a3 3 0 0 1 3 3v1a3 3 0 0 1 0 6v1a3 3 0 0 1-6 0',
  knowledge: 'M4 19.5A2.5 2.5 0 0 1 6.5 17H20M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z',
  connections: 'M9 12a3 3 0 1 0 0-.01M15 12a3 3 0 1 0 0-.01M9 12h6M4 12H2M22 12h-2',
  shopify: 'M6 2 3 6v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V6l-3-4zM3 6h18M16 10a4 4 0 0 1-8 0',
  linkedin: 'M4 9h4v12H4zM6 3a2 2 0 1 0 0 4 2 2 0 0 0 0-4zM11 9h4v2a4 4 0 0 1 7 3v7h-4v-6a2 2 0 0 0-4 0v6h-3z',
  mapPin: 'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0zM12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  facebook: 'M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z',
  instagram: 'M2 7.5A5.5 5.5 0 0 1 7.5 2h9A5.5 5.5 0 0 1 22 7.5v9a5.5 5.5 0 0 1-5.5 5.5h-9A5.5 5.5 0 0 1 2 16.5zM12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM17.5 6.5h.01',
  history: 'M3 3v5h5M3.05 13A9 9 0 1 0 6 5.3L3 8M12 7v5l3 3',
  media: 'M3 3h18v18H3zM3 15l5-5 4 4 3-3 6 6M9 9a1.5 1.5 0 1 0 0-.01',
  settings: 'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z',
  search: 'M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16zM21 21l-4.3-4.3',
  bell: 'M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0',
  power: 'M12 2v10M18.4 6.6a9 9 0 1 1-12.8 0',
  check: 'M20 6 9 17l-5-5',
  x: 'M18 6 6 18M6 6l12 12',
  plus: 'M12 5v14M5 12h14',
  refresh: 'M23 4v6h-6M1 20v-6h6M3.5 9a9 9 0 0 1 14.8-3.4L23 10M1 14l4.7 4.4A9 9 0 0 0 20.5 15',
  trash: 'M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6',
  external: 'M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6M15 3h6v6M10 14 21 3',
  sparkles: 'M12 3l1.9 5.8L20 10l-6.1 1.2L12 17l-1.9-5.8L4 10l6.1-1.2zM19 3v4M21 5h-4',
  alert: 'M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01',
  play: 'M5 3l14 9-14 9z',
  pause: 'M6 4h4v16H6zM14 4h4v16h-4z',
  edit: 'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.1 2.1 0 0 1 3 3L12 15l-4 1 1-4z',
  filter: 'M22 3H2l8 9.5V19l4 2v-8.5z',
  chevronR: 'M9 18l6-6-6-6',
  chevronD: 'M6 9l6 6 6-6',
  logout: 'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9',
  key: 'M21 2l-2 2m-7.6 7.6a5 5 0 1 0-1.4 1.4L13 15l2 2 2-2 2 2 3-3-6-6zM10.5 13.5 8 16',
  shield: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
  users: 'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8',
  eye: 'M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
  send: 'M22 2 11 13M22 2l-7 20-4-9-9-4z',
  clock: 'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM12 6v6l4 2',
  layers: 'M12 2 2 7l10 5 10-5zM2 17l10 5 10-5M2 12l10 5 10-5',
  grid: 'M3 3h7v7H3zM14 3h7v7h-7zM14 14h7v7h-7zM3 14h7v7H3z',
};
export function Icon({ name, size = 18, className, stroke = 2 }) {
  const d = P[name] || P.dashboard;
  return (
    <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none"
      stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
      {d.split('M').filter(Boolean).map((seg, i) => <path key={i} d={'M' + seg} />)}
    </svg>
  );
}

// ── Basic components ──────────────────────────────────────────────────────────
export function Button({ variant = '', size = '', icon, children, className, block, loading, ...props }) {
  return (
    <button className={cx('btn', variant && `btn-${variant}`, size && `btn-${size}`, block && 'btn-block', !children && 'btn-icon', className)} disabled={loading || props.disabled} {...props}>
      {loading ? <span className="spinner" /> : icon && <Icon name={icon} size={size === 'sm' ? 14 : 16} />}
      {children}
    </button>
  );
}

export function Card({ children, className, pad, ...rest }) {
  return <div className={cx('card', pad && 'card-pad', className)} {...rest}>{children}</div>;
}
export function CardHead({ title, sub, right }) {
  return (
    <div className="card-head">
      <div><div className="card-title">{title}</div>{sub && <div className="card-sub">{sub}</div>}</div>
      {right}
    </div>
  );
}

export function Badge({ children, variant, dot, className }) {
  return <span className={cx('badge', variant && `badge-${variant}`, className)}>{dot && <span className="dot" />}{children}</span>;
}
export function StatusDot({ status }) { return <span className={cx('status-dot', `s-${status}`)} />; }
export function StatusBadge({ status }) {
  return <span className={cx('badge')}><span className={cx('status-dot', `s-${status}`)} />{String(status || '').replace(/_/g, ' ').toLowerCase()}</span>;
}

// SEO / score ring
export function Ring({ value = 0, size = 56, stroke = 5, label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const v = Math.max(0, Math.min(100, value));
  const color = v >= 75 ? 'var(--success)' : v >= 50 ? 'var(--warning)' : 'var(--danger)';
  return (
    <div className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--surface-3)" strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke}
          strokeDasharray={c} strokeDashoffset={c - (v / 100) * c} strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`} style={{ transition: 'stroke-dashoffset 500ms' }} />
      </svg>
      <span className="ring-num" style={{ fontSize: size * 0.3, color }}>{Math.round(v)}</span>
      {label && <span style={{ position: 'absolute', bottom: -16, fontSize: 10 }} className="dim">{label}</span>}
    </div>
  );
}

export function Toggle({ on, onChange, disabled }) {
  return <div className={cx('switch', on && 'on')} onClick={() => !disabled && onChange(!on)} role="switch" aria-checked={on} tabIndex={0}
    onKeyDown={(e) => { if ((e.key === 'Enter' || e.key === ' ') && !disabled) { e.preventDefault(); onChange(!on); } }} style={disabled ? { opacity: .5, cursor: 'not-allowed' } : {}} />;
}

export function Segmented({ options, value, onChange, accent }) {
  return (
    <div className="seg">
      {options.map((o) => {
        const val = o.value ?? o;
        const lbl = o.label ?? o;
        return <button key={val} className={cx(value === val && 'active', value === val && accent && 'accent')} onClick={() => onChange(val)}>{lbl}</button>;
      })}
    </div>
  );
}

export function Field({ label, hint, children }) {
  return <div className="field"><label>{label}</label>{children}{hint && <span className="hint">{hint}</span>}</div>;
}
export function Input(props) { return <input className={cx('input', props.mono && 'mono')} {...props} />; }
export function Textarea(props) { return <textarea className="textarea" {...props} />; }
export function Select({ children, ...props }) { return <select className="select" {...props}>{children}</select>; }

export function Modal({ title, children, onClose, footer, wide }) {
  useEffect(() => {
    const h = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cx('modal', wide && 'modal-lg')} role="dialog" aria-modal="true">
        <div className="modal-head"><h3 style={{ fontSize: 15 }}>{title}</h3><Button variant="ghost" onClick={onClose}><Icon name="x" size={16} /></Button></div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Empty({ icon = '◇', title, children, action }) {
  return <div className="empty"><div className="em-ico">{icon}</div><h3>{title}</h3><div className="small">{children}</div>{action && <div className="mt-16">{action}</div>}</div>;
}

export function Skeleton({ h = 16, w = '100%', style }) { return <div className="skel" style={{ height: h, width: w, ...style }} />; }
export function Spinner() { return <span className="spinner" />; }

// ── Data hook ─────────────────────────────────────────────────────────────────
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ loading: true, data: null, error: null });
  const run = useCallback(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    Promise.resolve(fn()).then(
      (data) => alive && setState({ loading: false, data, error: null }),
      (error) => alive && setState({ loading: false, data: null, error })
    );
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(run, [run]);
  return { ...state, reload: run };
}

// ── Toasts ────────────────────────────────────────────────────────────────────
let toastId = 0;
const toastEmitter = new Set();
export function toast(title, opts = {}) {
  const t = { id: ++toastId, title, body: opts.body, variant: opts.variant || '' };
  toastEmitter.forEach((fn) => fn(t));
}
toast.error = (title, body) => toast(title, { variant: 'error', body });
toast.success = (title, body) => toast(title, { variant: 'success', body });
export function Toaster() {
  const [items, setItems] = useState([]);
  useEffect(() => {
    const fn = (t) => { setItems((x) => [...x, t]); setTimeout(() => setItems((x) => x.filter((i) => i.id !== t.id)), 4200); };
    toastEmitter.add(fn);
    return () => toastEmitter.delete(fn);
  }, []);
  return (
    <div className="toasts">
      {items.map((t) => <div key={t.id} className={cx('toast', t.variant)} onClick={() => setItems((x) => x.filter((i) => i.id !== t.id))}>
        <div className="t-title">{t.title}</div>{t.body && <div className="t-body">{t.body}</div>}
      </div>)}
    </div>
  );
}
