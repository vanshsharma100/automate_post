// Production smoke test / scan. Verifies the clean-slate app (no demo data):
// scaffolding is present, real paths are wired, and content generation correctly
// requires a real AI key. Run: node server/scripts/smoke.mjs
const BASE = process.env.BASE || 'http://localhost:3001/api/v1';
let pass = 0, fail = 0; const results = [];
function ok(name, cond, detail = '') { (cond ? pass++ : fail++); results.push({ name, ok: !!cond, detail }); console.log(`${cond ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`); }

let token = '';
async function api(method, path, body) {
  const res = await fetch(BASE + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text(); let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  return { status: res.status, json };
}

async function main() {
  let r = await api('GET', '/health'); ok('health', r.status === 200 && r.json.ok);

  const pw = process.env.PW || 'golu9588';
  r = await api('POST', '/auth/login', { username: 'admin', password: pw });
  token = r.json.accessToken; ok('login', r.status === 200 && !!token, `mustChange=${r.json.mustChangePassword}`);
  if (r.json.mustChangePassword) { r = await api('POST', '/auth/change-password', { currentPassword: pw, newPassword: 'Vansh-Secure-2026!' }); token = r.json.accessToken; ok('forced password change', r.status === 200 && r.json.ok); }

  r = await api('GET', '/bootstrap');
  ok('bootstrap payload', r.status === 200 && r.json.user?.role === 'SUPER_ADMIN', `workspace="${r.json.tenant?.name}"`);

  // Scaffolding present
  r = await api('GET', '/brain/providers'); ok('provider catalogue', r.json.data?.length === 3 && r.json.data.every((p) => !p.hasKey), `${r.json.data?.length} providers, no keys`);
  r = await api('GET', '/brain/models?available=true'); ok('model catalogue', r.json.data?.length >= 8, `${r.json.data?.length} models`);
  r = await api('GET', '/brain/profiles'); ok('routing profile + bindings', r.json.data?.[0]?.bindings?.length >= 8, `${r.json.data?.[0]?.bindings?.length} bindings`);
  r = await api('GET', '/knowledge'); ok('knowledge templates', r.json.data?.length === 2, `${r.json.data?.length} boxes`);
  r = await api('GET', '/brand-voices'); ok('default brand voice', r.json.data?.length === 1);

  // No demo data
  r = await api('GET', '/connections'); ok('NO demo connections', r.json.data?.length === 0, `${r.json.data?.length} connections`);
  r = await api('GET', '/shopify/store'); ok('NO demo store', r.json.data === null);
  r = await api('GET', '/posts?limit=5'); ok('NO demo posts', (r.json.meta?.total || 0) === 0, `${r.json.meta?.total} posts`);

  // Real Shopify connect path (validation)
  r = await api('POST', '/shopify/connect', { shopDomain: 'store.myshopify.com', accessToken: '' });
  ok('shopify connect validates', r.status === 400 && /token is required/i.test(r.json.error?.message || ''));

  // Real OAuth path — not configured (no env creds) returns a precise message
  r = await api('GET', '/platforms'); const li = (r.json.data || []).find((p) => p.platform === 'LINKEDIN');
  ok('platforms expose oauth status', li && li.oauthConfigured === false, `LinkedIn requires ${li?.requiredEnv?.join('+')}`);
  r = await api('GET', '/connections/oauth/LINKEDIN/start');
  ok('oauth start → setup message', r.status === 400 && /LINKEDIN_CLIENT_ID/.test(r.json.error?.message || ''));

  // Real content requires a real key
  r = await api('POST', '/connections/oauth/LINKEDIN/sandbox', { label: 'Test LinkedIn' });
  const sandbox = r.json.data; ok('sandbox connection', r.status === 201 && !!sandbox?.id);
  r = await api('POST', '/posts/generate', { connectionId: sandbox.id, category: 'KNOWLEDGE' });
  ok('generate BLOCKED without AI key', r.status === 400 && r.json.error?.code === 'NO_PROVIDER', 'real path — no fake content');

  // Webhook connector (real)
  r = await api('POST', '/connections', { platform: 'CUSTOM_WEBHOOK', label: 'Test hook', config: { url: 'https://example.com/hook' } });
  ok('webhook connection (real)', r.status === 201);

  // Knowledge editing works
  r = await api('GET', '/knowledge'); const kb = r.json.data[0];
  r = await api('PATCH', `/knowledge/${kb.id}`, { content: 'We build custom PCs.', doRules: ['Be specific'] });
  ok('knowledge edit + version bump', r.json.data?.version === 2);

  // Admin surfaces
  r = await api('GET', '/audit-logs'); ok('audit log', r.json.data?.length >= 2);
  r = await api('GET', '/automation/status'); ok('automation status', r.json.data?.masterSwitch === 'MANUAL');
  r = await api('GET', '/storage/overview'); ok('storage overview', Array.isArray(r.json.data));

  console.log(`\n${'='.repeat(50)}\nRESULT: ${pass} passed, ${fail} failed\n${'='.repeat(50)}`);
  if (fail > 0) { console.log('FAILURES:'); results.filter((x) => !x.ok).forEach((x) => console.log('  ✗', x.name, x.detail)); process.exit(1); }
}
main().catch((e) => { console.error('SMOKE CRASH:', e); process.exit(2); });
