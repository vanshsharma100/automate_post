// Server-Sent Events hub (doc 01 §5). One-directional stream to the UI:
// run.progress, post.updated, connection.health, quota.warning, notification.
const clients = new Map(); // id -> { res, tenantId }
let nextId = 1;

export function addClient(res, tenantId) {
  const id = nextId++;
  clients.set(id, { res, tenantId });
  res.write(`event: hello\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  return id;
}

export function removeClient(id) {
  clients.delete(id);
}

export function emit(tenantId, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const { res, tenantId: t } of clients.values()) {
    if (t === tenantId) {
      try { res.write(payload); } catch { /* client gone */ }
    }
  }
}

// Heartbeat so proxies don't close idle connections.
setInterval(() => {
  for (const { res } of clients.values()) {
    try { res.write(': ping\n\n'); } catch { /* ignore */ }
  }
}, 25000).unref?.();
