'use strict';

/**
 * Shopify product source.
 *
 * The store's live catalogue is the MAIN brain input: when a Shopify Admin API
 * access token is saved, `syncProducts()` pulls the real products (title, price,
 * image, tags, link) and replaces the seeded samples. Everything downstream —
 * the content brain, scheduler and Products page — reads from store.products,
 * so nothing else has to know where the products came from.
 *
 * SECURITY: the token is decrypted server-side only, here, at call time. It is
 * never logged or returned to the browser.
 */

const store = require('./store');
const { decrypt } = require('./crypto');

const API_VERSION = '2024-10';

// Accepts "ftechdeals.com", "shop.myshopify.com" or a full URL -> host only.
function normalizeDomain(domain) {
  let d = String(domain || '').trim();
  d = d.replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
  return d;
}

function inrPrice(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function firstImage(p) {
  if (p.image && p.image.src) return p.image.src;
  if (Array.isArray(p.images) && p.images[0] && p.images[0].src) return p.images[0].src;
  return '';
}

// Map a Shopify product payload to the shape the content brain expects.
function mapProduct(p, domain) {
  const variant = (p.variants || [])[0] || {};
  const title = p.title || 'Untitled product';
  const tags = String(p.tags || '')
    .split(',')
    .map((t) => t.trim())
    .filter(Boolean)
    .slice(0, 6);
  return {
    id: String(p.id),
    title,
    shortTitle: title.length > 70 ? title.slice(0, 67) + '…' : title,
    type: p.product_type || '',
    vendor: p.vendor || '',
    price: inrPrice(variant.price),
    image: firstImage(p),
    tags,
    url: `https://${domain}/products/${p.handle}`,
  };
}

/**
 * Fetch products from the Shopify Admin REST API. Returns an array in our
 * product shape. Throws on auth/network errors so the caller can report them
 * WITHOUT ever exposing the token.
 */
async function fetchProducts(domain, token, limit = 100) {
  const host = normalizeDomain(domain);
  if (!host) throw new Error('no domain');
  if (!token) throw new Error('no token');

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const url = `https://${host}/admin/api/${API_VERSION}/products.json?limit=${Math.min(250, limit)}&status=active`;
    const resp = await fetch(url, {
      headers: { 'X-Shopify-Access-Token': token, 'content-type': 'application/json' },
      signal: ctrl.signal,
    });
    if (resp.status === 401 || resp.status === 403) throw new Error('unauthorized');
    if (!resp.ok) throw new Error('http ' + resp.status);
    const data = await resp.json();
    return (data.products || []).map((p) => mapProduct(p, host)).filter((p) => p.title);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Pull live products and save them into the store. Returns {ok, count} or
 * {ok:false, reason}. Never throws to the caller and never leaks the token.
 */
async function syncProducts() {
  const s = store.get().settings;
  const domain = (s.shopify && s.shopify.domain) || '';
  const token = decrypt((s.shopify && s.shopify.token) || '');
  if (!token) return { ok: false, reason: 'no-token' };
  try {
    const products = await fetchProducts(domain, token);
    if (!products.length) return { ok: false, reason: 'empty' };
    store.update((db) => {
      db.products = products;
      db.settings.shopify.lastSync = new Date().toISOString();
      db.settings.shopify.lastCount = products.length;
    });
    return { ok: true, count: products.length };
  } catch (e) {
    const reason = e && e.message === 'unauthorized' ? 'unauthorized' : 'error';
    return { ok: false, reason };
  }
}

module.exports = { syncProducts, fetchProducts, normalizeDomain };
