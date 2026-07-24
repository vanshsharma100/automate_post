// JSON-backed data store. Stands in for PostgreSQL + Prisma (doc 02). Every
// collection mirrors a Prisma model; every domain row carries `tenantId`, so
// the same tenant-scoping discipline applies. Swapping this for Prisma/Postgres
// later means reimplementing this module's surface, nothing else.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { cuid } from './crypto.js';
import { config } from './config.js';

const DB_PATH = resolve(config.dataDir, 'db.json');

const COLLECTIONS = [
  'tenants', 'users', 'userPlatformAccess', 'userSessions', 'auditLogs',
  'aiProviders', 'aiModels', 'brainProfiles', 'brainRoleBindings', 'usageLedger',
  'knowledgeBases', 'brandVoices',
  'connections', 'platformSchedules', 'platformQuotas', 'platformApps',
  'shopifyStores', 'shopifyProducts', 'shopifyCollections', 'shopifyBlogs',
  'contentIdeas', 'postGroups', 'posts', 'postRevisions', 'mediaAssets',
  'automationRuns', 'publishAttempts', 'notifications', 'tenantSettings',
];

function emptyDb() {
  const db = { _meta: { version: 1, createdAt: new Date().toISOString() } };
  for (const c of COLLECTIONS) db[c] = [];
  return db;
}

let db = emptyDb();
let writeTimer = null;
let dirty = false;

function load() {
  try {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    if (existsSync(DB_PATH)) {
      const parsed = JSON.parse(readFileSync(DB_PATH, 'utf8'));
      db = { ...emptyDb(), ...parsed };
      for (const c of COLLECTIONS) if (!Array.isArray(db[c])) db[c] = [];
    } else {
      db = emptyDb();
      flushSync();
    }
  } catch (e) {
    console.error('[store] failed to load db.json, starting fresh:', e.message);
    db = emptyDb();
  }
}

function flushSync() {
  try {
    if (!existsSync(config.dataDir)) mkdirSync(config.dataDir, { recursive: true });
    const tmp = `${DB_PATH}.tmp`;
    writeFileSync(tmp, JSON.stringify(db, null, 2));
    renameSync(tmp, DB_PATH);
    dirty = false;
  } catch (e) {
    console.error('[store] persist failed:', e.message);
  }
}

function schedulePersist() {
  dirty = true;
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    if (dirty) flushSync();
  }, 120);
}

// Clone on the way out so callers can't mutate store state by reference.
function clone(v) {
  return v == null ? v : JSON.parse(JSON.stringify(v));
}

export const store = {
  raw: () => db,

  all(collection) {
    return clone(db[collection] || []);
  },

  find(collection, predicate) {
    const rows = db[collection] || [];
    return clone(rows.filter(predicate));
  },

  findOne(collection, predicate) {
    const rows = db[collection] || [];
    const row = rows.find(predicate);
    return clone(row || null);
  },

  get(collection, id) {
    const rows = db[collection] || [];
    return clone(rows.find((r) => r.id === id) || null);
  },

  count(collection, predicate) {
    const rows = db[collection] || [];
    return predicate ? rows.filter(predicate).length : rows.length;
  },

  insert(collection, doc) {
    if (!db[collection]) db[collection] = [];
    const now = new Date().toISOString();
    const row = {
      id: doc.id || cuid(collection.slice(0, 3)),
      createdAt: doc.createdAt || now,
      ...doc,
    };
    db[collection].push(row);
    schedulePersist();
    return clone(row);
  },

  update(collection, id, patch) {
    const rows = db[collection] || [];
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return null;
    rows[idx] = { ...rows[idx], ...patch, updatedAt: new Date().toISOString() };
    schedulePersist();
    return clone(rows[idx]);
  },

  // Update every row matching predicate; returns count updated.
  updateWhere(collection, predicate, patch) {
    const rows = db[collection] || [];
    let n = 0;
    for (let i = 0; i < rows.length; i++) {
      if (predicate(rows[i])) {
        rows[i] = { ...rows[i], ...patch, updatedAt: new Date().toISOString() };
        n++;
      }
    }
    if (n) schedulePersist();
    return n;
  },

  remove(collection, id) {
    const rows = db[collection] || [];
    const idx = rows.findIndex((r) => r.id === id);
    if (idx === -1) return false;
    rows.splice(idx, 1);
    schedulePersist();
    return true;
  },

  removeWhere(collection, predicate) {
    const rows = db[collection] || [];
    let n = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      if (predicate(rows[i])) {
        rows.splice(i, 1);
        n++;
      }
    }
    if (n) schedulePersist();
    return n;
  },

  persistNow: flushSync,
};

load();

// Never lose the last few writes on shutdown.
for (const sig of ['SIGINT', 'SIGTERM', 'exit']) {
  process.on(sig, () => {
    if (dirty) flushSync();
    if (sig !== 'exit') process.exit(0);
  });
}
