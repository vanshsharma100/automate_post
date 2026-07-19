'use strict';

/**
 * Scheduler — checks once per minute and fires whatever is due:
 *
 *  1. Per-platform weekly slots (days + HH:MM, editable in Settings → Schedule).
 *  2. Individual posts the owner scheduled for an exact date & time.
 *
 * MASTER SWITCH: if settings.paused is true, NOTHING runs — the whole
 * platform's automation is stopped until resumed from the Dashboard.
 *
 * For each slot it: picks a product, generates content (+ image), then either
 *  - Autopilot ON  + connector connected  -> would publish (logged),
 *  - otherwise                            -> saves a Draft for manual approval.
 */

const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const store = require('./store');
const config = require('./config');
const { generate } = require('./contentBrain');
const { publishPost } = require('./publisher');
const { decrypt } = require('./crypto');
const { PLATFORM_KEYS, PLATFORM_MAP } = require('./platforms');

/**
 * Daily database backup. Writes data/db.backup-YYYY-MM-DD.json and keeps only
 * the newest 7, so a bad edit or crash is always recoverable without the folder
 * growing without bound.
 */
function dailyBackup() {
  try {
    const dir = config.dataDir;
    const src = path.join(dir, 'db.json');
    if (!fs.existsSync(src)) return;
    const stamp = new Date().toISOString().slice(0, 10);
    fs.copyFileSync(src, path.join(dir, `db.backup-${stamp}.json`));
    // Prune to the 7 most recent dated backups.
    const backups = fs
      .readdirSync(dir)
      .filter((f) => /^db\.backup-\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort();
    while (backups.length > 7) {
      const old = backups.shift();
      try { fs.unlinkSync(path.join(dir, old)); } catch (_) {}
    }
  } catch (e) {
    console.error('[backup]', e.message);
  }
}

function pickProduct() {
  const products = store.get().products;
  if (!products.length) return null;
  // Rotate by day so it isn't always the same product.
  const idx = new Date().getDate() % products.length;
  return products[idx];
}

/**
 * What kind of post this platform should produce right now, from its content
 * mode: 'product' | 'general' | 'mix' (mix alternates 50/50).
 */
function resolveContentType(platformKey) {
  const mode = (store.get().settings.contentMode || {})[platformKey] || 'product';
  if (mode === 'general') return 'general';
  if (mode === 'mix') return Math.random() < 0.5 ? 'general' : 'product';
  return 'product';
}

/**
 * Which accounts a platform posts to. ANY platform can have MANY accounts —
 * each enabled one gets its own post. Returns [null] when none are configured
 * yet, so drafts still generate.
 */
function targetsFor(platformKey) {
  const s = store.get().settings;
  const list = (s.accounts || []).filter((a) => a.platform === platformKey && a.enabled);
  return list.length ? list : [null];
}

/** The developer-app credential each platform needs before it can publish. */
function appCredFor(platformKey) {
  const s = store.get().settings;
  const p = PLATFORM_MAP[platformKey];
  if (!p) return false;
  switch (p.app) {
    case 'meta':     return !!s.connectors.meta.appId;
    case 'linkedin': return !!s.connectors.linkedin.clientId;
    case 'google':   return !!s.connectors.google.clientId;
    case 'shopify':  return !!decrypt(s.shopify.token || '');
    default:         return false;
  }
}

/** Is this platform+account ready to actually publish? */
function isConnected(platformKey, account) {
  const p = PLATFORM_MAP[platformKey];
  if (!p) return false;
  if (!appCredFor(platformKey)) return false;
  // Blog publishes through the store connection, so it only needs its target id.
  if (!p.needsAccountToken) return !!(account && p.fields.every((f) => account[f.name]));
  if (!account || !account.token) return false;
  return p.fields.every((f) => !!account[f.name]);
}

async function runSlot(platformKey, { manual = false, postType } = {}) {
  const type = postType || resolveContentType(platformKey);
  const product = pickProduct();
  // Product posts need a product; general posts don't.
  if (type !== 'general' && !product) return { ok: false, reason: 'no products' };

  const s = store.get();
  const toggle = s.settings.toggles[platformKey] || 'draft';
  const targets = targetsFor(platformKey);
  const records = [];

  for (const account of targets) {
    const post = await generate(product, platformKey, account, { postType: type });
    const connected = isConnected(platformKey, account);

    const record = {
      id: 'post_' + Date.now() + '_' + platformKey + (account ? '_' + account.id : '') + '_' + Math.random().toString(36).slice(2, 7),
      ...post,
      status: 'draft',
      approved: false,
      trigger: manual ? 'manual' : 'schedule',
    };

    // AUTOPILOT: actually publish, right now, without asking.
    // MANUAL (draft): just save it — the owner presses "Publish now".
    if (toggle === 'auto' && connected) {
      const r = await publishPost(record, account);
      if (r.ok) {
        record.status = 'published';
        record.approved = true;
        record.permalink = r.permalink || null;
        record.publishedAt = new Date().toISOString();
        record.note = null;
      } else {
        record.status = 'failed';
        record.note = 'Auto-publish failed — ' + r.error + ' Fix it and press "Publish now".';
      }
    } else if (toggle === 'auto' && !connected) {
      record.note = account
        ? `Autopilot is ON but "${account.label}" is not connected yet — saved as Draft.`
        : 'Autopilot is ON but this platform is not connected yet — saved as Draft.';
    }

    const status = record.status;
    records.push(record);

    store.update((d) => {
      d.posts.unshift(record);
      d.logs.unshift({
        at: new Date().toISOString(),
        platform: platformKey,
        account: account ? account.label : null,
        status,
        product: product.shortTitle || product.title,
        trigger: record.trigger,
      });
      d.posts = d.posts.slice(0, 200);
      d.logs = d.logs.slice(0, 200);
    });
  }

  return { ok: true, records, count: records.length };
}

/* --------------------------- minute tick ----------------------------- */

async function tick() {
  const d = store.get();

  // MASTER SWITCH — everything stops when paused.
  if (d.settings.paused) return;

  const now = new Date();
  const day = now.getDay(); // 0=Sun..6=Sat
  const hhmm =
    String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  // 1) Platform slots — any number of times per day, on any chosen days.
  for (const k of PLATFORM_KEYS) {
    const sc = d.settings.schedule[k];
    if (!sc || !Array.isArray(sc.days) || !Array.isArray(sc.times)) continue;
    if (sc.days.includes(day) && sc.times.includes(hhmm)) {
      const stamp = now.toISOString().slice(0, 10) + ' ' + hhmm;
      if (d.lastRuns[k] !== stamp) {
        store.update((db) => { db.lastRuns[k] = stamp; });
        try { await runSlot(k); } catch (e) { console.error('[scheduler]', k, e.message); }
      }
    }
  }

  // 2) Individually scheduled posts whose time has arrived.
  const due = d.posts.filter(
    (p) => p.status === 'scheduled' && p.scheduledAt && new Date(p.scheduledAt) <= now
  );
  for (const p of due) {
    // Fall back to the first enabled account when the post didn't pin one.
    const accounts = d.settings.accounts || [];
    const account = p.accountId
      ? accounts.find((a) => a.id === p.accountId) || null
      : accounts.find((a) => a.platform === p.platform && a.enabled) || null;
    const connected = isConnected(p.platform, account);

    let result = null;
    if (connected) result = await publishPost(p, account);

    store.update((db) => {
      const rec = db.posts.find((x) => x.id === p.id);
      if (!rec) return;
      if (result && result.ok) {
        rec.status = 'published';
        rec.approved = true;
        rec.permalink = result.permalink || null;
        rec.publishedAt = new Date().toISOString();
        rec.note = null;
      } else if (result) {
        rec.status = 'failed';
        rec.note = 'Scheduled publish failed — ' + result.error + ' Press "Publish now" to retry.';
      } else {
        rec.status = 'approved';
        rec.note = 'Scheduled time reached — will publish as soon as the platform connector is added.';
      }
      db.logs.unshift({
        at: new Date().toISOString(),
        platform: p.platform,
        status: rec.status,
        product: p.productTitle,
        trigger: 'scheduled-post',
      });
      db.logs = db.logs.slice(0, 200);
    });
  }
}

function start() {
  cron.schedule('* * * * *', tick);
  cron.schedule('0 3 * * *', dailyBackup); // 3 AM daily
  dailyBackup(); // also snapshot once on boot
  console.log('[scheduler] running — checks every minute (weekly slots + scheduled posts, master pause respected).');
}

module.exports = { start, runSlot, tick, targetsFor, isConnected };
