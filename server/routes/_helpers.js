import { fail } from '../auth.js';
export { fail };

export function paginate(rows, query) {
  const page = Math.max(1, Number(query.page || 1));
  const limit = Math.min(200, Math.max(1, Number(query.limit || 25)));
  const total = rows.length;
  const start = (page - 1) * limit;
  return { data: rows.slice(start, start + limit), meta: { page, limit, total } };
}

export function sortRows(rows, sort, def = '-createdAt') {
  const s = sort || def;
  const desc = s.startsWith('-');
  const key = desc ? s.slice(1) : s;
  return [...rows].sort((a, b) => {
    const av = a[key], bv = b[key];
    if (av === bv) return 0;
    if (av == null) return 1;
    if (bv == null) return -1;
    return (av < bv ? -1 : 1) * (desc ? -1 : 1);
  });
}

// Wrap an async handler so rejections become clean 500s, not crashes.
export function h(fn) {
  return (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
    if (e.code === 'BUDGET_EXCEEDED') return fail(res, 402, 'BUDGET_EXCEEDED', e.message);
    if (e.code === 'NO_PROVIDER') return fail(res, 400, 'NO_PROVIDER', e.message);
    // Upstream/user-fixable failures (bad token, missing scope, rate limit)
    // carry their own 4xx status — surface it instead of a misleading 500.
    // NOTE: never re-emit 401 here. The web client treats a 401 as *its own*
    // session expiring and silently refreshes + retries, which would hide a bad
    // platform token behind a phantom login problem. Upstream 401/403 become
    // 400 — the caller's request is what needs fixing, not their session.
    if (Number.isInteger(e.status) && e.status >= 400 && e.status < 500) {
      const status = e.status === 401 || e.status === 403 ? 400 : e.status;
      const code = e.status === 401 ? 'UPSTREAM_UNAUTHORIZED' : e.status === 403 ? 'UPSTREAM_FORBIDDEN' : e.status === 429 ? 'UPSTREAM_RATE_LIMITED' : 'UPSTREAM_REJECTED';
      return fail(res, status, code, e.message);
    }
    console.error('[route error]', req.method, req.path, e);
    if (!res.headersSent) fail(res, 500, 'INTERNAL', e.message || 'Internal error');
  });
}

export function pickBody(body, keys) {
  const out = {};
  for (const k of keys) if (body[k] !== undefined) out[k] = body[k];
  return out;
}
