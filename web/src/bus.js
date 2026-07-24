// Minimal event bus so the SSE stream in the Shell can notify any screen.
const map = new Map();
export function on(event, fn) {
  if (!map.has(event)) map.set(event, new Set());
  map.get(event).add(fn);
  return () => map.get(event)?.delete(fn);
}
export function emitBus(event, data) {
  map.get(event)?.forEach((fn) => { try { fn(data); } catch { /* ignore */ } });
}
