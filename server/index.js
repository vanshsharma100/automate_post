// Server entry — mounts the /api/v1 surface, serves the built SPA, runs the
// one-time bootstrap and starts the scheduler. Single origin (default :3001)
// serves both the app and the API (doc 01 §9 collapsed to one process).
import express from 'express';
import cookieParser from 'cookie-parser';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from './config.js';
import { cuid } from './crypto.js';
import { authMiddleware } from './auth.js';
import { bootstrap } from './seed.js';
import { startScheduler } from './scheduler.js';

import { router as authRouter } from './routes/auth.js';
import { router as brainRouter } from './routes/brain.js';
import { router as knowledgeRouter } from './routes/knowledge.js';
import { router as connectionsRouter } from './routes/connections.js';
import { router as contentRouter } from './routes/content.js';
import { router as opsRouter } from './routes/ops.js';
import { router as linkedinRouter } from './routes/linkedin.js';
import { router as googleBusinessRouter } from './routes/google-business.js';
import { router as metaRouter } from './routes/meta.js';

const app = express();
app.disable('x-powered-by');

// Request id + basic hardening headers (doc 08 §5, trimmed for local single-origin).
app.use((req, res, next) => {
  req.requestId = cuid('req');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(cookieParser());
app.use(authMiddleware);

// ── API ──────────────────────────────────────────────────────────────────────
const api = express.Router();
api.use('/auth', authRouter);
api.use('/brain', brainRouter);
api.use('/', knowledgeRouter);
api.use('/', connectionsRouter);
api.use('/', contentRouter);
api.use('/', opsRouter);
api.use('/', linkedinRouter);
api.use('/', googleBusinessRouter);
api.use('/', metaRouter);
app.use('/api/v1', api);

app.use('/api', (req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: `No route: ${req.method} ${req.path}` }, requestId: req.requestId }));

// ── Static SPA ─────────────────────────────────────────────────────────────────
if (existsSync(config.publicDir)) {
  app.use(express.static(config.publicDir));
  // SPA fallback for client-side routes (non-/api paths).
  app.get('*', (req, res) => {
    res.sendFile(resolve(config.publicDir, 'index.html'));
  });
} else {
  app.get('*', (req, res) => {
    res.status(200).type('html').send(`<!doctype html><meta charset=utf8><title>AutoPost</title>
      <div style="font:16px/1.6 system-ui;max-width:640px;margin:12vh auto;padding:24px;color:#e9ebf0;background:#0a0b0f">
      <h1 style="color:#c8f751">AutoPost API is running</h1>
      <p>The web build isn't present yet. Run <code style="color:#c8f751">npm run build</code> then restart, or during development run <code style="color:#c8f751">npm run dev:web</code> (Vite) alongside this server.</p>
      <p>API base: <code>/api/v1</code> · Health: <a style="color:#5b8def" href="/api/v1/health">/api/v1/health</a></p>
      </div>`);
  });
}

// ── Boot ───────────────────────────────────────────────────────────────────────
bootstrap();
startScheduler();

app.listen(config.port, () => {
  console.log(`\n  AutoPost running → http://localhost:${config.port}`);
  console.log(`  API base         → http://localhost:${config.port}/api/v1`);
  console.log(`  Super admin      → ${config.bootstrap.username} / (bootstrap password, must change on first login)\n`);
});
