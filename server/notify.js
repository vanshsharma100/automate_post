// In-app notifications (doc 05 §10, doc 02 Notification). Email delivery would
// attach here via SMTP; the in-app feed + SSE push is what the bell renders.
import { store } from './store.js';
import { emit } from './events.js';

export function notify(tenantId, level, title, body, link) {
  const n = store.insert('notifications', { tenantId, level: level || 'info', title, body: body || null, link: link || null, readAt: null });
  emit(tenantId, 'notification', { id: n.id, level: n.level, title: n.title });
  return n;
}
