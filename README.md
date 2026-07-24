# AutoPost — runnable build

A working, self-contained implementation of the [master plan](../PLAN.md): a multi-platform,
AI-driven content-automation tool (dashboard · composer · brain · connectors · scheduler ·
autopilot · SEO · history · storage). Runs on **Node only** — no Postgres, Redis, or Docker required.

```
npm install      # installs deps and generates crypto secrets into .env
npm run build    # builds the React frontend into server/public
npm start        # serves the app + API at http://localhost:3001
```

Then open **http://localhost:3001**.

**First login:** username `admin`, password `golu9588` (from `.env`). You are **forced to change it**
on first login before anything else unlocks (doc 08). Pick a strong one.

## Production-clean — starts empty, real paths everywhere

There is **no demo data**. On first boot you get only: the super admin, the AI provider catalogue
(no keys), a default routing profile, a default brand voice, and two empty knowledge templates.

Getting started (the Dashboard shows this as a checklist):

1. **Add an AI provider key** — Brain → Providers. Content is written by a live model; generation is
   **blocked until a real key exists** (no fake content).
2. **Connect a platform:**
   - **Shopify** — Shopify screen → Connect store → paste your `shpat_…` Admin API token. Real
     validation + catalogue/blog sync + real `articleCreate` publishing.
   - **Custom webhook** — really POSTs your rendered post (Slack/Discord/Zapier/n8n).
   - **Instagram / Facebook / LinkedIn / Google Business** — real OAuth. Set the app credentials in
     `.env` (below), then Connections → Add → Connect. **Requires your own approved developer app** —
     publishing scopes need each platform's App Review (weeks). Until your app is ready, create a
     **sandbox** connection to exercise the full pipeline (publishing is simulated, clearly labelled).
3. **Write your brain instructions** — Knowledge.
4. **Generate** — Composer.

### OAuth env (for real social publishing)

Set these in `app/.env` and restart, and register the redirect URI shown in the connect dialog:

```
META_APP_ID=        META_APP_SECRET=          # Facebook + Instagram
LINKEDIN_CLIENT_ID= LINKEDIN_CLIENT_SECRET=   # LinkedIn
GOOGLE_CLIENT_ID=   GOOGLE_CLIENT_SECRET=      # Google Business Profile
```

Redirect URI: `http://localhost:3001/api/v1/connections/oauth/<PLATFORM>/callback`

> The social OAuth + publish code is implemented to each provider's documented API but **cannot be
> exercised without a live, approved app**, so treat those paths as unverified until you connect one.

### Always real (no external dependency)

17-check **SEO scorer** · **humanizer** (banned-phrase + burstiness) · **AES-256-GCM** secret
encryption · **RBAC + per-connection ACL** · forced password change · audit log · **9-role Brain
router** (fallback + cost ledger + budget) · **8-stage pipeline** · **scheduler/autopilot** (quiet
hours, caps, circuit breaker, idempotency lock) · **storage quota + purge**.

## Layout

```
server/            Node/Express API + all domain logic (maps to the plan's api + worker + packages)
  routes/          REST surface (/api/v1, doc 06)
  brain/           provider adapters + role router + seed model catalogue
  connectors/      per-platform publish contract
  seo.js           the 17-check scorer   humanizer.js   scheduler.js   storage.js   pipeline.js
  data/db.json     the store (stands in for Postgres/Prisma — schema mirrors doc 02)
web/               Vite + React "control-room" UI (design tokens from doc 07)
```

## Scripts

- `node server/scripts/smoke.mjs` — end-to-end API scan (32 checks).
- `node server/scripts/autopilot-test.mjs` — drives the real autopilot generate→publish cycle.
- `SCHED_DEBUG=1 npm start` — logs why the scheduler generates/skips each connection.

## Known limitations (v1)

- Scheduling uses the **server's** local clock; run the server in the tenant's timezone (set `TZ`).
  Full per-tenant DST-correct scheduling is a v2 item.
- Data is a JSON file (single-node). The access layer mirrors the Prisma schema so a Postgres swap is
  contained to `server/store.js`.
