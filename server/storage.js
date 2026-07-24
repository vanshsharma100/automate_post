// Storage quota + purge engine (doc 05 §11, requirement 14). Core principle:
// purge bytes, keep metadata. The purge worker has hard safety rules and
// hysteresis so it never touches a draft's media and never runs away.
import { store } from './store.js';
import { audit } from './audit.js';
import { notify } from './notify.js';

export function usageFor(connectionId) {
  const assets = store.find('mediaAssets', (m) => m.connectionId === connectionId && !m.purgedAt);
  const used = assets.reduce((s, m) => s + Number(m.bytes || 0), 0);
  const quota = store.findOne('platformQuotas', (q) => q.connectionId === connectionId);
  const maxBytes = Number(quota?.maxBytes || 5368709120);
  const oldest = assets.reduce((min, m) => (!min || m.createdAt < min ? m.createdAt : min), null);
  return {
    usedBytes: used, maxBytes, assetCount: assets.length,
    percent: Math.round((used / maxBytes) * 100),
    oldestRetained: oldest, quota: quota || null,
  };
}

// Compute purge candidates under the connection's strategy + safety rules.
export function purgeCandidates(connectionId) {
  const quota = store.findOne('platformQuotas', (q) => q.connectionId === connectionId);
  if (!quota || quota.purgeStrategy === 'NEVER') return { candidates: [], reason: 'purge disabled (NEVER)' };
  const retentionMs = (quota.retentionDays || 180) * 864e5;
  const cutoff = Date.now() - retentionMs;

  const assets = store.find('mediaAssets', (m) => m.connectionId === connectionId && !m.purgedAt);
  const postById = Object.fromEntries(store.find('posts', () => true).map((p) => [p.id, p]));

  let candidates = assets.filter((m) => {
    const post = m.postId ? postById[m.postId] : null;
    // Only PUBLISHED posts' media are ever eligible; never drafts/scheduled.
    if (!post || post.status !== 'PUBLISHED') return false;
    const publishedAt = post.publishedAt ? new Date(post.publishedAt).getTime() : new Date(m.createdAt).getTime();
    return publishedAt < cutoff;
  });
  if (quota.purgeStrategy === 'PUBLISHED_ONLY') { /* already filtered to published */ }
  if (quota.purgeStrategy === 'LARGEST_FIRST') candidates.sort((a, b) => Number(b.bytes) - Number(a.bytes));
  else candidates.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt)); // OLDEST_FIRST

  // Safety: never purge >20% of assets in one run without an override.
  const maxPerRun = Math.max(1, Math.floor(assets.length * 0.2));
  return { candidates, maxPerRun, quota };
}

// dryRun=true returns exactly what would go; false performs the purge.
export function purge(connectionId, { dryRun = true, force = false } = {}, req) {
  const { candidates, maxPerRun, quota, reason } = purgeCandidates(connectionId);
  if (reason) return { dryRun, freedBytes: 0, count: 0, items: [], note: reason };
  const usage = usageFor(connectionId);
  const target = usage.maxBytes * 0.85; // hysteresis — free down to 85%, then stop

  const toPurge = [];
  let projected = usage.usedBytes;
  for (const m of candidates) {
    if (projected <= target && !force) break;
    if (!force && toPurge.length >= maxPerRun) break;
    toPurge.push(m);
    projected -= Number(m.bytes || 0);
  }

  const freedBytes = toPurge.reduce((s, m) => s + Number(m.bytes || 0), 0);
  if (!dryRun && toPurge.length) {
    for (const m of toPurge) {
      store.update('mediaAssets', m.id, {
        purgedAt: new Date().toISOString(),
        storageKey: null,
        thumbnailKey: quota.keepThumbnails ? m.thumbnailKey : null,
        // keepMetadata=true → the row survives with purgedAt set (History still renders).
      });
    }
    audit(req, 'storage.purge', { entityType: 'connection', entityId: connectionId, after: { freedBytes, count: toPurge.length } });
    const conn = store.get('connections', connectionId);
    notify(conn.tenantId, 'info', 'Storage purged', `Freed ${(freedBytes / 1e9).toFixed(2)} GB from ${conn.label} (${toPurge.length} assets).`);
  }

  return {
    dryRun, freedBytes, count: toPurge.length,
    items: toPurge.map((m) => ({ id: m.id, bytes: m.bytes, createdAt: m.createdAt, altText: m.altText })),
    afterUsedBytes: usage.usedBytes - freedBytes, maxBytes: usage.maxBytes,
  };
}

// Warn at threshold — called after uploads/generation.
export function checkQuotaWarning(connectionId) {
  const u = usageFor(connectionId);
  const warnAt = u.quota?.warnAtPercent || 80;
  if (u.percent >= warnAt) {
    const conn = store.get('connections', connectionId);
    notify(conn.tenantId, 'warning', 'Storage warning', `${conn.label} storage at ${u.percent}% of limit.`, '/media');
  }
  return u;
}
