import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, Icon, Button, Badge, StatusDot, useAsync, fmt, cx } from '../ui.jsx';
import { PageHeader, Loading } from '../components/common.jsx';

export function Calendar() {
  const { navigate, platformMeta } = useApp();
  const [month, setMonth] = useState(() => { const d = new Date(); return { y: d.getFullYear(), m: d.getMonth() }; });
  const { data, loading } = useAsync(() => api.get('/history/calendar').then((r) => r.data));
  if (loading) return <div className="page"><PageHeader title="Calendar" /><Loading rows={4} /></div>;

  const first = new Date(month.y, month.m, 1);
  const startDay = first.getDay();
  const daysIn = new Date(month.y, month.m + 1, 0).getDate();
  const cells = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysIn; d++) cells.push(d);
  const byDay = {};
  data.forEach((p) => { const k = new Date(p.at); if (k.getFullYear() === month.y && k.getMonth() === month.m) (byDay[k.getDate()] ||= []).push(p); });
  const monthName = first.toLocaleString('en-US', { month: 'long', year: 'numeric' });
  const today = new Date();

  return (
    <div className="page" style={{ maxWidth: 1200 }}>
      <PageHeader title="Calendar" sub="Everything scheduled and published, coloured by platform." icon="calendar"
        actions={<div className="row gap-6"><Button variant="ghost" onClick={() => setMonth((mo) => ({ y: mo.m === 0 ? mo.y - 1 : mo.y, m: mo.m === 0 ? 11 : mo.m - 1 }))}><Icon name="chevronR" size={15} style={{ transform: 'rotate(180deg)' }} /></Button><b style={{ minWidth: 150, textAlign: 'center' }}>{monthName}</b><Button variant="ghost" onClick={() => setMonth((mo) => ({ y: mo.m === 11 ? mo.y + 1 : mo.y, m: mo.m === 11 ? 0 : mo.m + 1 }))}><Icon name="chevronR" size={15} /></Button></div>} />
      <Card className="card-pad">
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 1 }}>
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d} className="tiny dim center" style={{ padding: 6, fontWeight: 600 }}>{d}</div>)}
          {cells.map((d, i) => {
            const isToday = d && today.getFullYear() === month.y && today.getMonth() === month.m && today.getDate() === d;
            return (
              <div key={i} style={{ minHeight: 96, border: '1px solid var(--border)', borderRadius: 8, padding: 6, background: d ? 'var(--surface)' : 'transparent' }}>
                {d && <div className={cx('tiny mono', isToday && 'badge-accent')} style={{ display: 'inline-block', padding: isToday ? '0 5px' : 0, borderRadius: 5, marginBottom: 4 }}>{d}</div>}
                <div className="col gap-6">
                  {(byDay[d] || []).slice(0, 3).map((p) => (
                    <div key={p.id} onClick={() => navigate(`/composer/${p.id}`)} title={p.title} style={{ cursor: 'pointer', fontSize: 11, padding: '2px 5px', borderRadius: 5, background: 'var(--surface-2)', borderLeft: `3px solid ${platformMeta[p.platform]?.accent || '#9AA1B1'}`, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <span className={cx('status-dot', `s-${p.status}`)} style={{ width: 5, height: 5, display: 'inline-block', marginRight: 4 }} />{p.title}
                    </div>
                  ))}
                  {(byDay[d] || []).length > 3 && <span className="tiny dim">+{byDay[d].length - 3} more</span>}
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
