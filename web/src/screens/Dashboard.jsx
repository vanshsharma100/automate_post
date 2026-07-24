import React from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Ring, StatusDot, Badge, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, PlatformTag, ModeSelect, Loading } from '../components/common.jsx';

export function Dashboard() {
  const { navigate, master } = useApp();
  const { data, loading, reload } = useAsync(async () => {
    const [status, conns, overview, scheduled, providers] = await Promise.all([
      api.get('/automation/status'),
      api.get('/connections'),
      api.get('/analytics/overview'),
      api.get('/posts?status=SCHEDULED&limit=8&sort=scheduledAt'),
      api.get('/brain/providers'),
    ]);
    return { status: status.data, conns: conns.data, overview: overview.data, scheduled: scheduled.data, providers: providers.data };
  });

  if (loading) return <div className="page"><PageHeader title="Dashboard" /><Loading rows={4} /></div>;

  const { status, conns, overview, scheduled } = data;
  const hasKey = (data.providers || []).some((p) => p.hasKey);
  const setupSteps = [
    { done: hasKey, label: 'Add an AI provider API key', to: '/brain', hint: 'Brain → Providers' },
    { done: conns.length > 0, label: 'Connect a platform', to: '/connections', hint: 'Shopify, webhook, or a social app' },
    { done: true, label: 'Write your brain instructions', to: '/knowledge', hint: 'Knowledge boxes' },
    { done: overview.published > 0, label: 'Generate your first post', to: '/composer', hint: 'Composer' },
  ];
  const setupDone = setupSteps.filter((s) => s.done).length;
  const showSetup = !hasKey || conns.length === 0;
  const automated = conns.filter((c) => c.mode === 'AUTOPILOT').length;
  const next = scheduled[0];

  const attention = [];
  conns.forEach((c) => {
    if (c.status === 'EXPIRED' || (c.tokenExpiresAt && new Date(c.tokenExpiresAt) - Date.now() < 5 * 864e5 && c.status === 'DEGRADED'))
      attention.push({ level: 'warning', text: `${c.label} token expires ${fmt.rel(c.tokenExpiresAt)}`, action: () => navigate('/connections') });
    if (c.status === 'ERROR' || c.breakerOpen) attention.push({ level: 'error', text: `${c.label} has publish errors`, action: () => navigate('/connections') });
    if (c.storage && c.storage.percent >= 80) attention.push({ level: 'info', text: `${c.label} storage at ${c.storage.percent}%`, action: () => navigate('/media') });
  });
  if (overview.failed > 0) attention.push({ level: 'error', text: `${overview.failed} failed publish${overview.failed > 1 ? 'es' : ''} in 30 days`, action: () => navigate('/history') });

  return (
    <div className="page">
      <PageHeader title="Dashboard" sub="Everything your autonomous system is doing, at a glance."
        actions={<Button variant="primary" icon="sparkles" onClick={() => navigate('/composer')}>Generate a post</Button>} />

      {showSetup && (
        <Card className="card-pad" style={{ marginBottom: 16, background: 'linear-gradient(180deg, var(--accent-glow), transparent)' }}>
          <div className="row between" style={{ marginBottom: 12 }}>
            <div className="row gap-8"><Icon name="sparkles" size={16} /><b>Get started</b></div>
            <Badge variant="accent">{setupDone}/{setupSteps.length}</Badge>
          </div>
          <div className="grid grid-4" style={{ gap: 10 }}>
            {setupSteps.map((s, i) => (
              <div key={i} className="card card-pad" style={{ cursor: 'pointer', background: 'var(--surface)' }} onClick={() => navigate(s.to)}>
                <div className="row gap-8"><span className={cx('check-ic', s.done ? 'pass' : 'fail')}>{s.done ? '✓' : i + 1}</span><b className="small">{s.label}</b></div>
                <div className="tiny dim" style={{ marginTop: 6 }}>{s.hint}</div>
              </div>
            ))}
          </div>
        </Card>
      )}

      {/* System status */}
      <Card className="card-pad" style={{ background: master === 'AUTOPILOT' ? 'linear-gradient(180deg, var(--accent-glow), transparent)' : undefined }}>
        <div className="row between wrap gap-16">
          <div className="row gap-16">
            <div style={{ width: 46, height: 46, borderRadius: 12, background: master === 'AUTOPILOT' ? 'var(--accent)' : 'var(--surface-3)', color: master === 'AUTOPILOT' ? 'var(--accent-ink)' : 'var(--text-2)', display: 'grid', placeItems: 'center' }}>
              <Icon name="power" size={22} />
            </div>
            <div>
              <div className="row gap-8"><h2 style={{ fontSize: 18 }}>{master === 'AUTOPILOT' ? 'Autopilot active' : master === 'PAUSED' ? 'Everything paused' : 'Manual mode'}</h2>
                <Badge variant={master === 'AUTOPILOT' ? 'accent' : master === 'PAUSED' ? 'danger' : ''}>{automated} of {conns.length} automated</Badge></div>
              <div className="muted small mt-8">{next ? <>Next post: <b>{next.connectionLabel}</b> · <span className="mono">{fmt.rel(next.scheduledAt)}</span> — “{next.title}”</> : 'No posts scheduled yet.'}</div>
            </div>
          </div>
        </div>
      </Card>

      <div className="grid grid-2 mt-16" style={{ gridTemplateColumns: '1.4fr 1fr' }}>
        {/* Platforms board */}
        <Card>
          <CardHead title="Platforms" sub={`${conns.length} connections`} right={<Button size="sm" icon="plus" onClick={() => navigate('/connections')}>Add connection</Button>} />
          <div>
            {conns.map((c) => (
              <div key={c.id} className="row between" style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)' }}>
                <div className="row gap-16" style={{ minWidth: 0 }}>
                  <StatusDot status={c.status} />
                  <div style={{ minWidth: 0 }}>
                    <div className="row gap-8"><b className="small">{c.meta?.label}</b><span className="dim tiny mono" style={{ whiteSpace: 'nowrap' }}>{c.externalAccountName || '—'}</span></div>
                    <div className="tiny dim">{c.schedule?.isEnabled ? <>next {fmt.rel(c.schedule.nextSlot)} · </> : ''}{c.publishedCount} published{c.storage ? ` · ${fmt.bytes(c.storage.usedBytes)} / ${fmt.bytes(c.storage.maxBytes)}` : ''}</div>
                  </div>
                </div>
                <div className="row gap-8">
                  {c.status === 'EXPIRED' || c.status === 'DEGRADED' ? <Badge variant="warning" dot>fix</Badge> : null}
                  <ModeSelect connection={c} onChange={reload} />
                </div>
              </div>
            ))}
          </div>
        </Card>

        {/* 30 days + attention */}
        <div className="col gap-16">
          <Card className="card-pad">
            <div className="row between"><div className="card-title">Last 30 days</div><Badge>{overview.successRate}% success</Badge></div>
            <div className="grid grid-2 mt-16" style={{ gap: 12 }}>
              <Stat v={fmt.int(overview.published)} l="Published" />
              <Stat v={overview.failed} l="Failed" color={overview.failed ? 'var(--danger)' : undefined} />
              <Stat v={overview.avgSeo} l="Avg SEO" color="var(--accent)" />
              <Stat v={fmt.money(overview.spend)} l="AI spend" />
            </div>
            <div className="sparkbar mt-16">
              {(overview.spark || []).map((n, i) => <span key={i} style={{ height: `${Math.max(6, (n / Math.max(1, ...overview.spark)) * 100)}%` }} title={`${n} posts`} />)}
            </div>
          </Card>

          <Card>
            <CardHead title="Needs your attention" />
            <div style={{ padding: '4px 0' }}>
              {attention.length === 0 ? <div className="empty" style={{ padding: 22 }}><div className="small">All clear ✓</div></div> :
                attention.slice(0, 5).map((a, i) => (
                  <div key={i} className="check-row" style={{ padding: '9px 18px', cursor: 'pointer' }} onClick={a.action}>
                    <span className={cx('status-dot', a.level === 'error' ? 's-ERROR' : a.level === 'warning' ? 's-DEGRADED' : 's-GENERATING')} style={{ marginTop: 4 }} />
                    <div className="small grow">{a.text}</div>
                    <Icon name="chevronR" size={14} className="dim" />
                  </div>
                ))}
            </div>
          </Card>
        </div>
      </div>

      {/* Upcoming */}
      <Card className="mt-16">
        <CardHead title="Upcoming" sub="Next scheduled posts" right={<Button size="sm" variant="ghost" onClick={() => navigate('/calendar')}>Open calendar</Button>} />
        <div>
          {scheduled.length === 0 ? <div className="empty" style={{ padding: 30 }}><div className="em-ico">◷</div><div className="small">Nothing scheduled. Turn on autopilot or generate a post.</div></div> :
            scheduled.map((p) => (
              <div key={p.id} className="row between click" style={{ padding: '11px 18px', borderBottom: '1px solid var(--border)', cursor: 'pointer' }} onClick={() => navigate(`/composer/${p.id}`)}>
                <div className="row gap-16">
                  <span className="mono small dim" style={{ width: 92 }}>{fmt.datetime(p.scheduledAt)}</span>
                  <PlatformTag platform={p.platform} />
                  <span className="small">{p.title}</span>
                </div>
                <div className="row gap-8"><Badge>SEO {p.seoScore ?? '—'}</Badge><StatusDot status={p.status} /></div>
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}

function Stat({ v, l, color }) {
  return <div className="stat"><div className="v" style={color ? { color } : {}}>{v}</div><div className="l">{l}</div></div>;
}
