import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api, getToken } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, StatusBadge, Modal, Segmented, useAsync, fmt, cx, toast } from '../ui.jsx';
import { PageHeader, PlatformTag, Loading } from '../components/common.jsx';

export function History() {
  const { navigate } = useApp();
  const [view, setView] = useState('log');
  const [detail, setDetail] = useState(null);
  const { data, loading, reload } = useAsync(async () => {
    const [posts, failures] = await Promise.all([api.get('/history/posts?limit=200'), api.get('/history/failures')]);
    return { posts: posts.data, failures: failures.data };
  });
  async function exportCsv() {
    try {
      const res = await fetch('/api/v1/history/export', { headers: { authorization: `Bearer ${getToken()}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'history.csv'; a.click();
      URL.revokeObjectURL(url);
    } catch (e) { toast.error('Export failed', e.message); }
  }

  if (loading) return <div className="page"><PageHeader title="History" /><Loading rows={4} /></div>;

  const rows = view === 'failures' ? data.posts.filter((p) => p.status === 'FAILED') : data.posts;

  return (
    <div className="page">
      <PageHeader title="History" sub="Which post, which day, and exactly why anything failed." icon="history"
        actions={<><Segmented options={[{ value: 'log', label: 'All' }, { value: 'failures', label: 'Failures' }]} value={view} onChange={setView} />
          <Button variant="ghost" icon="external" onClick={exportCsv}>CSV</Button></>} />
      <Card>
        <table className="table">
          <thead><tr><th>Date</th><th>Platform</th><th>Title</th><th>Category</th><th>Status</th><th className="right">SEO</th><th className="right">Cost</th><th></th></tr></thead>
          <tbody>
            {rows.map((p) => {
              const failure = data.failures.find((f) => f.id === p.id);
              return (
                <tr key={p.id} className="click" onClick={() => (p.status === 'FAILED' && failure ? setDetail(failure) : p.externalUrl ? window.open(p.externalUrl, '_blank') : navigate(`/composer/${p.id}`))}>
                  <td className="mono tiny dim">{fmt.date(p.publishedAt || p.scheduledAt)}</td>
                  <td><PlatformTag platform={p.platform} /></td>
                  <td><span className="small">{p.title}</span></td>
                  <td><Badge>{p.category?.[0]}{p.category?.slice(1).toLowerCase()}</Badge></td>
                  <td><StatusBadge status={p.status} /></td>
                  <td className="right mono">{p.seoScore ?? '—'}</td>
                  <td className="right mono tiny dim">{fmt.money(p.costUsd)}</td>
                  <td className="right">{p.status === 'FAILED' ? <Badge variant="danger" dot>details</Badge> : p.externalUrl ? <Icon name="external" size={14} className="dim" /> : null}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length === 0 && <div className="empty" style={{ padding: 40 }}><div className="em-ico">◷</div><div className="small">No history yet.</div></div>}
      </Card>
      {detail && <FailureDetail failure={detail} onClose={() => setDetail(null)} onRetried={reload} />}
    </div>
  );
}

function FailureDetail({ failure, onClose, onRetried }) {
  const [busy, setBusy] = useState(false);
  return (
    <Modal title="Failure detail" onClose={onClose} wide footer={<><Button variant="ghost" onClick={onClose}>Close</Button>
      <Button variant="primary" icon="refresh" loading={busy} onClick={async () => { setBusy(true); try { await api.post(`/posts/${failure.id}/retry`); toast.success('Retrying publish'); onRetried(); onClose(); } catch (e) { toast.error('Failed', e.message); setBusy(false); } }}>Retry</Button></>}>
      <div className="row gap-8" style={{ marginBottom: 12 }}><PlatformTag platform={failure.platform} /><b>{failure.title}</b></div>
      <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 12 }}>
        <div className="small" style={{ color: 'var(--danger)', fontWeight: 600 }}>{failure.lastError}</div>
        <div className="tiny dim mt-8">A plain-English cause is shown to you; the raw platform response is redacted of secrets in the log.</div>
      </div>
      <div className="card-title" style={{ marginBottom: 8 }}>Attempts</div>
      <table className="table">
        <thead><tr><th>#</th><th>Status</th><th>HTTP</th><th>When</th><th>Error</th></tr></thead>
        <tbody>{(failure.attempts || []).map((a) => (
          <tr key={a.id}><td className="mono">{a.attemptNo}</td><td><StatusBadge status={a.status} /></td><td className="mono">{a.httpStatus || '—'}</td><td className="tiny dim">{fmt.datetime(a.startedAt)}</td><td className="tiny">{a.errorMessage}</td></tr>
        ))}</tbody>
      </table>
    </Modal>
  );
}
