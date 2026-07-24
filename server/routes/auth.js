import express from 'express';
import { store } from '../store.js';
import { verifyPassword, hashPassword } from '../crypto.js';
import { issueTokens, setRefreshCookie, clearRefreshCookie, readRefreshCookie, rotateRefresh, revokeSession, revokeAllForUser, requireAuth, fail } from '../auth.js';
import { audit } from '../audit.js';
import { h } from './_helpers.js';

const COMMON_WEAK = ['password', '12345678', 'golu9588', 'qwertyui', 'admin1234', 'letmein12'];
export const router = express.Router();

router.post('/login', h((req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return fail(res, 400, 'VALIDATION', 'username and password required');
  const user = store.findOne('users', (u) => u.username === username);
  if (!user) { return fail(res, 401, 'UNAUTHORIZED', 'Invalid credentials'); }
  if (user.lockedUntil && new Date(user.lockedUntil) > new Date()) {
    return fail(res, 429, 'RATE_LIMITED', 'Account temporarily locked after failed attempts. Try again shortly.');
  }
  if (user.status === 'SUSPENDED') return fail(res, 403, 'FORBIDDEN', 'Account suspended');
  if (!verifyPassword(password, user.passwordHash)) {
    const fails = (user.failedLoginCount || 0) + 1;
    const patch = { failedLoginCount: fails };
    if (fails >= 5) { patch.lockedUntil = new Date(Date.now() + 15 * 60e3).toISOString(); patch.failedLoginCount = 0; }
    store.update('users', user.id, patch);
    audit(req, 'auth.login.failed', { entityType: 'user', entityId: user.id });
    return fail(res, 401, 'UNAUTHORIZED', 'Invalid credentials');
  }
  store.update('users', user.id, { failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date().toISOString() });
  const tokens = issueTokens(user, req);
  setRefreshCookie(res, tokens.refresh);
  audit(req, 'auth.login.success', { entityType: 'user', entityId: user.id });
  res.json({ accessToken: tokens.access, mustChangePassword: !!user.mustChangePassword, user: publicUser(user) });
}));

router.post('/refresh', h((req, res) => {
  const token = readRefreshCookie(req) || req.body?.refreshToken;
  if (!token) return fail(res, 401, 'UNAUTHORIZED', 'No refresh token');
  const result = rotateRefresh(token, req);
  if (result.error) {
    clearRefreshCookie(res);
    if (result.error === 'reuse_detected') audit(req, 'auth.refresh.reuse_detected');
    return fail(res, 401, 'UNAUTHORIZED', 'Session expired, please sign in again');
  }
  setRefreshCookie(res, result.tokens.refresh);
  res.json({ accessToken: result.tokens.access, user: publicUser(result.user) });
}));

router.post('/logout', h((req, res) => {
  if (req.auth) revokeSession(req.auth.sessionId);
  clearRefreshCookie(res);
  res.json({ ok: true });
}));

router.get('/me', requireAuth, h((req, res) => {
  res.json({ user: publicUser(req.auth.user) });
}));

router.post('/change-password', requireAuth, h((req, res) => {
  const { currentPassword, newPassword } = req.body || {};
  const user = store.get('users', req.auth.userId);
  // On first forced change we still require the current (bootstrap) password.
  if (!verifyPassword(currentPassword || '', user.passwordHash)) return fail(res, 400, 'VALIDATION', 'Current password is incorrect');
  const err = validatePassword(newPassword, user.username);
  if (err) return fail(res, 400, 'VALIDATION', err);
  store.update('users', user.id, { passwordHash: hashPassword(newPassword), mustChangePassword: false });
  revokeAllForUser(user.id); // sessions revoked on password change (doc 08 §2)
  const tokens = issueTokens(store.get('users', user.id), req);
  setRefreshCookie(res, tokens.refresh);
  audit(req, 'auth.password.change', { entityType: 'user', entityId: user.id });
  res.json({ ok: true, accessToken: tokens.access, user: publicUser(store.get('users', user.id)) });
}));

router.get('/sessions', requireAuth, h((req, res) => {
  const sessions = store.find('userSessions', (s) => s.userId === req.auth.userId && !s.revokedAt)
    .map((s) => ({ id: s.id, userAgent: s.userAgent, ipAddress: s.ipAddress, createdAt: s.createdAt, current: s.id === req.auth.sessionId }));
  res.json({ data: sessions });
}));

router.delete('/sessions/:id', requireAuth, h((req, res) => {
  const s = store.get('userSessions', req.params.id);
  if (!s || s.userId !== req.auth.userId) return fail(res, 404, 'NOT_FOUND', 'Session not found');
  revokeSession(s.id);
  res.json({ ok: true });
}));

function validatePassword(pw, username) {
  if (!pw || pw.length < 12) return 'Password must be at least 12 characters';
  if (COMMON_WEAK.includes(pw.toLowerCase())) return 'That password is too common';
  if (username && pw.toLowerCase().includes(username.toLowerCase())) return 'Password must not contain your username';
  return null;
}

export function publicUser(u) {
  return { id: u.id, tenantId: u.tenantId, username: u.username, email: u.email, recoveryEmail: u.recoveryEmail, role: u.role, status: u.status, mfaEnabled: u.mfaEnabled, mustChangePassword: !!u.mustChangePassword, lastLoginAt: u.lastLoginAt };
}
