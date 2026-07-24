import React from 'react';
import { Icon } from '../ui.jsx';

// Pixel-ish accurate mock of how the post lands on each platform (doc 07 §6).
export function PlatformPreview({ platform, post, account, media = [] }) {
  // Prefer a real uploaded/hosted asset over the byte-less AI placeholder.
  const usable = (media || []).filter((m) => m && !m.purgedAt);
  const img = usable.find((m) => m.publicUrl) || usable[0];
  const avatar = (account || 'A')[0].toUpperCase();
  const ImgBox = ({ portrait }) => (
    <div className={portrait ? 'pv-img portrait' : 'pv-img'} style={{ background: 'linear-gradient(135deg,#0f1420,#243049)', position: 'relative', overflow: 'hidden' }}>
      {img?.publicUrl ? (
        img.kind === 'VIDEO'
          ? <video src={img.publicUrl} muted style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
          : <img src={img.publicUrl} alt={img.altText || ''} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      ) : (
        <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', textAlign: 'center', color: '#8a93a8' }}>
          <div><Icon name="media" size={22} /><div style={{ fontSize: 10, marginTop: 4 }}>{img?.altText ? 'AI image (placeholder)' : 'no image'}</div></div>
        </div>
      )}
    </div>
  );

  if (platform === 'LINKEDIN') {
    const body = post.body || '';
    const fold = body.length > 210 ? body.slice(0, 210) : body;
    return (
      <div className="pv-card" style={{ maxWidth: 480, margin: '0 auto' }}>
        <div className="pv-head"><div className="pv-avatar">{avatar}</div><div><div style={{ fontWeight: 600 }}>{account || 'Company Page'}</div><div style={{ fontSize: 11, color: '#666' }}>1,204 followers · Promoted</div></div></div>
        <div className="pv-body">{fold}{body.length > 210 && <span style={{ color: '#0a66c2' }}>…see more</span>}</div>
        {img && <ImgBox />}
        <div style={{ display: 'flex', gap: 18, padding: '8px 14px', color: '#666', fontSize: 12, borderTop: '1px solid #eee' }}><span>👍 Like</span><span>💬 Comment</span><span>↪ Share</span></div>
        {post.hashtags?.length > 0 && <div style={{ padding: '0 14px 12px', color: '#0a66c2', fontSize: 12 }}>{post.hashtags.join(' ')}</div>}
      </div>
    );
  }
  if (platform === 'INSTAGRAM') {
    const cap = post.body || '';
    const short = cap.length > 125 ? cap.slice(0, 125) : cap;
    return (
      <div className="pv-card" style={{ maxWidth: 380, margin: '0 auto' }}>
        <div className="pv-head" style={{ padding: '8px 12px' }}><div className="pv-avatar" style={{ width: 30, height: 30, fontSize: 12 }}>{avatar}</div><div style={{ fontWeight: 600, fontSize: 13 }}>{(account || 'ftech').replace('@', '')}</div></div>
        <ImgBox portrait />
        <div style={{ display: 'flex', gap: 14, padding: '8px 12px', fontSize: 18 }}>♡ 💬 ➤ <span style={{ marginLeft: 'auto' }}>🔖</span></div>
        <div className="pv-body" style={{ paddingTop: 0, fontSize: 12 }}><b>{(account || 'ftech').replace('@', '')}</b> {short}{cap.length > 125 && <span style={{ color: '#888' }}>… more</span>}</div>
      </div>
    );
  }
  if (platform === 'SHOPIFY_BLOG' || platform === 'WORDPRESS') {
    return (
      <div className="pv-blog" style={{ maxWidth: 620, margin: '0 auto', maxHeight: 560, overflowY: 'auto' }}>
        <div style={{ fontSize: 11, color: '#888', textTransform: 'uppercase', letterSpacing: '.05em' }}>{account} · Blog</div>
        <h1>{post.title}</h1>
        {post.excerpt && <p style={{ color: '#666', fontStyle: 'italic' }}>{post.excerpt}</p>}
        <div style={{ height: 180, borderRadius: 10, background: 'linear-gradient(135deg,#e8eef7,#d3e0f0)', margin: '14px 0', display: 'grid', placeItems: 'center', color: '#7a8aa0' }}>hero image</div>
        <BlogBody body={post.body || ''} />
      </div>
    );
  }
  if (platform === 'GOOGLE_BUSINESS') {
    return (
      <div className="pv-card" style={{ maxWidth: 340, margin: '0 auto' }}>
        <ImgBox />
        <div className="pv-body"><div style={{ fontWeight: 600, marginBottom: 4 }}>{account || 'Your Business'}</div>{(post.body || '').slice(0, 300)}</div>
        <div style={{ padding: '0 14px 14px' }}><span style={{ color: '#4285f4', fontWeight: 600, fontSize: 13 }}>{post.callToAction || 'Learn more'} →</span></div>
      </div>
    );
  }
  // Facebook / webhook / default
  return (
    <div className="pv-card" style={{ maxWidth: 460, margin: '0 auto' }}>
      <div className="pv-head"><div className="pv-avatar">{avatar}</div><div><div style={{ fontWeight: 600 }}>{account || 'Page'}</div><div style={{ fontSize: 11, color: '#666' }}>Just now · 🌐</div></div></div>
      <div className="pv-body">{post.body}</div>
      {img && <ImgBox />}
    </div>
  );
}

function BlogBody({ body }) {
  const blocks = body.split(/\n{2,}/).slice(0, 40);
  return <>{blocks.map((b, i) => {
    if (b.startsWith('## ')) return <h2 key={i}>{b.slice(3)}</h2>;
    if (b.startsWith('**') && b.endsWith('**')) return <p key={i}><b>{b.replace(/\*\*/g, '')}</b></p>;
    return <p key={i}>{b.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')}</p>;
  })}</>;
}
