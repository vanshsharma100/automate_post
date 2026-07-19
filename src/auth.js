'use strict';

/**
 * Auth + CSRF middleware.
 *  - requireLogin: gate for protected pages.
 *  - csrfProtection: per-session token; validated on every POST.
 *  - exposeLocals: makes user + csrf token available to all views.
 */

const crypto = require('crypto');

function ensureCsrf(req) {
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(24).toString('hex');
  }
  return req.session.csrfToken;
}

function exposeLocals(req, res, next) {
  const token = ensureCsrf(req);
  res.locals.csrfToken = token;
  res.locals.currentUser = req.session.user || null;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
}

function requireLogin(req, res, next) {
  if (req.session && req.session.user) return next();
  return res.redirect('/login');
}

// Gate for owner-only pages (API keys/secrets, connectors, team management).
function requireSuper(req, res, next) {
  if (req.session && req.session.user && req.session.user.role === 'super') return next();
  return res.status(403).render('error', {
    title: 'Not allowed',
    message: 'Only a super admin can open this page. Ask the tool owner if you need access.',
  });
}

function csrfProtection(req, res, next) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  // Also accept the token from the query string so multipart/form-data uploads
  // (parsed later by multer) still pass the CSRF check. The token is a
  // per-session secret, so this is as safe as the hidden form field.
  const token =
    (req.body && req.body._csrf) ||
    (req.query && req.query._csrf) ||
    req.headers['x-csrf-token'];
  if (!token || token !== req.session.csrfToken) {
    return res.status(403).render('error', {
      title: 'Security check failed',
      message: 'Invalid or expired form token. Please go back and try again.',
    });
  }
  return next();
}

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

module.exports = { exposeLocals, requireLogin, requireSuper, csrfProtection, setFlash, ensureCsrf };
