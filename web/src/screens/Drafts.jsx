import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, Icon, Button, Badge, StatusDot, Ring, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, PlatformTag, Loading } from '../components/common.jsx';

const COLUMNS = [
  { status: 'NEEDS_REVIEW', label: 'Needs review' },
  { status: 'APPROVED', label: 'Approved' },
  { status: 'SCHEDULED', label: 'Scheduled' },
  { status: 'PUBLISHED', label: 'Published' },
  { status: 'FAILED', label: 'Failed' },
];

export function Drafts() {
  const { navigate } = useApp();
  const [conn, setConn] = useState('all');
  const { data, loading, reload } = useAsync(async () => {
    const [posts, conns] = await Promise.all([api.get('/posts?limit=200'), api.get('/connections')]);
    return { posts: posts.data, conns: conns.data };
  });
  if (loading) return <div className="page"><PageHeader title="Drafts" /><Loading rows={4} /></div>;

  const posts = data.posts.filter((p) => (conn === 'all' || p.connectionId === conn) && p.status !== 'ARCHIVED');

  async function act(id, fn, msg) { try { await fn(); toast.success(msg); reload(); } catch (e) { toast.error('Failed', e.message); } }

  return (
    <div className="page" style={{ maxWidth: 1400 }}>
      <PageHeader title="Draft inbox" sub="Each platform gets its own natively-written post. Move them through to published." icon="drafts"
        actions={<Button variant="primary" icon="sparkles" onClick={() => navigate('/composer')}>Generate</Button>} />
      <div className="row gap-6 wrap" style={{ marginBottom: 16 }}>
        <button className={cx('chip', conn === 'all' && 'badge-accent')} onClick={() => setConn('all')} style={{ cursor: 'pointer' }}>All ({data.posts.filter((p) => p.status !== 'ARCHIVED').length})</button>
        {data.conns.map((c) => <button key={c.id} className={cx('chip', conn === c.id && 'badge-accent')} onClick={() => setConn(c.id)} style={{ cursor: 'pointer' }}><span style={{ width: 7, height: 7, borderRadius: 2, background: c.meta?.accent }} />{c.label}</button>)}
      </div>
      <div className="kanban">
        {COLUMNS.map((col) => {
          const list = posts.filter((p) => p.status === col.status);
          return (
            <div key={col.status} className="kan-col">
              <div className="kan-col-head"><StatusDot status={col.status} /> {col.label} <span className="nav-badge" style={{ marginLeft: 'auto' }}>{list.length}</span></div>
              <div className="kan-col-body">
                {list.map((p) => (
                  <div key={p.id} className="kan-card" onClick={() => navigate(`/composer/${p.id}`)}>
                    <div className="row between" style={{ marginBottom: 6 }}><PlatformTag platform={p.platform} showLabel={false} size={9} /><Badge>{p.category?.[0]}{p.category?.slice(1).toLowerCase()}</Badge></div>
                    <div className="small" style={{ fontWeight: 600, lineHeight: 1.4, marginBottom: 8 }}>{p.title || 'Untitled'}</div>
                    <div className="row between">
                      <span className="tiny dim mono">{p.scheduledAt ? fmt.rel(p.scheduledAt) : p.publishedAt ? fmt.date(p.publishedAt) : fmt.rel(p.createdAt)}</span>
                      {typeof p.seoScore === 'number' && <Ring value={p.seoScore} size={30} stroke={3} />}
                    </div>
                    {col.status === 'NEEDS_REVIEW' && <div className="row gap-6 mt-8" onClick={(e) => e.stopPropagation()}><Button size="sm" onClick={() => act(p.id, () => api.post(`/posts/${p.id}/approve`), 'Approved')}>Approve</Button><Button size="sm" variant="ghost" onClick={() => navigate(`/composer/${p.id}`)}>Edit</Button></div>}
                    {col.status === 'APPROVED' && <div className="row gap-6 mt-8" onClick={(e) => e.stopPropagation()}><Button size="sm" onClick={() => act(p.id, () => api.post(`/posts/${p.id}/schedule`, {}), 'Scheduled')}>Schedule</Button><Button size="sm" variant="ghost" onClick={() => act(p.id, () => api.post(`/posts/${p.id}/publish`), 'Published')}>Publish now</Button></div>}
                    {col.status === 'FAILED' && <div className="mt-8" onClick={(e) => e.stopPropagation()}><Button size="sm" variant="danger" icon="refresh" onClick={() => act(p.id, () => api.post(`/posts/${p.id}/retry`), 'Retrying')}>Retry</Button></div>}
                    {col.status === 'PUBLISHED' && p.externalUrl && <a className="tiny mt-8" href={p.externalUrl} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} style={{ color: 'var(--info)', display: 'inline-flex', gap: 4, alignItems: 'center' }}><Icon name="external" size={12} /> view live</a>}
                  </div>
                ))}
                {list.length === 0 && <div className="dim tiny center" style={{ padding: 16 }}>—</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
