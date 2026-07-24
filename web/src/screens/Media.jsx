import React, { useState } from 'react';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, PlatformTag, Loading } from '../components/common.jsx';

export function Media() {
  const { data, loading, reload } = useAsync(async () => {
    const [media, storage] = await Promise.all([api.get('/media?purged=false'), api.get('/storage/overview')]);
    return { media: media.data, storage: storage.data };
  });
  if (loading) return <div className="page"><PageHeader title="Media" /><Loading rows={4} /></div>;

  async function purge(cid, label) {
    const dry = await api.post(`/connections/${cid}/purge`, { dryRun: true });
    if (!dry.data.count) return toast('Nothing to purge', { body: dry.data.note || 'All media is within retention.' });
    if (!confirm(`Purge ${dry.data.count} old assets from ${label}, freeing ${fmt.bytes(dry.data.freedBytes)}? Metadata & thumbnails are kept.`)) return;
    await api.post(`/connections/${cid}/purge`, { dryRun: false });
    toast.success('Purged', `Freed ${fmt.bytes(dry.data.freedBytes)}`); reload();
  }

  return (
    <div className="page">
      <PageHeader title="Media library" sub="Per-platform storage caps auto-delete old bytes but keep the history (requirement 14)." icon="media" />
      <div className="grid grid-3" style={{ marginBottom: 20 }}>
        {data.storage.map((s) => (
          <Card key={s.connectionId} className="card-pad">
            <div className="row between"><span className="row gap-6"><PlatformTag platform={s.platform} showLabel={false} /><b className="small">{s.label}</b></span><span className="tiny mono dim">{s.percent}%</span></div>
            <div className={cx('progress', s.percent >= 80 && 'warn', s.percent >= 100 && 'danger')} style={{ marginTop: 10 }}><span style={{ width: `${Math.min(100, s.percent)}%` }} /></div>
            <div className="row between mt-8"><span className="tiny dim mono">{fmt.bytes(s.usedBytes)} / {fmt.bytes(s.maxBytes)}</span><Button size="sm" variant="ghost" onClick={() => purge(s.connectionId, s.label)}>Purge</Button></div>
          </Card>
        ))}
      </div>
      <Card>
        <CardHead title="Assets" sub={`${data.media.length} items`} />
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 12, padding: 16 }}>
          {data.media.map((m) => (
            <div key={m.id} className="card" style={{ overflow: 'hidden' }}>
              <div style={{ aspectRatio: '4/3', background: 'linear-gradient(135deg,var(--surface-2),var(--surface-3))', display: 'grid', placeItems: 'center', color: 'var(--text-3)' }}>
                <Icon name="media" size={24} />
              </div>
              <div style={{ padding: 8 }}>
                <div className="tiny" style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{m.altText || 'no alt text'}</div>
                <div className="row between mt-8"><Badge>{m.source === 'AI_GENERATED' ? 'AI' : m.source}</Badge><span className="tiny dim mono">{fmt.bytes(m.bytes)}</span></div>
              </div>
            </div>
          ))}
          {data.media.length === 0 && <div className="empty" style={{ gridColumn: '1/-1', padding: 30 }}><div className="small">No media yet. Generate a post to create images.</div></div>}
        </div>
      </Card>
    </div>
  );
}
