// Real Shopify Admin API client (doc 04 §5.1, §6). Auth is a custom-app Admin
// API access token (shpat_…) — no OAuth needed for your own store. This handles
// connect+validate and catalogue/blog sync over the REST Admin API.
import { store } from './store.js';
import { encryptSecret, decryptSecret } from './crypto.js';
import { DEFAULT_CADENCE } from './constants.js';

const DEFAULT_VERSION = '2025-01';

export function normalizeDomain(input) {
  let d = String(input || '').trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\/$/, '');
  if (d && !d.includes('.')) d = `${d}.myshopify.com`;   // bare handle → full domain
  return d;
}

async function shopifyGet(shop, token, version, path) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(`https://${shop}/admin/api/${version}/${path}`, {
      headers: { 'X-Shopify-Access-Token': token, 'Content-Type': 'application/json' },
      signal: ctrl.signal,
    });
    const text = await res.text();
    let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
    if (!res.ok) {
      const msg = json?.errors ? (typeof json.errors === 'string' ? json.errors : JSON.stringify(json.errors))
        : res.status === 401 ? 'Invalid Admin API access token (401). Re-check the token and its scopes.'
        : res.status === 404 ? `Not found (404) — is the shop domain correct and the API version "${version}" valid?`
        : `Shopify returned HTTP ${res.status}`;
      const err = new Error(msg); err.status = res.status; throw err;
    }
    return { json, link: res.headers.get('link') || '' };
  } finally {
    clearTimeout(t);
  }
}

// Pull products across pages (bounded), following the REST Link header.
async function fetchProducts(shop, token, version) {
  const out = [];
  let path = 'products.json?limit=250';
  for (let page = 0; page < 6 && path; page++) {
    const { json, link } = await shopifyGet(shop, token, version, path);
    out.push(...(json.products || []));
    const m = link.match(/<[^>]*[?&]page_info=([^>&]+)[^>]*>;\s*rel="next"/);
    path = m ? `products.json?limit=250&page_info=${m[1]}` : null;
  }
  return out;
}

function priceRange(variants = []) {
  const prices = variants.map((v) => Number(v.price)).filter((n) => !Number.isNaN(n));
  if (!prices.length) return { min: null, max: null };
  return { min: Math.min(...prices), max: Math.max(...prices) };
}

// Sync blogs + products for a connected store using its stored token.
export async function syncShopify(tenant, st) {
  const token = decryptSecret(tenant, st.accessTokenEnc);
  const version = st.apiVersion || DEFAULT_VERSION;
  const shop = st.shopDomain;
  store.update('shopifyStores', st.id, { syncStatus: 'syncing', syncError: null });
  try {
    // Blogs (publish targets)
    const { json: blogsJson } = await shopifyGet(shop, token, version, 'blogs.json');
    const blogs = blogsJson.blogs || [];
    store.removeWhere('shopifyBlogs', (b) => b.storeId === st.id);
    blogs.forEach((b, i) => store.insert('shopifyBlogs', {
      storeId: st.id, shopifyGid: `gid://shopify/Blog/${b.id}`, handle: b.handle, title: b.title, isDefaultTarget: i === 0,
    }));

    // Products
    const products = await fetchProducts(shop, token, version);
    store.removeWhere('shopifyProducts', (p) => p.storeId === st.id);
    const host = st.primaryDomain || shop;
    for (const p of products) {
      const range = priceRange(p.variants);
      const descText = String(p.body_html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      store.insert('shopifyProducts', {
        storeId: st.id, shopifyGid: `gid://shopify/Product/${p.id}`, handle: p.handle, title: p.title,
        descriptionHtml: p.body_html || null, descriptionText: descText, vendor: p.vendor || null,
        productType: p.product_type || null, tags: (p.tags || '').split(',').map((s) => s.trim()).filter(Boolean),
        status: (p.status || 'active').toUpperCase(), totalInventory: null,
        priceMin: range.min, priceMax: range.max, currency: st.currency || 'USD',
        featuredImageUrl: p.image?.src || p.images?.[0]?.src || null,
        imageUrls: (p.images || []).map((im) => im.src), onlineStoreUrl: `https://${host}/products/${p.handle}`,
        variantsCount: (p.variants || []).length, publishedAt: p.published_at || null, postCount: 0,
      });
    }
    store.update('shopifyStores', st.id, { syncStatus: 'idle', lastFullSyncAt: new Date().toISOString(), syncError: null });
    return { products: products.length, blogs: blogs.length };
  } catch (e) {
    store.update('shopifyStores', st.id, { syncStatus: 'error', syncError: e.message });
    throw e;
  }
}

// Validate a token, store it encrypted, (re)create the connection + store, sync.
export async function connectShopify(tenant, { shopDomain, accessToken, apiVersion }) {
  const shop = normalizeDomain(shopDomain);
  const token = String(accessToken || '').trim();
  const version = (apiVersion || '').trim() || DEFAULT_VERSION;
  if (!shop || !shop.endsWith('.myshopify.com')) { const e = new Error('Shop domain must look like your-store.myshopify.com'); e.status = 400; throw e; }
  if (!token) { const e = new Error('Admin API access token is required'); e.status = 400; throw e; }

  // Validate by reading the shop record.
  const { json } = await shopifyGet(shop, token, version, 'shop.json');
  const shopInfo = json.shop || {};

  // Reuse an existing Shopify store/connection for this tenant, else create one.
  let st = store.findOne('shopifyStores', (s) => s.tenantId === tenant.id);
  let conn = st ? store.get('connections', st.connectionId) : store.findOne('connections', (c) => c.tenantId === tenant.id && c.platform === 'SHOPIFY_BLOG' && !c.archivedAt);
  if (!conn) {
    conn = store.insert('connections', {
      tenantId: tenant.id, platform: 'SHOPIFY_BLOG', label: shopInfo.name || 'Shopify Blog',
      externalAccountName: shop, externalAccountId: String(shopInfo.id || ''), status: 'CONNECTED', mode: 'MANUAL',
      scopes: [], isActive: true, config: {},
    });
    const cad = DEFAULT_CADENCE.SHOPIFY_BLOG;
    store.insert('platformSchedules', { connectionId: conn.id, isEnabled: false, timezone: shopInfo.iana_timezone || 'Asia/Kolkata', slots: cad.slots, maxPerDay: 2, maxPerWeek: cad.perWeek + 4, minGapMinutes: 180, quietHours: { start: '22:00', end: '07:00' }, categoryRatio: { PRODUCT: 60, KNOWLEDGE: 40 }, autoApproveAbove: 75, leadTimeMinutes: 120 });
    store.insert('platformQuotas', { connectionId: conn.id, maxBytes: 5368709120, usedBytes: 0, retentionDays: 180, purgeStrategy: 'OLDEST_FIRST', keepMetadata: true, keepThumbnails: true, warnAtPercent: 80 });
  }

  const storePatch = {
    tenantId: tenant.id, connectionId: conn.id, shopDomain: shop, apiVersion: version,
    accessTokenEnc: encryptSecret(tenant, token), currency: shopInfo.currency || 'USD',
    primaryDomain: shopInfo.domain || shop, syncStatus: 'idle',
  };
  if (st) { store.update('shopifyStores', st.id, storePatch); }
  else { st = store.insert('shopifyStores', storePatch); }
  store.update('connections', conn.id, { status: 'CONNECTED', externalAccountName: shop, label: conn.label === 'Shopify Blog' ? (shopInfo.name || conn.label) : conn.label });

  const counts = await syncShopify(tenant, store.get('shopifyStores', st.id));
  return { store: store.get('shopifyStores', st.id), connectionId: conn.id, shopName: shopInfo.name, counts };
}
