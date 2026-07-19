'use strict';

/**
 * F-Tech Automation Posts — main server.
 * Express + EJS. All secrets live server-side; the browser never receives them.
 */

const fs = require('fs');
const path = require('path');
const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');

const config = require('./src/config');
const store = require('./src/store');
const { encrypt, decrypt, maskSecret, verifyPassword, hashPassword, randomToken } = require('./src/crypto');
const { exposeLocals, requireLogin, requireSuper, csrfProtection, setFlash } = require('./src/auth');
const { sendMail } = require('./src/mailer');
const { generate, generateImage, PLATFORM_META } = require('./src/contentBrain');
const { PLATFORMS, PLATFORM_KEYS, PLATFORM_MAP } = require('./src/platforms');
const { TEXT_PROVIDERS, IMAGE_PROVIDERS, TEXT_KEYS } = require('./src/brain');
const shopify = require('./src/shopify');
const publisher = require('./src/publisher');
const scheduler = require('./src/scheduler');

// Persistent folders for user uploads + AI-generated images (live under data/
// so a deploy with a mounted disk keeps them). Created on boot.
const UPLOADS_DIR = path.join(config.dataDir, 'uploads');
const GENERATED_DIR = path.join(config.dataDir, 'generated');
[UPLOADS_DIR, GENERATED_DIR].forEach((d) => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// Uploads: images + short videos, capped so the disk can't be flooded.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOADS_DIR),
    filename: (req, file, cb) => {
      const ext = (path.extname(file.originalname || '') || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
      cb(null, 'up-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + ext);
    },
  }),
  limits: { fileSize: 80 * 1024 * 1024, files: 2 }, // 80 MB per file
  fileFilter: (req, file, cb) => {
    const ok = /^image\//.test(file.mimetype) || /^video\//.test(file.mimetype);
    cb(null, ok);
  },
});

// The ID field(s) each platform's account needs — derived from the platform list.
const ACCOUNT_FIELDS = PLATFORMS.reduce((m, p) => {
  m[p.key] = p.fields;
  return m;
}, {});

// Sections shown on the Knowledge page — one per platform.
const KNOWLEDGE_PLATFORMS = PLATFORMS.map((p) => ({ key: p.key, label: p.label, icon: p.icon }));

store.load();

const app = express();
app.set('trust proxy', 1);
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// --- Security headers ---
app.use(
  helmet({
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        imgSrc: ["'self'", 'https://cdn.shopify.com', 'https:', 'data:'],
        mediaSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        scriptSrc: ["'self'"],
        objectSrc: ["'none'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
      },
    },
  })
);

app.use(express.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, 'public')));

app.use(
  session({
    name: 'ftech.sid',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: config.nodeEnv === 'production',
      maxAge: 1000 * 60 * 60 * 8, // 8h
    },
  })
);

app.use(exposeLocals);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: 'Too many attempts. Please wait a few minutes and try again.',
});

// Health check for uptime pings / deploy platforms (no auth, no secrets).
app.get('/healthz', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// PUBLIC media, by unguessable signed link. Instagram and Google Business can
// only fetch a public image URL, so publishing needs one — but only for the
// exact file whose signature matches. The folder itself stays private.
app.get('/p/:kind/:sig/:name', (req, res) => {
  const { kind, sig } = req.params;
  const name = path.basename(req.params.name);
  if (kind !== 'uploads' && kind !== 'generated') return res.status(404).end();
  if (!publisher.verifyMediaSignature(kind, name, sig)) return res.status(403).end();
  const dir = kind === 'uploads' ? UPLOADS_DIR : GENERATED_DIR;
  const file = path.join(dir, name);
  if (!fs.existsSync(file)) return res.status(404).end();
  return res.sendFile(file);
});

/* ============================ AUTH ROUTES ============================ */

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/');
  res.render('login', { title: 'Sign in' });
});

app.post('/login', loginLimiter, csrfProtection, (req, res) => {
  const { username, password } = req.body;
  const user = store.findUserByUsername(username);
  if (user && verifyPassword(password, user.passHash)) {
    req.session.regenerate((err) => {
      if (err) return res.render('login', { title: 'Sign in', error: 'Session error, try again.' });
      req.session.user = { id: user.id, username: user.username, role: user.role };
      req.session.csrfToken = require('crypto').randomBytes(24).toString('hex');
      if (user.mustChangePassword) setFlash(req, 'warn', 'You are using a temporary password — please change it in My Account.');
      res.redirect('/');
    });
  } else {
    res.status(401).render('login', { title: 'Sign in', error: 'Invalid username or password.' });
  }
});

app.get('/forgot', (req, res) => {
  res.render('forgot', { title: 'Forgot password' });
});

app.post('/forgot', loginLimiter, csrfProtection, async (req, res) => {
  // Reset the OWNER (super admin) to a new temporary password and email it to
  // the recovery address. Passwords are hashed and cannot be recovered, so we
  // issue a fresh one. (Team members get a reset from the owner in Team.)
  const d = store.get();
  const recovery = d.settings.recoveryEmail || config.defaultRecoveryEmail;
  const owner = d.users.find((u) => u.role === 'super') || d.users[0];
  const temp = randomToken(9); // ~12 char URL-safe temp password
  store.update((db) => {
    const u = db.users.find((x) => x.id === owner.id);
    if (u) {
      u.passHash = hashPassword(temp);
      u.mustChangePassword = true;
      u.updatedAt = new Date().toISOString();
    }
  });

  const text =
    `F-Tech Automation Posts — account recovery\n\n` +
    `Username: ${owner.username}\n` +
    `Temporary password: ${temp}\n\n` +
    `Sign in and change the password immediately in My Account.\n`;

  let info;
  try {
    info = await sendMail({ to: recovery, subject: 'F-Tech Automation — your login details', text });
  } catch (e) {
    info = { delivered: false, error: true };
  }

  res.render('forgot', {
    title: 'Forgot password',
    done: true,
    recovery,
    delivered: !!info.delivered,
    outbox: info.file ? path.basename(info.file) : null,
  });
});

app.post('/logout', csrfProtection, (req, res) => {
  req.session.destroy(() => res.redirect('/login'));
});

/* ===================== PROTECTED APP (login req) ==================== */

app.use(requireLogin);
app.use(csrfProtection);

// Serve user uploads + AI-generated images from the persistent data/ folder,
// but only to a logged-in user. path.basename blocks any directory traversal.
function serveMedia(dir) {
  return (req, res) => {
    const file = path.join(dir, path.basename(req.params.name));
    if (!fs.existsSync(file)) return res.status(404).end();
    return res.sendFile(file);
  };
}
app.get('/media/uploads/:name', serveMedia(UPLOADS_DIR));
app.get('/media/generated/:name', serveMedia(GENERATED_DIR));

// Dashboard
app.get('/', (req, res) => {
  const d = store.get();
  const accts = d.settings.accounts || [];
  const platforms = PLATFORMS.map((p) => {
    const list = accts.filter((a) => a.platform === p.key && a.enabled);
    return {
      key: p.key,
      label: p.label,
      icon: p.icon,
      connected: list.some((a) => scheduler.isConnected(p.key, a)),
      accounts: list.length,
    };
  });
  const brain = d.settings.brain || {};
  const activeProv = (brain.providers || {})[brain.active] || {};
  res.render('dashboard', {
    title: 'Dashboard',
    active: 'dashboard',
    settings: d.settings,
    platforms,
    posts: d.posts.slice(0, 6),
    logs: d.logs.slice(0, 8),
    productCount: d.products.length,
    brainActive: brain.active || 'claude',
    brainReady: !!(activeProv.enabled && decrypt(activeProv.apiKey || '')),
    shopifyConnected: !!decrypt(d.settings.shopify.token || ''),
  });
});

// Products
app.get('/products', (req, res) => {
  const d = store.get();
  res.render('products', {
    title: 'Products',
    active: 'products',
    products: d.products,
    shopify: d.settings.shopify,
    shopifyConnected: !!decrypt(d.settings.shopify.token || ''),
  });
});

// Pull the live catalogue from Shopify (main content source).
app.post('/products/sync', async (req, res) => {
  const r = await shopify.syncProducts();
  if (r.ok) {
    setFlash(req, 'ok', `Synced ${r.count} product${r.count === 1 ? '' : 's'} from Shopify.`);
  } else if (r.reason === 'no-token') {
    setFlash(req, 'warn', 'Add your Shopify Admin API token in Settings → Product source first.');
  } else if (r.reason === 'unauthorized') {
    setFlash(req, 'error', 'Shopify rejected the token. Check it has read_products access and try again.');
  } else if (r.reason === 'empty') {
    setFlash(req, 'warn', 'Shopify returned no active products.');
  } else {
    setFlash(req, 'error', 'Could not reach Shopify. Check the store domain and token.');
  }
  res.redirect('/products');
});

// Content (drafts + generate)
app.get('/content', (req, res) => {
  const d = store.get();
  const brain = d.settings.brain || {};
  const activeProv = (brain.providers || {})[brain.active] || {};
  res.render('content', {
    title: 'Content',
    active: 'content',
    products: d.products,
    posts: d.posts,
    platforms: PLATFORM_META,
    platformList: PLATFORMS,
    accounts: d.settings.accounts || [],
    aiConnected: !!(activeProv.enabled && decrypt(activeProv.apiKey || '')),
    brainActive: brain.active || 'claude',
  });
});

// Manual composer — write your own post + attach a picture and/or a video.
// Uses multipart/form-data, so the CSRF token travels in the query string.
app.post('/content/create', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'video', maxCount: 1 }]), (req, res) => {
  const d = store.get();
  const platform = req.body.platform;
  if (!PLATFORM_MAP[platform]) {
    setFlash(req, 'error', 'Pick a platform for your post.');
    return res.redirect('/content');
  }
  const text = (req.body.text || '').trim();
  const description = (req.body.description || '').trim();
  if (!text && !description) {
    setFlash(req, 'error', 'Write some post text before saving.');
    return res.redirect('/content');
  }

  const files = req.files || {};
  const photo = (files.photo || [])[0];
  const video = (files.video || [])[0];

  // Optional exact schedule.
  let scheduledAt = null;
  const when = (req.body.scheduledAt || '').trim();
  if (when) {
    const dt = new Date(when);
    if (!isNaN(dt.getTime())) scheduledAt = dt.toISOString();
  }

  // Optional account target.
  let account = null;
  if (req.body.accountId && req.body.accountId !== 'none') {
    account = (d.settings.accounts || []).find((a) => a.id === req.body.accountId && a.platform === platform) || null;
  }

  const p = PLATFORM_MAP[platform];
  const record = {
    id: 'post_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    platform,
    platformLabel: p.label,
    postType: 'manual',
    accountId: account ? account.id : null,
    accountLabel: account ? account.label : null,
    productId: null,
    productTitle: 'Your own post',
    text: text || description,
    description: description || null,
    engine: 'you',
    engineLabel: 'written by you',
    image: photo ? '/media/uploads/' + photo.filename : '',
    imageEngine: photo ? 'upload' : 'none',
    video: video ? '/media/uploads/' + video.filename : '',
    note: null,
    status: scheduledAt ? 'scheduled' : 'draft',
    scheduledAt: scheduledAt || undefined,
    approved: false,
    trigger: 'manual',
    createdAt: new Date().toISOString(),
  };
  store.update((db) => {
    db.posts.unshift(record);
    db.posts = db.posts.slice(0, 200);
  });
  setFlash(req, 'ok',
    `Your ${p.label} post is saved${scheduledAt ? ' and scheduled for ' + new Date(scheduledAt).toLocaleString() : ' as a draft'}` +
    `${photo ? ' · photo attached' : ''}${video ? ' · video attached' : ''}.`);
  res.redirect('/content');
});

app.post('/content/generate', async (req, res) => {
  const { productId, platform, accountId } = req.body;
  const postType = req.body.postType === 'general' ? 'general' : 'product';
  const d = store.get();
  if (!PLATFORM_MAP[platform]) {
    setFlash(req, 'error', 'Pick a platform.');
    return res.redirect('/content');
  }
  // Product posts need a product; general posts don't.
  const product = d.products.find((p) => p.id === productId) || d.products[0] || null;
  if (postType === 'product' && !product) {
    setFlash(req, 'error', 'Pick a product, or switch the post type to "General".');
    return res.redirect('/content');
  }

  // Optional: schedule the new post(s) for an exact date & time.
  let scheduledAt = null;
  const when = (req.body.scheduledAt || '').trim();
  if (when) {
    const dt = new Date(when);
    if (!isNaN(dt.getTime())) scheduledAt = dt.toISOString();
  }

  // An account may be chosen; "all" fans out to every enabled account on that platform.
  let accounts = [null];
  const enabled = (d.settings.accounts || []).filter((a) => a.platform === platform && a.enabled);
  if (accountId && accountId !== 'all') {
    const one = (d.settings.accounts || []).find((a) => a.id === accountId && a.platform === platform);
    accounts = one ? [one] : [null];
  } else if (enabled.length) {
    accounts = enabled;
  }

  let engine = 'template';
  for (const account of accounts) {
    const post = await generate(product, platform, account, { postType });
    engine = post.engine;
    const record = {
      id: 'post_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      ...post,
      status: scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: scheduledAt || undefined,
      approved: false,
      trigger: 'manual',
    };
    store.update((db) => {
      db.posts.unshift(record);
      db.posts = db.posts.slice(0, 200);
    });
  }
  const n = accounts.length;
  const label = PLATFORM_MAP[platform].label;
  const kind = postType === 'general' ? 'general' : 'product';
  setFlash(req, 'ok',
    `Generated ${n > 1 ? n + ' ' + label + ' ' + kind + ' drafts (one per account)' : 'a ' + label + ' ' + kind + ' draft'} ` +
    `(${engine === 'template' ? 'template preview' : 'via ' + engine})` +
    `${scheduledAt ? ' — scheduled for ' + new Date(scheduledAt).toLocaleString() : ''}.`);
  res.redirect('/content');
});

// MANUAL PUBLISH — "Publish now". Sends this one post to the platform
// immediately, whatever the platform's Autopilot/Manual switch is set to.
app.post('/content/:id/publish', async (req, res) => {
  const d = store.get();
  const post = d.posts.find((x) => x.id === req.params.id);
  if (!post) {
    setFlash(req, 'error', 'That post no longer exists.');
    return res.redirect('/content');
  }
  const accounts = d.settings.accounts || [];
  const account = post.accountId
    ? accounts.find((a) => a.id === post.accountId) || null
    : accounts.find((a) => a.platform === post.platform && a.enabled) || null;

  const r = await publisher.publishPost(post, account);
  store.update((db) => {
    const p = db.posts.find((x) => x.id === req.params.id);
    if (!p) return;
    if (r.ok) {
      p.status = 'published';
      p.approved = true;
      p.permalink = r.permalink || null;
      p.publishedAt = new Date().toISOString();
      p.note = null;
      delete p.scheduledAt;
    } else {
      p.status = 'failed';
      p.note = r.error;
    }
    db.logs.unshift({
      at: new Date().toISOString(),
      platform: post.platform,
      account: account ? account.label : null,
      status: r.ok ? 'published' : 'failed',
      product: post.productTitle,
      trigger: 'publish-now',
    });
    db.logs = db.logs.slice(0, 200);
  });

  setFlash(req, r.ok ? 'ok' : 'error',
    r.ok ? `Published to ${PLATFORM_MAP[post.platform].label}.` : 'Could not publish — ' + r.error);
  res.redirect('/content');
});

app.post('/content/:id/approve', (req, res) => {
  store.update((db) => {
    const p = db.posts.find((x) => x.id === req.params.id);
    if (p) { p.approved = true; p.status = 'approved'; }
  });
  setFlash(req, 'ok', 'Draft approved. It will publish once the platform connector is added.');
  res.redirect('/content');
});

// Delete a locally-stored media file referenced by a /media/... URL, so
// deleting posts also frees the disk (no orphaned uploads/generated images).
function deleteLocalMedia(url) {
  if (typeof url !== 'string') return;
  const m = url.match(/^\/media\/(uploads|generated)\/(.+)$/);
  if (!m) return; // external URL (e.g. Shopify CDN) — nothing local to remove
  const dir = m[1] === 'uploads' ? UPLOADS_DIR : GENERATED_DIR;
  const file = path.join(dir, path.basename(m[2]));
  fs.promises.unlink(file).catch(() => {}); // ignore if already gone
}

app.post('/content/:id/delete', (req, res) => {
  const d = store.get();
  const post = d.posts.find((x) => x.id === req.params.id);
  if (post) {
    deleteLocalMedia(post.image);
    deleteLocalMedia(post.video);
  }
  store.update((db) => { db.posts = db.posts.filter((x) => x.id !== req.params.id); });
  res.redirect('/content');
});

// --- Edit a post: text, photo, exact publish date & time ---
app.get('/content/:id/edit', (req, res) => {
  const d = store.get();
  const post = d.posts.find((x) => x.id === req.params.id);
  if (!post) {
    setFlash(req, 'error', 'That post no longer exists.');
    return res.redirect('/content');
  }
  const product = d.products.find((p) => p.id === post.productId) || null;
  const img = (d.settings.brain && d.settings.brain.image) || {};
  const imgProv = IMAGE_PROVIDERS.find((p) => p.key === img.provider);
  res.render('edit', {
    title: 'Edit post',
    active: 'content',
    post,
    product,
    imageOn: !!img.enabled,
    imageLabel: imgProv ? imgProv.label : 'AI',
  });
});

app.post('/content/:id/edit', upload.fields([{ name: 'photo', maxCount: 1 }, { name: 'video', maxCount: 1 }]), async (req, res) => {
  const d = store.get();
  const post = d.posts.find((x) => x.id === req.params.id);
  if (!post) {
    setFlash(req, 'error', 'That post no longer exists.');
    return res.redirect('/content');
  }
  const product = d.products.find((p) => p.id === post.productId) || null;
  const action = req.body.action;

  if (action === 'product-photo' && product) {
    store.update((db) => {
      const p = db.posts.find((x) => x.id === req.params.id);
      if (p) { p.image = product.image; p.imageEngine = 'product-photo'; p.imageNote = null; }
    });
    setFlash(req, 'ok', 'Photo switched to the real product photo.');
    return res.redirect('/content/' + req.params.id + '/edit');
  }

  if (action === 'ai-image' && product) {
    const img = await generateImage(product);
    const made = img.imageEngine === 'gemini' || img.imageEngine === 'openai';
    store.update((db) => {
      const p = db.posts.find((x) => x.id === req.params.id);
      if (p) { p.image = img.url; p.imageEngine = img.imageEngine; p.imageNote = img.imageNote || null; }
    });
    setFlash(req, made ? 'ok' : 'warn',
      made ? 'New AI image generated.' : (img.imageNote || 'Used the real product photo.'));
    return res.redirect('/content/' + req.params.id + '/edit');
  }

  // Default: save text / description / uploaded media / image URL / schedule.
  const files = req.files || {};
  const photo = (files.photo || [])[0];
  const video = (files.video || [])[0];
  store.update((db) => {
    const p = db.posts.find((x) => x.id === req.params.id);
    if (!p) return;
    if (typeof req.body.text === 'string' && req.body.text.trim()) p.text = req.body.text.trim();
    if (typeof req.body.description === 'string') p.description = req.body.description.trim() || null;
    if (photo) { p.image = '/media/uploads/' + photo.filename; p.imageEngine = 'upload'; p.imageNote = null; }
    else if (typeof req.body.image === 'string' && req.body.image.trim()) p.image = req.body.image.trim();
    if (video) p.video = '/media/uploads/' + video.filename;
    if (req.body.removeVideo === 'on') p.video = '';
    const when = (req.body.scheduledAt || '').trim();
    if (when) {
      const dt = new Date(when);
      if (!isNaN(dt.getTime())) {
        p.scheduledAt = dt.toISOString();
        if (p.status !== 'published') p.status = 'scheduled';
      }
    } else {
      delete p.scheduledAt;
      if (p.status === 'scheduled') p.status = 'draft';
    }
    p.editedAt = new Date().toISOString();
  });
  setFlash(req, 'ok', 'Post saved.');
  res.redirect('/content');
});

// Knowledge — one shared section + one section per platform (KNOWLEDGE_PLATFORMS
// is derived from the platform list near the top of this file).

function toLines(v) {
  return (v || '').split('\n').map((s) => s.trim()).filter(Boolean);
}

app.get('/knowledge', (req, res) => {
  const d = store.get();
  res.render('knowledge', {
    title: 'Share Knowledge',
    active: 'knowledge',
    knowledge: d.knowledge,
    platforms: KNOWLEDGE_PLATFORMS,
  });
});

app.post('/knowledge', (req, res) => {
  const b = req.body;
  store.update((db) => {
    db.knowledge.shared = {
      brandVoice: b.shared_brandVoice || '',
      instructions: b.shared_instructions || '',
      dos: b.shared_dos || '',
      donts: b.shared_donts || '',
      examples: toLines(b.shared_examples),
    };
    KNOWLEDGE_PLATFORMS.forEach((p) => {
      db.knowledge.platforms[p.key] = {
        instructions: b[p.key + '_instructions'] || '',
        dos: b[p.key + '_dos'] || '',
        donts: b[p.key + '_donts'] || '',
        examples: toLines(b[p.key + '_examples']),
      };
    });
  });
  setFlash(req, 'ok', 'Knowledge saved — shared rules and all platform sections. New posts will use this guidance.');
  res.redirect('/knowledge');
});

// Master switch — pause / resume the ENTIRE platform's automation.
app.post('/pause', (req, res) => {
  let nowPaused = false;
  store.update((db) => {
    db.settings.paused = !db.settings.paused;
    nowPaused = db.settings.paused;
  });
  setFlash(req, nowPaused ? 'warn' : 'ok', nowPaused
    ? 'Platform PAUSED — no automatic posts will be generated or published until you resume.'
    : 'Platform resumed — automation is running again.');
  res.redirect('/');
});

// Editable posting schedule: days + ANY number of times per day, per platform.
app.post('/settings/schedule', requireSuper, (req, res) => {
  store.update((db) => {
    PLATFORM_KEYS.forEach((k) => {
      let days = req.body[k + '_days'] || [];
      if (!Array.isArray(days)) days = [days];
      let times = req.body[k + '_times'] || [];
      if (!Array.isArray(times)) times = [times];
      times = [...new Set(times.filter((t) => /^\d{2}:\d{2}$/.test(t)))].sort();
      if (!times.length) times = ['09:00'];
      db.settings.schedule[k] = {
        days: [...new Set(days.map(Number).filter((n) => Number.isInteger(n) && n >= 0 && n <= 6))].sort(),
        times,
      };
    });
  });
  setFlash(req, 'ok', 'Posting schedule updated.');
  res.redirect('/settings');
});

// Autopilot mode + content type per platform.
app.post('/toggles', (req, res) => {
  store.update((db) => {
    PLATFORM_KEYS.forEach((k) => {
      db.settings.toggles[k] = req.body[k] === 'auto' ? 'auto' : 'draft';
      const mode = req.body[k + '_mode'];
      if (['product', 'general', 'mix'].includes(mode)) db.settings.contentMode[k] = mode;
    });
  });
  setFlash(req, 'ok', 'Autopilot & content settings updated.');
  res.redirect('/');
});

app.post('/run/:platform', async (req, res) => {
  const r = await scheduler.runSlot(req.params.platform, { manual: true });
  setFlash(req, r.ok ? 'ok' : 'error', r.ok ? 'Ran the job — check Content for the new draft.' : 'Could not run job.');
  res.redirect('/content');
});

/* --------------------------- Settings ------------------------------- */

app.get('/settings', requireSuper, (req, res) => {
  const d = store.get();
  const s = d.settings;
  res.render('settings', {
    title: 'Settings',
    active: 'settings',
    settings: s,
    platformList: PLATFORMS.map((p) => ({ key: p.key, label: p.label, icon: p.icon })),
    accountFields: ACCOUNT_FIELDS,
    // Only masked hints ever reach the view — never plaintext secrets.
    masks: {
      shopify: maskSecret(decrypt(s.shopify.token || '')),
      metaSecret: maskSecret(decrypt(s.connectors.meta.appSecret || '')),
      liSecret: maskSecret(decrypt(s.connectors.linkedin.clientSecret || '')),
      gSecret: maskSecret(decrypt(s.connectors.google.clientSecret || '')),
      // One masked hint per account — never the real token.
      accountTokens: (s.accounts || []).reduce((acc, a) => {
        acc[a.id] = maskSecret(decrypt(a.token || ''));
        return acc;
      }, {}),
      smtpPass: maskSecret(decrypt(s.smtp.pass || '')),
    },
  });
});

// Helper: keep existing encrypted value if the field is left blank.
function keepOrEncrypt(newVal, existing) {
  if (newVal === undefined || newVal === '') return existing || '';
  return encrypt(newVal);
}

app.post('/settings/brand', requireSuper, (req, res) => {
  store.update((db) => {
    Object.assign(db.settings.brand, {
      name: req.body.name || db.settings.brand.name,
      website: req.body.website || db.settings.brand.website,
      city: req.body.city || db.settings.brand.city,
      colorPrimary: req.body.colorPrimary || db.settings.brand.colorPrimary,
      colorAccent: req.body.colorAccent || db.settings.brand.colorAccent,
    });
  });
  setFlash(req, 'ok', 'Brand profile saved.');
  res.redirect('/settings');
});

/* ------------------------------ Brain ------------------------------- */
// The AI "Brain": choose which provider writes, manage each provider's key +
// model, and pick the image generator. Owner-only (handles API keys).

app.get('/brain', requireSuper, (req, res) => {
  const d = store.get();
  const b = d.settings.brain;
  const masks = {};
  TEXT_KEYS.forEach((k) => {
    masks[k] = maskSecret(decrypt((b.providers[k] || {}).apiKey || ''));
  });
  res.render('brain', {
    title: 'Brain',
    active: 'brain',
    brain: b,
    knowledge: d.knowledge,
    textProviders: TEXT_PROVIDERS,
    imageProviders: IMAGE_PROVIDERS,
    masks,
  });
});

app.post('/brain', requireSuper, (req, res) => {
  store.update((db) => {
    const b = db.settings.brain;
    TEXT_PROVIDERS.forEach((prov) => {
      const p = b.providers[prov.key] || (b.providers[prov.key] = { apiKey: '', model: prov.models[0], enabled: false });
      p.apiKey = keepOrEncrypt(req.body[prov.key + '_key'], p.apiKey);
      if (prov.models.includes(req.body[prov.key + '_model'])) p.model = req.body[prov.key + '_model'];
      p.enabled = req.body[prov.key + '_enabled'] === 'on';
    });
    // Which provider actually writes.
    if (TEXT_KEYS.includes(req.body.active)) b.active = req.body.active;
    // Image generator.
    b.image.provider = req.body.image_provider === 'openai' ? 'openai' : 'gemini';
    b.image.enabled = req.body.image_enabled === 'on';
  });
  setFlash(req, 'ok', 'Brain saved. Keys are encrypted and never shown again.');
  res.redirect('/brain');
});

// Public address of this app once deployed — Instagram and Google Business
// need a publicly reachable image URL before they can publish uploaded photos.
app.post('/settings/site', requireSuper, (req, res) => {
  store.update((db) => {
    db.settings.publicUrl = (req.body.publicUrl || '').trim().replace(/\/+$/, '');
  });
  setFlash(req, 'ok', 'Public site address saved.');
  res.redirect('/settings');
});

app.post('/settings/shopify', requireSuper, (req, res) => {
  store.update((db) => {
    db.settings.shopify.domain = req.body.domain || db.settings.shopify.domain;
    db.settings.shopify.token = keepOrEncrypt(req.body.token, db.settings.shopify.token);
  });
  setFlash(req, 'ok', 'Shopify connection saved.');
  res.redirect('/settings');
});

app.post('/settings/connector/:platform', requireSuper, (req, res) => {
  const p = req.params.platform;
  store.update((db) => {
    const c = db.settings.connectors;
    if (p === 'meta') {
      // App-level credentials only; the posting targets live in settings.accounts.
      c.meta.appId = req.body.appId || c.meta.appId;
      c.meta.appSecret = keepOrEncrypt(req.body.appSecret, c.meta.appSecret);
    } else if (p === 'linkedin') {
      c.linkedin.clientId = req.body.clientId || c.linkedin.clientId;
      c.linkedin.clientSecret = keepOrEncrypt(req.body.clientSecret, c.linkedin.clientSecret);
    } else if (p === 'google') {
      c.google.clientId = req.body.clientId || c.google.clientId;
      c.google.clientSecret = keepOrEncrypt(req.body.clientSecret, c.google.clientSecret);
    }
  });
  setFlash(req, 'ok', `${p} app credentials saved.`);
  res.redirect('/settings');
});

/* ---- Accounts: any number, on any platform (add, edit, remove) ---- */
// The ID fields each platform needs come from ACCOUNT_FIELDS (derived from the
// platform list near the top of this file). Anything not listed is ignored.

function readAccountFields(platform, body, target) {
  (ACCOUNT_FIELDS[platform] || []).forEach((f) => {
    target[f.name] = (body[f.name] || '').trim();
  });
}

app.post('/settings/account/add', requireSuper, (req, res) => {
  const platform = req.body.platform;
  const label = (req.body.label || '').trim();
  if (!PLATFORM_META[platform]) {
    setFlash(req, 'error', 'Pick a platform for the account.');
    return res.redirect('/settings');
  }
  if (!label) {
    setFlash(req, 'error', 'Give the account a name so you can tell them apart.');
    return res.redirect('/settings');
  }
  store.update((db) => {
    const acct = {
      id: 'acct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      platform,
      label,
      enabled: req.body.enabled === 'on',
      token: req.body.token ? encrypt(req.body.token) : '',
      note: (req.body.note || '').trim(),
    };
    readAccountFields(platform, req.body, acct);
    db.settings.accounts.push(acct);
  });
  setFlash(req, 'ok', `${PLATFORM_META[platform].label} account "${label}" added.`);
  res.redirect('/settings');
});

app.post('/settings/account/:id', requireSuper, (req, res) => {
  let found = false;
  store.update((db) => {
    const a = db.settings.accounts.find((x) => x.id === req.params.id);
    if (!a) return;
    found = true;
    a.label = (req.body.label || a.label).trim();
    a.enabled = req.body.enabled === 'on';
    a.token = keepOrEncrypt(req.body.token, a.token);
    a.note = (req.body.note || '').trim();
    readAccountFields(a.platform, req.body, a); // platform itself never changes
  });
  setFlash(req, found ? 'ok' : 'error', found ? 'Account updated.' : 'That account no longer exists.');
  res.redirect('/settings');
});

app.post('/settings/account/:id/delete', requireSuper, (req, res) => {
  store.update((db) => {
    db.settings.accounts = db.settings.accounts.filter((x) => x.id !== req.params.id);
  });
  setFlash(req, 'ok', 'Account removed.');
  res.redirect('/settings');
});

app.post('/settings/smtp', requireSuper, (req, res) => {
  store.update((db) => {
    db.settings.smtp.host = req.body.host || '';
    db.settings.smtp.port = req.body.port || 587;
    db.settings.smtp.user = req.body.user || '';
    db.settings.smtp.from = req.body.from || '';
    db.settings.smtp.pass = keepOrEncrypt(req.body.pass, db.settings.smtp.pass);
    db.settings.recoveryEmail = req.body.recoveryEmail || db.settings.recoveryEmail;
  });
  setFlash(req, 'ok', 'Email & recovery settings saved.');
  res.redirect('/settings');
});

/* ---------------------- My Account (every user) --------------------- */

app.get('/account', (req, res) => {
  res.render('account', { title: 'My Account', active: 'account' });
});

// A user changes THEIR OWN username / password.
app.post('/account', (req, res) => {
  const { currentPassword, newPassword, newUsername } = req.body;
  const me = store.findUserById(req.session.user.id);
  if (!me || !verifyPassword(currentPassword, me.passHash)) {
    setFlash(req, 'error', 'Current password is incorrect.');
    return res.redirect('/account');
  }
  if (!newPassword || newPassword.length < 8) {
    setFlash(req, 'error', 'New password must be at least 8 characters.');
    return res.redirect('/account');
  }
  const wanted = (newUsername || '').trim();
  if (wanted && wanted !== me.username) {
    const clash = store.findUserByUsername(wanted);
    if (clash && clash.id !== me.id) {
      setFlash(req, 'error', 'That username is already taken.');
      return res.redirect('/account');
    }
  }
  store.update((db) => {
    const u = db.users.find((x) => x.id === me.id);
    if (wanted) u.username = wanted;
    u.passHash = hashPassword(newPassword);
    u.mustChangePassword = false;
    u.updatedAt = new Date().toISOString();
  });
  req.session.user.username = wanted || me.username;
  setFlash(req, 'ok', 'Your account is updated.');
  res.redirect('/account');
});

/* ------------------- Team (super admin only) ------------------------ */

app.get('/team', requireSuper, (req, res) => {
  const d = store.get();
  res.render('team', {
    title: 'Team',
    active: 'team',
    users: d.users.map((u) => ({
      id: u.id, username: u.username, role: u.role,
      mustChangePassword: !!u.mustChangePassword,
      createdAt: u.createdAt, updatedAt: u.updatedAt,
      isSelf: u.id === req.session.user.id,
    })),
  });
});

// Create a new team login.
app.post('/team/add', requireSuper, (req, res) => {
  const username = (req.body.username || '').trim();
  const password = req.body.password || '';
  const role = req.body.role === 'super' ? 'super' : 'member';
  if (!username) {
    setFlash(req, 'error', 'Give the new member a username.');
    return res.redirect('/team');
  }
  if (password.length < 8) {
    setFlash(req, 'error', 'Password must be at least 8 characters.');
    return res.redirect('/team');
  }
  if (store.findUserByUsername(username)) {
    setFlash(req, 'error', `Username "${username}" is already taken.`);
    return res.redirect('/team');
  }
  store.update((db) => {
    const now = new Date().toISOString();
    db.users.push({
      id: store.makeId('user'),
      username,
      passHash: hashPassword(password),
      role,
      mustChangePassword: true,
      createdAt: now,
      updatedAt: now,
    });
  });
  setFlash(req, 'ok', `Team login "${username}" created${role === 'super' ? ' (super admin)' : ''}. Share the username and password with them.`);
  res.redirect('/team');
});

// Reset a member's password to a new value.
app.post('/team/:id/reset', requireSuper, (req, res) => {
  const password = req.body.password || '';
  if (password.length < 8) {
    setFlash(req, 'error', 'Password must be at least 8 characters.');
    return res.redirect('/team');
  }
  let name = '';
  store.update((db) => {
    const u = db.users.find((x) => x.id === req.params.id);
    if (u) {
      u.passHash = hashPassword(password);
      u.mustChangePassword = true;
      u.updatedAt = new Date().toISOString();
      name = u.username;
    }
  });
  setFlash(req, name ? 'ok' : 'error', name ? `Password reset for "${name}".` : 'That user no longer exists.');
  res.redirect('/team');
});

// Remove a team login. Guards: can't remove yourself or the last super admin.
app.post('/team/:id/delete', requireSuper, (req, res) => {
  const d = store.get();
  const target = d.users.find((x) => x.id === req.params.id);
  if (!target) {
    setFlash(req, 'error', 'That user no longer exists.');
    return res.redirect('/team');
  }
  if (target.id === req.session.user.id) {
    setFlash(req, 'error', 'You cannot remove your own account.');
    return res.redirect('/team');
  }
  if (target.role === 'super' && d.users.filter((u) => u.role === 'super').length <= 1) {
    setFlash(req, 'error', 'This is the only super admin — promote another member to super first.');
    return res.redirect('/team');
  }
  store.update((db) => {
    db.users = db.users.filter((x) => x.id !== req.params.id);
  });
  setFlash(req, 'ok', `Team login "${target.username}" removed.`);
  res.redirect('/team');
});

/* ----------------------------- Errors ------------------------------- */

app.use((req, res) => {
  res.status(404).render('error', { title: 'Not found', message: 'That page does not exist.' });
});

app.use((err, req, res, next) => {
  // Friendly message for oversized/invalid uploads instead of a bare 500.
  if (err instanceof multer.MulterError) {
    setFlash(req, 'error',
      err.code === 'LIMIT_FILE_SIZE'
        ? 'That file is too large (max 80 MB). Try a smaller image or video.'
        : 'Could not accept that upload. Please try again.');
    return res.redirect('/content');
  }
  console.error('[error]', err.message);
  res.status(500).render('error', { title: 'Something went wrong', message: 'An unexpected error occurred.' });
});

scheduler.start();

app.listen(config.port, () => {
  const owner = store.get().users.find((u) => u.role === 'super');
  console.log('');
  console.log('  F-Tech Automation Posts is running');
  console.log('  →  http://localhost:' + config.port);
  if (owner && owner.mustChangePassword) {
    console.log('  First-time login:  ' + config.defaultAdminUser + '  /  ' + config.defaultAdminPass);
    console.log('  (change it in My Account right after signing in)');
  } else if (owner) {
    console.log('  Owner login:  ' + owner.username + '  (password already set — use My Account to change it)');
  }
  console.log('');
});
