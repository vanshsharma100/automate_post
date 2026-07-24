// Authentication + authorization (doc 08). Access JWT (15 min) in memory,
// rotating refresh token (hashed, 30 d) in an HttpOnly cookie with reuse
// detection. Two authz layers: global role, then per-connection ACL.
import { store } from './store.js';
import { accessToken, randomToken, sha256, cuid } from './crypto.js';
import { ERROR } from './constants.js';

const REFRESH_TTL_DAYS = 30;
const REFRESH_COOKIE = 'ap_refresh';

export function issueTokens(user, req, family) {
  const sessionId = cuid('sess');
  const fam = family || cuid('fam');
  const refresh = randomToken(32);
  const expiresAt = new Date(Date.now() + REFRESH_TTL_DAYS * 864e5).toISOString();
  store.insert('userSessions', {
    id: sessionId, userId: user.id, refreshTokenHash: sha256(refresh), family: fam,
    userAgent: req?.headers?.['user-agent'] || null, ipAddress: req?.ip || null, expiresAt,
  });
  const access = accessToken.sign({ sub: user.id, tenantId: user.tenantId, role: user.role, sessionId });
  return { access, refresh, sessionId, expiresAt };
}

export function setRefreshCookie(res, refresh) {
  res.cookie(REFRESH_COOKIE, refresh, {
    httpOnly: true, sameSite: 'lax', secure: false, path: '/api/v1/auth', maxAge: REFRESH_TTL_DAYS * 864e5,
  });
}
export function clearRefreshCookie(res) {
  res.clearCookie(REFRESH_COOKIE, { path: '/api/v1/auth' });
}
export function readRefreshCookie(req) {
  return req.cookies?.[REFRESH_COOKIE] || null;
}

// Rotating refresh with reuse detection (doc 08 §2).
export function rotateRefresh(oldRefresh, req) {
  const hash = sha256(oldRefresh);
  const session = store.findOne('userSessions', (s) => s.refreshTokenHash === hash);
  if (!session) {
    // Unknown token: could be a rotated-away token being replayed. Best effort:
    // if it matches a revoked family we can't know here, so just reject.
    return { error: 'invalid_refresh' };
  }
  if (session.revokedAt) {
    // Reuse of a rotated token → revoke the entire family.
    store.updateWhere('userSessions', (s) => s.family === session.family, { revokedAt: new Date().toISOString() });
    return { error: 'reuse_detected' };
  }
  if (new Date(session.expiresAt) < new Date()) return { error: 'expired' };
  const user = store.get('users', session.userId);
  if (!user || user.status === 'SUSPENDED') return { error: 'no_user' };
  // Revoke the old session row, issue a new one in the same family.
  store.update('userSessions', session.id, { revokedAt: new Date().toISOString() });
  const tokens = issueTokens(user, req, session.family);
  return { tokens, user };
}

export function revokeSession(sessionId) {
  store.update('userSessions', sessionId, { revokedAt: new Date().toISOString() });
}
export function revokeAllForUser(userId) {
  store.updateWhere('userSessions', (s) => s.userId === userId && !s.revokedAt, { revokedAt: new Date().toISOString() });
}

// ── Middleware ───────────────────────────────────────────────────────────────
export function authMiddleware(req, res, next) {
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : null;
  if (token) {
    const payload = accessToken.verify(token);
    if (payload) {
      const session = store.get('userSessions', payload.sessionId);
      if (session && !session.revokedAt) {
        const user = store.get('users', payload.sub);
        if (user && user.status !== 'SUSPENDED') {
          req.auth = { userId: user.id, tenantId: user.tenantId, role: user.role, sessionId: payload.sessionId, user };
        }
      }
    }
  }
  next();
}

export function requireAuth(req, res, next) {
  if (!req.auth) return fail(res, 401, ERROR.UNAUTHORIZED, 'Authentication required');
  // Forced password change blocks everything except the change-password + me + logout routes.
  if (req.auth.user.mustChangePassword && !isPasswordChangeExempt(req)) {
    return fail(res, 403, 'MUST_CHANGE_PASSWORD', 'You must change your password before continuing');
  }
  next();
}

function isPasswordChangeExempt(req) {
  // Use the full original URL — req.path is router-relative and varies by mount.
  const p = (req.originalUrl || req.url || '').split('?')[0];
  return p === '/api/v1/auth/change-password' || p === '/api/v1/auth/me'
    || p === '/api/v1/auth/logout' || p === '/api/v1/bootstrap';
}

export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.auth) return fail(res, 401, ERROR.UNAUTHORIZED, 'Authentication required');
    if (!roles.includes(req.auth.role)) return fail(res, 403, ERROR.FORBIDDEN, `Requires role: ${roles.join(' or ')}`);
    next();
  };
}

// Effective permission = role allows AND ACL grants (deny wins). Admins bypass.
export function effectivePermissions(user, connectionId) {
  if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') {
    return { canView: true, canEdit: true, canPublish: true, canManageCreds: true, canToggleMode: true };
  }
  const acl = store.findOne('userPlatformAccess', (a) => a.userId === user.id && a.connectionId === connectionId);
  const base = acl || { canView: false, canEdit: false, canPublish: false, canManageCreds: false, canToggleMode: false };
  if (user.role === 'VIEWER') {
    return { canView: base.canView, canEdit: false, canPublish: false, canManageCreds: false, canToggleMode: false };
  }
  // EDITOR: creds/mode always denied by role regardless of ACL.
  return { canView: base.canView, canEdit: base.canEdit, canPublish: base.canPublish, canManageCreds: false, canToggleMode: base.canToggleMode && false };
}

export function requireConnectionAccess(permission) {
  return (req, res, next) => {
    const connectionId = req.params.id || req.params.connectionId || req.body?.connectionId;
    if (!connectionId) return fail(res, 400, ERROR.VALIDATION, 'connectionId required');
    const conn = store.get('connections', connectionId);
    if (!conn || conn.tenantId !== req.auth.tenantId) return fail(res, 404, ERROR.NOT_FOUND, 'Connection not found');
    const perms = effectivePermissions(req.auth.user, connectionId);
    if (!perms[permission]) return fail(res, 403, ERROR.FORBIDDEN, `Missing permission: ${permission}`);
    req.connection = conn;
    next();
  };
}

// Connections a user may see (used to scope lists). Admins see all.
export function visibleConnectionIds(user) {
  const all = store.find('connections', (c) => c.tenantId === user.tenantId && !c.archivedAt);
  if (user.role === 'SUPER_ADMIN' || user.role === 'ADMIN') return all.map((c) => c.id);
  return all.filter((c) => effectivePermissions(user, c.id).canView).map((c) => c.id);
}

export function fail(res, status, code, message, details) {
  return res.status(status).json({ error: { code, message, details }, requestId: res.req?.requestId });
}
