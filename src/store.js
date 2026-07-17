'use strict';

/**
 * Tiny JSON-file data store. One db.json holds everything.
 * The repository shape is intentionally simple so it can later be swapped for
 * Supabase/Postgres without touching the rest of the app.
 *
 * SECURITY: secret fields (api keys, tokens, smtp pass) are stored ENCRYPTED
 * via src/crypto.js before they ever reach this file. This layer never sees
 * plaintext secrets on disk.
 */

const fs = require('fs');
const path = require('path');
const config = require('./config');
const { hashPassword } = require('./crypto');
const { PLATFORM_KEYS } = require('./platforms');

const DB_FILE = path.join(config.dataDir, 'db.json');

// Short unique id helper (used for users, accounts, etc.).
function makeId(prefix) {
  return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
}

function seededProducts() {
  // Real live products pulled from the connected Shopify store (ftechdeals.com).
  // Used so the content preview works locally before the Shopify token is added.
  return [
    {
      id: '9185919795451',
      title: 'Lenovo ThinkPad E14 — Intel Core i5 11th Gen | 16GB RAM | 512GB SSD | 14” FHD IPS',
      shortTitle: 'Lenovo ThinkPad E14 (i5 11th Gen, 16GB, 512GB SSD)',
      type: 'Laptop',
      vendor: 'Lenovo',
      price: 31995,
      image: 'https://cdn.shopify.com/s/files/1/0779/5176/2683/files/116.png?v=1764764279',
      tags: ['16GB', '512GB', 'i5-11th Gen', 'business laptop'],
      url: 'https://ftechdeals.com/products/lenovo-thinkpad-e14-i5-11th-gen-16gb-512gb-ssd-14-inch-fhd-refurbished',
    },
    {
      id: '9265987977467',
      title: 'Dell Tiny Desktop PC — Intel Core i5 10th Gen | 8GB RAM | 256GB SSD | Windows 10',
      shortTitle: 'Dell Tiny Desktop (i5 10th Gen, 8GB, 256GB SSD)',
      type: 'Mini PC',
      vendor: 'Dell',
      price: 34995,
      image: 'https://cdn.shopify.com/s/files/1/0779/5176/2683/files/dell3_536f65cf-baf1-4aaa-949e-653fea93793a.jpg?v=1774013009',
      tags: ['256GB', '8GB', 'mini pc', 'desktop'],
      url: 'https://ftechdeals.com/products/dell-tiny-desktop-i5-10th-gen-8gb-256gb-ssd-window-10-ms-office',
    },
    {
      id: '9279208227067',
      title: 'Dell Tiny Desktop PC — Intel Core i5 6th Gen | 8GB RAM | 512GB SSD | Windows 10',
      shortTitle: 'Dell Tiny Desktop (i5 6th Gen, 8GB, 512GB SSD)',
      type: 'Mini PC',
      vendor: 'Dell',
      price: 22995,
      image: 'https://cdn.shopify.com/s/files/1/0779/5176/2683/files/dell3_280170af-3081-44ed-a20d-8b41a2626345.jpg?v=1774012922',
      tags: ['512GB', '8GB', 'mini pc', 'desktop'],
      url: 'https://ftechdeals.com/products/dell-tiny-desktop-pc-intel-core-i5-6th-gen-8gb-ram-512gb-ssd',
    },
  ];
}

function emptyPlatformKnowledge() {
  return { instructions: '', dos: '', donts: '', examples: [] };
}

function defaultDb() {
  const now = new Date().toISOString();
  return {
    // Multiple logins. The first user is the SUPER admin (the owner): only a
    // super admin can manage API keys/secrets and create other team members.
    users: [
      {
        id: makeId('user'),
        username: config.defaultAdminUser,
        passHash: hashPassword(config.defaultAdminPass),
        role: 'super',
        mustChangePassword: true,
        createdAt: now,
        updatedAt: now,
      },
    ],
    settings: {
      // --- Brand profile (prefilled from the blueprint; editable) ---
      brand: {
        name: 'F-Tech Computers',
        website: 'ftechdeals.com',
        city: 'India',
        currency: 'INR',
        colorPrimary: '#0b6bcb',
        colorAccent: '#f5a623',
      },
      // --- AI ---
      claudeApiKey: '',      // encrypted when set
      claudeModel: 'claude-sonnet-5',
      claudeEnabled: true,   // ON/OFF switch — OFF = free template writer
      gemini: { apiKey: '', enabled: false }, // image generation; OFF = real product photo
      // --- Master switch: pause ALL automation ---
      paused: false,
      // --- Product source ---
      shopify: { domain: 'ftechdeals.com', token: '' }, // token encrypted when set
      // --- Developer APP credentials only (one app drives many accounts) ---
      connectors: {
        meta:     { appId: '', appSecret: '' },   // covers Facebook + Instagram
        linkedin: { clientId: '', clientSecret: '' },
        google:   { clientId: '', clientSecret: '' },
      },
      // --- Accounts: ANY number, on ANY platform ---
      // Each entry = one posting target: { id, platform, label, enabled, token, note, ...ids }
      // platform: 'fb' | 'ig' | 'linkedin' | 'gmb'
      accounts: [],
      // --- Autopilot vs Draft, per platform ---
      toggles: { gmb: 'draft', linkedin: 'draft', ig: 'draft', fb: 'draft', blog: 'draft' },
      // --- Content type per platform: 'product' | 'general' | 'mix' ---
      // product = promote a product · general = helpful non-product content
      // (e.g. LinkedIn) · mix = automation alternates between the two.
      contentMode: { gmb: 'product', linkedin: 'general', ig: 'product', fb: 'product', blog: 'mix' },
      // --- Posting schedule: days 0=Sun..6=Sat + MANY times per day (HH:MM) ---
      // e.g. 2 posts/week  = days:[1,4], times:['10:00']
      //      2 posts/day   = days:[0..6], times:['10:00','18:00']
      schedule: {
        gmb:      { days: [1],    times: ['09:00'] },
        linkedin: { days: [1],    times: ['09:00'] },
        ig:       { days: [1, 4], times: ['10:00'] },
        fb:       { days: [1, 4], times: ['10:00'] },
        blog:     { days: [1],    times: ['11:00'] },
      },
      // --- Email / recovery ---
      smtp: { host: '', port: 587, user: '', pass: '', from: '' }, // pass encrypted
      recoveryEmail: config.defaultRecoveryEmail,
    },
    knowledge: {
      // Applies to EVERY platform.
      shared: {
        brandVoice:
          'Friendly, trustworthy and value-focused. We sell reliable, affordable refurbished and new laptops, mini PCs and computer accessories. Speak simply, highlight specs and price, and always invite the customer to visit ftechdeals.com or the shop.',
        instructions:
          'Write unique, human-sounding posts. Vary sentence length. Avoid AI cliches like "unlock", "elevate", "in today\'s fast-paced world". Always include the real product name, key specs and the price in INR (₹). Add a clear call to action.',
        dos: 'Mention exact specs and price. Use ₹. Add a call to action. Keep it specific to the product.',
        donts: 'No fake claims. No spammy hashtags. No generic filler. Do not overuse emojis on LinkedIn.',
        examples: [],
      },
      // Extra rules layered on top of "shared" for one platform only.
      platforms: {
        gmb:      emptyPlatformKnowledge(),
        linkedin: emptyPlatformKnowledge(),
        ig:       emptyPlatformKnowledge(),
        fb:       emptyPlatformKnowledge(),
        blog:     emptyPlatformKnowledge(),
      },
    },
    products: seededProducts(),
    posts: [],   // generated drafts / published items
    logs: [],    // schedule + publish log
    lastRuns: {}, // per-platform "already fired this slot" marker
  };
}

/**
 * Fill in any fields added after the db.json was first created, so existing
 * databases keep working across upgrades (simple forward migration).
 */
function normalize(d) {
  const s = d.settings || (d.settings = {});
  if (s.claudeEnabled === undefined) s.claudeEnabled = true;
  if (!s.gemini) s.gemini = { apiKey: '', enabled: false };
  if (s.paused === undefined) s.paused = false;

  /* ---- Users: single `user` -> `users` array with roles ---- */
  if (!Array.isArray(d.users)) d.users = [];
  if (!d.users.length && d.user && d.user.passHash) {
    d.users.push({
      id: makeId('user'),
      username: d.user.username,
      passHash: d.user.passHash,
      role: 'super', // the original single account is the owner/super admin
      mustChangePassword: !!d.user.mustChangePassword,
      createdAt: d.user.updatedAt || new Date().toISOString(),
      updatedAt: d.user.updatedAt || new Date().toISOString(),
    });
  }
  // Backfill fields on any pre-existing users; guarantee at least one super.
  d.users.forEach((u) => {
    if (!u.id) u.id = makeId('user');
    if (u.role !== 'super' && u.role !== 'member') u.role = 'member';
    if (u.mustChangePassword === undefined) u.mustChangePassword = false;
    if (!u.createdAt) u.createdAt = new Date().toISOString();
  });
  if (d.users.length && !d.users.some((u) => u.role === 'super')) d.users[0].role = 'super';
  delete d.user; // superseded by users[]

  // --- Schedule: single `time` -> list of `times` ---
  const defSched = {
    gmb:      { days: [1],    times: ['09:00'] },
    linkedin: { days: [1],    times: ['09:00'] },
    ig:       { days: [1, 4], times: ['10:00'] },
    fb:       { days: [1, 4], times: ['10:00'] },
    blog:     { days: [1],    times: ['11:00'] },
  };
  if (!s.schedule || typeof s.schedule.gmb === 'string') {
    s.schedule = JSON.parse(JSON.stringify(defSched));
  } else {
    PLATFORM_KEYS.forEach((k) => {
      const sc = s.schedule[k] || JSON.parse(JSON.stringify(defSched[k]));
      if (!Array.isArray(sc.times)) sc.times = sc.time ? [sc.time] : defSched[k].times.slice();
      delete sc.time;
      if (!Array.isArray(sc.days)) sc.days = defSched[k].days.slice();
      s.schedule[k] = sc;
    });
  }

  // --- Autopilot toggles + content mode: ensure an entry for every platform ---
  if (!s.toggles || typeof s.toggles !== 'object') s.toggles = {};
  const defMode = { gmb: 'product', linkedin: 'general', ig: 'product', fb: 'product', blog: 'mix' };
  if (!s.contentMode || typeof s.contentMode !== 'object') s.contentMode = {};
  PLATFORM_KEYS.forEach((k) => {
    if (s.toggles[k] !== 'auto' && s.toggles[k] !== 'draft') s.toggles[k] = 'draft';
    if (!['product', 'general', 'mix'].includes(s.contentMode[k])) s.contentMode[k] = defMode[k] || 'product';
  });

  if (!d.lastRuns) d.lastRuns = {};

  /* ---- Accounts: every old connector shape -> one generic accounts list ---- */
  if (!Array.isArray(s.accounts)) s.accounts = [];
  if (!s.connectors) s.connectors = {};
  const meta = s.connectors.meta || (s.connectors.meta = {});
  const li = s.connectors.linkedin || (s.connectors.linkedin = {});
  const gg = s.connectors.google || (s.connectors.google = {});

  // Oldest shape: a single Meta connector carrying pageId/igId/token.
  if (meta.pageId || meta.igId || meta.token) {
    if (!Array.isArray(s.metaAccounts)) s.metaAccounts = [];
    if (!s.metaAccounts.length) {
      s.metaAccounts.push({
        id: 'meta_' + Date.now(),
        label: 'Main account',
        pageId: meta.pageId || '',
        igId: meta.igId || '',
        token: meta.token || '',
        fbEnabled: true,
        igEnabled: true,
      });
    }
    delete meta.pageId; delete meta.igId; delete meta.token; delete meta.connected;
  }

  // Middle shape: metaAccounts[] -> one generic account per platform target.
  if (Array.isArray(s.metaAccounts)) {
    s.metaAccounts.forEach((a) => {
      if (a.fbEnabled || a.pageId) {
        s.accounts.push({
          id: a.id + '_fb', platform: 'fb', label: a.label || 'Facebook',
          enabled: a.fbEnabled !== false, token: a.token || '', note: a.note || '',
          pageId: a.pageId || '',
        });
      }
      if (a.igEnabled || a.igId) {
        s.accounts.push({
          id: a.id + '_ig', platform: 'ig', label: a.label || 'Instagram',
          enabled: a.igEnabled !== false, token: a.token || '', note: a.note || '',
          igId: a.igId || '',
        });
      }
    });
    delete s.metaAccounts;
  }

  // Single LinkedIn / Google connectors -> accounts.
  if (li.orgUrn || li.token) {
    s.accounts.push({
      id: 'li_' + Date.now(), platform: 'linkedin', label: 'LinkedIn Page',
      enabled: true, token: li.token || '', note: '', orgUrn: li.orgUrn || '',
    });
    delete li.orgUrn; delete li.token; delete li.connected;
  }
  if (gg.accountId || gg.locationId || gg.token) {
    s.accounts.push({
      id: 'gm_' + Date.now(), platform: 'gmb', label: 'Google Business',
      enabled: true, token: gg.token || '', note: '',
      accountId: gg.accountId || '', locationId: gg.locationId || '',
    });
    delete gg.accountId; delete gg.locationId; delete gg.token; delete gg.connected;
  }

  // App-level credential fields must always exist.
  if (meta.appId === undefined) meta.appId = '';
  if (meta.appSecret === undefined) meta.appSecret = '';
  if (li.clientId === undefined) li.clientId = '';
  if (li.clientSecret === undefined) li.clientSecret = '';
  if (gg.clientId === undefined) gg.clientId = '';
  if (gg.clientSecret === undefined) gg.clientSecret = '';

  // --- Knowledge: flat -> { shared, platforms } ---
  const k = d.knowledge || (d.knowledge = {});
  if (!k.shared) {
    k.shared = {
      brandVoice: k.brandVoice || '',
      instructions: k.instructions || '',
      dos: k.dos || '',
      donts: k.donts || '',
      examples: Array.isArray(k.examples) ? k.examples : [],
    };
    delete k.brandVoice;
    delete k.instructions;
    delete k.dos;
    delete k.donts;
    delete k.examples;
  }
  if (!k.platforms) k.platforms = {};
  PLATFORM_KEYS.forEach((p) => {
    if (!k.platforms[p]) k.platforms[p] = emptyPlatformKnowledge();
    if (!Array.isArray(k.platforms[p].examples)) k.platforms[p].examples = [];
  });

  return d;
}

let db = null;

function load() {
  if (!fs.existsSync(DB_FILE)) {
    db = defaultDb();
    save();
    return db;
  }
  try {
    db = normalize(JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
    save();
  } catch (_) {
    db = defaultDb();
    save();
  }
  return db;
}

function save() {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

function get() {
  if (!db) load();
  return db;
}

function update(mutator) {
  const d = get();
  mutator(d);
  save();
  return d;
}

/* ------------------------------ Users -------------------------------- */

function findUserByUsername(username) {
  const uname = String(username || '').trim();
  return get().users.find((u) => u.username === uname) || null;
}

function findUserById(id) {
  return get().users.find((u) => u.id === id) || null;
}

module.exports = {
  load, save, get, update, DB_FILE, normalize, defaultDb, makeId,
  findUserByUsername, findUserById,
};
