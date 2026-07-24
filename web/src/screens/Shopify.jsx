import React, { useState } from 'react';
import { useApp } from '../App.jsx';
import { api } from '../api.js';
import { Card, CardHead, Icon, Button, Badge, Input, Field, Modal, useAsync, fmt, toast } from '../ui.jsx';
import { PageHeader, Loading } from '../components/common.jsx';

export function Shopify() {
  const { navigate } = useApp();
  const { data, loading, reload } = useAsync(async () => {
    const [store, products] = await Promise.all([api.get('/shopify/store'), api.get('/shopify/products')]);
    return { store: store.data, products: products.data };
  });
  const [q, setQ] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [connecting, setConnecting] = useState(false);
  if (loading) return <div className="page"><PageHeader title="Shopify" /><Loading rows={4} /></div>;

  const store = data.store;
  const isDemo = !store || store.isDemo;
  const products = data.products.filter((p) => p.title.toLowerCase().includes(q.toLowerCase()));

  async function sync() { setSyncing(true); try { const r = await api.post('/shopify/sync'); toast.success('Catalogue synced', `${r.data.productCount} products${r.data.blogs != null ? `, ${r.data.blogs} blog(s)` : ''}`); reload(); } catch (e) { toast.error('Sync failed', e.message); } setSyncing(false); }
  async function genAbout(product) {
    try {
      const conns = (await api.get('/connections')).data;
      const shop = conns.find((c) => c.platform === 'SHOPIFY_BLOG');
      if (!shop) { toast.error('No Shopify Blog connection', 'Connect your store first.'); return; }
      toast('Generating post…');
      const r = await api.post('/posts/generate', { connectionId: shop.id, category: 'PRODUCT', productId: product.id });
      toast.success('Post generated', `SEO ${r.data.seoScore}`);
      navigate(`/composer/${r.data.id}`);
    } catch (e) { toast.error('Failed', e.message); }
  }

  return (
    <div className="page">
      <PageHeader title="Shopify" sub="Your real product data is injected into posts — facts a generic model can’t invent." icon="shopify"
        actions={<><Button icon="key" onClick={() => setConnecting(true)}>{isDemo ? 'Connect store' : 'Reconnect'}</Button>{store && <Button variant="ghost" icon="refresh" loading={syncing} onClick={sync}>Sync now</Button>}</>} />

      {isDemo && (
        <Card className="card-pad" style={{ marginBottom: 16, borderColor: 'color-mix(in srgb, var(--warning) 30%, var(--border))' }}>
          <div className="row between wrap gap-16">
            <div className="row gap-16">
              <div style={{ width: 40, height: 40, borderRadius: 10, background: 'color-mix(in srgb, var(--warning) 18%, transparent)', color: 'var(--warning)', display: 'grid', placeItems: 'center' }}><Icon name="alert" size={20} /></div>
              <div>
                <b>{store ? 'This is demo catalogue data' : 'No store connected'}</b>
                <div className="tiny dim">Connect your real store with an Admin API access token to sync your live products and publish real blog articles.</div>
              </div>
            </div>
            <Button variant="primary" icon="key" onClick={() => setConnecting(true)}>Connect your store</Button>
          </div>
        </Card>
      )}

      {store && (
        <Card className="card-pad" style={{ marginBottom: 16 }}>
          <div className="row between wrap gap-16">
            <div className="row gap-16">
              <div style={{ width: 42, height: 42, borderRadius: 10, background: '#95BF47', display: 'grid', placeItems: 'center', color: '#0a0b0f' }}><Icon name="shopify" size={22} /></div>
              <div><div className="row gap-8"><b>{store.shopDomain}</b>{store.hasToken ? <Badge variant="success" dot>live</Badge> : <Badge variant="warning" dot>demo</Badge>}</div>
                <div className="tiny dim">API {store.apiVersion} · {store.currency} · {store.productCount} products · {store.blogs?.length || 0} blog(s){store.syncError ? ` · sync error: ${store.syncError}` : ''}</div></div>
            </div>
            <div className="col right"><span className="tiny dim">Last full sync</span><b className="mono small">{fmt.rel(store.lastFullSyncAt)}</b></div>
          </div>
        </Card>
      )}

      <Card>
        <CardHead title="Products" sub={`${products.length} shown · sorted by least-recently-posted`} right={<Input placeholder="Search…" value={q} onChange={(e) => setQ(e.target.value)} style={{ width: 200 }} />} />
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead><tr><th>Product</th><th>Type</th><th className="right">Price</th><th className="right">Stock</th><th>Last posted</th><th></th></tr></thead>
            <tbody>
              {products.map((p) => (
                <tr key={p.id}>
                  <td><b className="small">{p.title}</b><div className="tiny dim">{p.vendor}</div></td>
                  <td>{p.productType && <Badge>{p.productType}</Badge>}</td>
                  <td className="right mono">{p.priceMin != null ? `${p.currency === 'USD' ? '$' : ''}${p.priceMin}` : '—'}</td>
                  <td className="right mono" style={{ color: p.totalInventory != null && p.totalInventory < 5 ? 'var(--warning)' : undefined }}>{p.totalInventory ?? '—'}</td>
                  <td className="mono tiny dim">{p.lastPostedAt ? fmt.rel(p.lastPostedAt) : 'never'}</td>
                  <td className="right"><Button size="sm" icon="sparkles" onClick={() => genAbout(p)}>Post about this</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {products.length === 0 && <div className="empty" style={{ padding: 30 }}><div className="small">No products. Connect a store or sync.</div></div>}
      </Card>

      {connecting && <ConnectModal onClose={() => setConnecting(false)} onDone={() => { setConnecting(false); reload(); }} />}
    </div>
  );
}

function ConnectModal({ onClose, onDone }) {
  const [shopDomain, setShopDomain] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [apiVersion, setApiVersion] = useState('2025-01');
  const [busy, setBusy] = useState(false);
  const [showHelp, setShowHelp] = useState(true);

  async function connect() {
    setBusy(true);
    try {
      const r = await api.post('/shopify/connect', { shopDomain, accessToken, apiVersion });
      toast.success('Store connected', `${r.data.shopName || r.data.shopDomain} · ${r.data.products} products, ${r.data.blogs} blog(s)`);
      onDone();
    } catch (e) { toast.error('Could not connect', e.message); setBusy(false); }
  }

  return (
    <Modal title="Connect your Shopify store" onClose={onClose} wide
      footer={<><Button variant="ghost" onClick={onClose}>Cancel</Button><Button variant="primary" icon="key" loading={busy} disabled={!shopDomain || !accessToken} onClick={connect}>Validate & connect</Button></>}>
      <div className="card card-pad" style={{ background: 'var(--surface-2)', marginBottom: 16 }}>
        <div className="row between" style={{ cursor: 'pointer' }} onClick={() => setShowHelp((s) => !s)}>
          <b className="small">How to get your Admin API access token</b>
          <Icon name={showHelp ? 'chevronD' : 'chevronR'} size={15} className="dim" />
        </div>
        {showHelp && (
          <ol className="small muted" style={{ margin: '10px 0 0', paddingLeft: 18, lineHeight: 1.9 }}>
            <li>In Shopify admin: <b>Settings → Apps and sales channels → Develop apps</b>.</li>
            <li>Click <b>Create an app</b> (name it e.g. “AutoPost”), then open <b>Configuration → Admin API integration</b>.</li>
            <li>Grant these scopes: <span className="mono tiny">write_content, read_content, read_products, read_product_listings, read_inventory</span>.</li>
            <li><b>Save</b>, then go to <b>API credentials → Install app</b>.</li>
            <li>Reveal and copy the <b>Admin API access token</b> (starts with <span className="mono tiny">shpat_</span> — shown once).</li>
          </ol>
        )}
      </div>
      <Field label="Shop domain" hint="Your permanent .myshopify.com domain (not a custom domain).">
        <Input mono value={shopDomain} onChange={(e) => setShopDomain(e.target.value)} placeholder="your-store.myshopify.com" autoFocus />
      </Field>
      <Field label="Admin API access token" hint="Encrypted at rest (AES-256-GCM). We validate it against your store before saving.">
        <Input mono type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} placeholder="shpat_…" />
      </Field>
      <Field label="API version" hint="Use a currently-supported version if the default fails.">
        <Input mono value={apiVersion} onChange={(e) => setApiVersion(e.target.value)} placeholder="2025-01" style={{ maxWidth: 140 }} />
      </Field>
    </Modal>
  );
}
