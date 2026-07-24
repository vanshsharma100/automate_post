// Scheduler + autopilot + publish worker (doc 04 §7, doc 05 §9, doc 09 P5).
// In production this is BullMQ repeatable jobs + Redis locks; here it's an
// in-process tick with an in-memory lock set. The guard logic, idempotency,
// verify-after-publish, retry policy and circuit breaker are all real.
import { store } from './store.js';
import { cuid } from './crypto.js';
import { publish as connectorPublish, verify as connectorVerify, healthCheck } from './connectors/index.js';
import { runPipeline, nextSlotFor } from './pipeline.js';
import { emit } from './events.js';
import { notify } from './notify.js';

const publishLocks = new Set();      // in-process replacement for Redis publish:{postId}
let ticking = false;

export function masterMode(tenant) {
  return tenant?.settings?.masterSwitch || 'MANUAL';
}

function inQuietHours(schedule, now = new Date()) {
  const q = schedule?.quietHours;
  if (!q || !q.start || !q.end) return false;
  const [sh, sm] = q.start.split(':').map(Number);
  const [eh, em] = q.end.split(':').map(Number);
  const mins = now.getHours() * 60 + now.getMinutes();
  const start = sh * 60 + sm, end = eh * 60 + em;
  return start > end ? (mins >= start || mins < end) : (mins >= start && mins < end);
}

function publishedToday(connectionId) {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return store.count('posts', (p) => p.connectionId === connectionId && p.publishedAt && new Date(p.publishedAt) >= start);
}

function breakerOpen(connection) {
  return connection.circuitOpenUntil && new Date(connection.circuitOpenUntil) > new Date();
}

// ── Publish worker ───────────────────────────────────────────────────────────
export async function publishPost(postId, { manual = false } = {}) {
  if (publishLocks.has(postId)) return { skipped: 'locked' };
  publishLocks.add(postId);
  try {
    let post = store.get('posts', postId);
    if (!post) return { skipped: 'missing' };
    if (!['SCHEDULED', 'APPROVED'].includes(post.status)) return { skipped: `status ${post.status}` };
    const connection = store.get('connections', post.connectionId);
    if (!connection) return { skipped: 'no connection' };
    if (!manual && breakerOpen(connection)) return { skipped: 'breaker open' };

    store.update('posts', postId, { status: 'PUBLISHING' });
    emit(post.tenantId, 'post.updated', { postId, status: 'PUBLISHING' });
    const attemptNo = store.count('publishAttempts', (a) => a.postId === postId) + 1;
    const attempt = store.insert('publishAttempts', { postId, attemptNo, status: 'RUNNING', startedAt: new Date().toISOString() });
    const media = store.find('mediaAssets', (m) => m.postId === postId && !m.purgedAt);

    try {
      const result = await connectorPublish(connection, post, media);
      const verified = await connectorVerify(connection, result.externalId, result.externalUrl);
      store.update('posts', postId, {
        status: 'PUBLISHED', publishedAt: new Date().toISOString(),
        externalPostId: result.externalId, externalUrl: verified.externalUrl || result.externalUrl,
        generationMeta: { ...(post.generationMeta || {}), simulatedPublish: result.simulated },
      });
      store.update('publishAttempts', attempt.id, { status: 'SUCCEEDED', httpStatus: 200, finishedAt: new Date().toISOString(), responseSummary: { externalId: result.externalId, simulated: result.simulated } });
      store.update('connections', connection.id, { consecutiveFailures: 0, lastError: null, status: 'CONNECTED' });
      emit(post.tenantId, 'post.updated', { postId, status: 'PUBLISHED' });
      return { ok: true, externalUrl: verified.externalUrl || result.externalUrl, simulated: result.simulated };
    } catch (err) {
      const retryable = err.retryable !== false;
      store.update('publishAttempts', attempt.id, { status: 'FAILED', httpStatus: err.httpStatus || null, errorMessage: err.message, isRetryable: retryable, finishedAt: new Date().toISOString() });
      const fails = (connection.consecutiveFailures || 0) + 1;
      const patch = { consecutiveFailures: fails, lastError: err.message, status: 'ERROR' };
      if (fails >= 5) {
        patch.circuitOpenUntil = new Date(Date.now() + 24 * 3600e3).toISOString();
        patch.mode = connection.mode === 'AUTOPILOT' ? 'PAUSED' : connection.mode;
        notify(post.tenantId, 'error', `${connection.label} paused`, `5 consecutive publish failures tripped the circuit breaker.`);
      }
      store.update('connections', connection.id, patch);

      // Retryable → reschedule with backoff; else mark failed.
      const priorAttempts = store.count('publishAttempts', (a) => a.postId === postId);
      if (retryable && priorAttempts < 3) {
        const backoffMin = [1, 5, 15][priorAttempts - 1] || 15;
        store.update('posts', postId, { status: 'SCHEDULED', scheduledAt: new Date(Date.now() + backoffMin * 60e3).toISOString() });
        emit(post.tenantId, 'post.updated', { postId, status: 'SCHEDULED' });
        return { retryScheduled: backoffMin };
      }
      store.update('posts', postId, { status: 'FAILED' });
      notify(post.tenantId, 'error', 'Publish failed', `${connection.label}: ${err.message}`);
      emit(post.tenantId, 'post.updated', { postId, status: 'FAILED' });
      return { failed: err.message };
    }
  } finally {
    publishLocks.delete(postId);
  }
}

// ── Tick: publish due posts + autopilot generation + health refresh ──────────
async function publishDue() {
  const now = new Date();
  const due = store.find('posts', (p) => p.status === 'SCHEDULED' && p.scheduledAt && new Date(p.scheduledAt) <= now);
  for (const post of due) {
    const tenant = store.get('tenants', post.tenantId);
    if (masterMode(tenant) === 'PAUSED') continue;
    await publishPost(post.id);
  }
}

const DBG = !!process.env.SCHED_DEBUG;
async function autopilotGenerate() {
  const connections = store.find('connections', (c) => !c.archivedAt && (c.mode === 'AUTOPILOT' || c.mode === 'SHADOW'));
  for (const connection of connections) {
    const tenant = store.get('tenants', connection.tenantId);
    if (masterMode(tenant) === 'PAUSED') { if (DBG) console.log(`[sched] ${connection.label}: master PAUSED`); continue; }
    if (breakerOpen(connection)) { if (DBG) console.log(`[sched] ${connection.label}: breaker open`); continue; }
    const schedule = store.findOne('platformSchedules', (s) => s.connectionId === connection.id);
    if (!schedule || !schedule.isEnabled) { if (DBG) console.log(`[sched] ${connection.label}: schedule disabled`); continue; }
    if (inQuietHours(schedule)) { if (DBG) console.log(`[sched] ${connection.label}: quiet hours`); continue; }
    if (publishedToday(connection.id) >= (schedule.maxPerDay || 2)) { if (DBG) console.log(`[sched] ${connection.label}: daily cap`); continue; }

    // Is a slot due within the lead-time window, and nothing already queued for it?
    const next = nextSlotFor(connection.id, new Date());
    if (!next) { if (DBG) console.log(`[sched] ${connection.label}: no upcoming slot`); continue; }
    const leadMs = (schedule.leadTimeMinutes || 120) * 60e3;
    const soon = new Date(next).getTime() - Date.now() < leadMs;
    if (DBG) console.log(`[sched] ${connection.label}: next=${next} soon=${soon} mode=${connection.mode}`);
    if (!soon) continue;
    const alreadyQueued = store.count('posts', (p) => p.connectionId === connection.id && ['GENERATING', 'NEEDS_REVIEW', 'APPROVED', 'SCHEDULED'].includes(p.status) && p.scheduledAt === next);
    if (alreadyQueued) continue;

    const ratio = schedule.categoryRatio || { PRODUCT: 50, KNOWLEDGE: 50 };
    const category = Math.random() * 100 < (ratio.PRODUCT || 50) ? 'PRODUCT' : 'KNOWLEDGE';
    try {
      await runPipeline({ tenantId: connection.tenantId, connectionId: connection.id, category, trigger: 'CRON', scheduledAt: next, shadow: connection.mode === 'SHADOW' });
    } catch (e) {
      if (e.code === 'BUDGET_EXCEEDED') {
        store.update('tenants', tenant.id, { settings: { ...tenant.settings, masterSwitch: 'PAUSED' } });
        notify(tenant.id, 'error', 'Budget exceeded', 'Autopilot paused — monthly AI budget reached.');
      }
    }
  }
}

async function refreshHealth() {
  const connections = store.find('connections', (c) => !c.archivedAt);
  for (const c of connections) {
    const h = await healthCheck(c);
    if (h.status !== c.status && c.status !== 'PENDING_AUTH') {
      store.update('connections', c.id, { status: h.status, lastHealthCheckAt: h.at });
      emit(c.tenantId, 'connection.health', { connectionId: c.id, status: h.status });
    } else {
      store.update('connections', c.id, { lastHealthCheckAt: h.at });
    }
  }
}

export function startScheduler() {
  const tick = async () => {
    if (ticking) return;
    ticking = true;
    try {
      await publishDue();
      await autopilotGenerate();
    } catch (e) {
      console.error('[scheduler] tick error:', e.message);
    } finally {
      ticking = false;
    }
  };
  setInterval(tick, 15000).unref?.();
  setInterval(() => refreshHealth().catch(() => {}), 60000).unref?.();
  // Kick once shortly after boot.
  setTimeout(tick, 4000).unref?.();
  console.log('[scheduler] started (15s publish/autopilot tick, 60s health)');
}
