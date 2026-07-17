# F-Tech Automation Posts

A private dashboard that writes — and, once connectors are added, auto-publishes — SEO-friendly,
human-sounding content for **F-Tech Computers (ftechdeals.com)** across
**Google Business, LinkedIn, Instagram, Facebook** and the **Shopify Blog**,
with a per-platform **Autopilot / Draft** switch.

> Built to run with **no human needed** (Autopilot), while keeping a one-click **off switch**
> (Draft mode) for manual approval, plus a master **Pause everything** button.

---

## Run it locally

```bash
npm install
npm start
```

Open **http://localhost:3000**.

On a brand-new install the first login is `admin` / `ChangeMe@123` — change it immediately in
**My Account**. (On an existing install, use your own owner login.)

---

## What's inside

| Page | What it does |
|------|--------------|
| **Dashboard** | Master pause, per-platform Autopilot/Draft switch, content type (Product/General/Mix), connection status, schedule summary, latest drafts, activity log |
| **Content & Drafts** | Generate a post for any platform. Choose **Product** (promote an item) or **General** (helpful, non-promotional). Optionally schedule it for an exact date & time. Filter drafts per platform |
| **Share Knowledge** | Brand voice + rules + examples. One **Shared** section (all platforms) plus a **separate section per platform** that layers on top |
| **Products** | Products that feed the content brain (Shopify) |
| **My Account** | Every user changes their own username/password here |
| **Settings** | *Owner only.* Claude + Gemini keys, Shopify, Meta/LinkedIn/Google connectors, posting schedule, accounts/tokens, SMTP + recovery email, brand |
| **Team** | *Owner only.* Create/reset/remove logins for staff |

### Platforms

Defined in one place — **`src/platforms.js`**. To add another platform, edit that file only;
the server, store, scheduler, content brain and views all read from it.

| Key | Platform | Notes |
|-----|----------|-------|
| `gmb` | Google Business | needs GBP account + location id |
| `linkedin` | LinkedIn | needs organization URN |
| `ig` | Instagram | needs IG business id |
| `fb` | Facebook | needs page id |
| `blog` | Shopify Blog | long-form articles; publishes via the **Shopify store connection**, so the target only needs a **Blog ID** (no separate token) |

### Content types

Each platform has a **content mode** (Dashboard → Content column):

- **Product** — promotes a specific product with specs, price (₹) and link.
- **General** — no product push; the AI writes useful content for the field (tips, buying guides, how-tos). Good for LinkedIn.
- **Mix** — automation alternates between the two.

You can also pick the type per post in the generator.

### Roles

- **★ Owner (super admin)** — full access, including API keys, connectors and Team.
- **Team member** — can write, schedule and approve content and edit Knowledge, but **cannot**
  open Settings or Team, and never sees API keys or tokens.

---

## Security — how your keys stay private

- **All secrets** (Claude/Gemini keys, platform tokens, SMTP password) are encrypted with
  **AES-256-GCM** before storage. A copy of the database reveals only ciphertext.
- The **master key + session secret are server-only** (env vars in production, or a git-ignored
  `data/.secrets.json` locally) — never in the database, never sent to the browser.
- Secret fields are **write-only**: the UI only ever shows a mask like `sk-ant-••••3f9a`.
  Leave a secret field blank to keep the stored value.
- Passwords hashed with **scrypt**; sessions are httpOnly cookies (Secure in production);
  session is regenerated on login.
- **Role checks are server-side** (`requireSuper`) on every Settings/Team route — a team member
  cannot reach them or escalate their own role.
- Hardening: Helmet + CSP (no inline scripts), CSRF token on every form, login rate-limiting.
- **`data/` is fully git-ignored** — your database, secrets file, backups and recovery emails
  can never be pushed to GitHub.

---

## Deployment

This is a **long-running Node/Express server**: `node-cron` ticks every minute to fire scheduled
posts. That shapes where it can run.

### Recommended: Render / Railway / Fly.io

Works with this code as-is. Requirements:

1. **Attach a persistent disk** mounted at `data/` — otherwise the JSON database is wiped on
   every deploy.
2. Set environment variables (see `.env.example`):
   - `MASTER_KEY` — 64 hex chars. `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`
   - `SESSION_SECRET` — long random string
   - `NODE_ENV=production`
3. Build: `npm install` · Start: `npm start`

> ⚠️ Set `MASTER_KEY` **once and keep it forever**. If it changes, every stored API key/token
> becomes undecryptable and must be re-entered.

> ⚠️ Free tiers that **sleep on idle** (e.g. Render free) stop the scheduler while asleep, so
> timed posts are missed. Use an always-on paid instance for reliable automation.

### Not recommended: Vercel (as-is)

Vercel is serverless and this app is not serverless-shaped. It would need real changes:

- **No persistent disk** — `data/db.json` is wiped on every deploy/restart. Requires migrating
  `src/store.js` to Postgres (Neon/Vercel Postgres) or similar.
- **`node-cron` never runs.** You'd need a Vercel Cron job hitting an HTTP endpoint that calls
  `scheduler.tick()`. On the **free Hobby plan cron runs at most once per day**, so
  multiple-times-per-day scheduling needs **Pro**.
- **In-memory sessions** don't survive between invocations — needs cookie/JWT or an external
  session store.

The data layer is isolated in `src/store.js` to make a Postgres swap straightforward if you
later choose this route.

---

## Project layout

```
server.js              Express app, routes, access control
src/platforms.js       SINGLE SOURCE OF TRUTH for platforms
src/store.js           JSON data store + forward migrations (normalize)
src/contentBrain.js    Prompt building, Claude call, Gemini images, templates
src/scheduler.js       Minute tick: weekly slots + individually scheduled posts
src/crypto.js          scrypt passwords, AES-256-GCM secrets, masking
src/auth.js            Session, CSRF, requireLogin, requireSuper
src/config.js          Env/secret bootstrap
src/mailer.js          SMTP (falls back to data/outbox/ offline)
views/                 EJS pages
public/                styles.css, app.js (CSP-safe, no inline JS)
data/                  GIT-IGNORED: db.json, .secrets.json, backups, outbox
```
