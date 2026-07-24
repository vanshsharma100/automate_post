// Real OAuth 2.0 authorization-code flows for the social platforms (doc 04 §3).
// Activates the moment you set the app credentials in .env AND your app has the
// required scopes approved by the platform (Meta App Review / LinkedIn products
// / Google Business Profile quota). Until then, /start returns a precise setup
// message. NOTE: these paths are implemented to each provider's documented API
// but cannot be exercised here without live approved apps.
import { config } from '../config.js';
import { getLinkedInApp, scopesFor as linkedinScopes } from '../linkedin-client.js';
import { getPlatformApp } from '../platform-apps.js';

const V_META = 'v21.0';

export const OAUTH = {
  // Facebook + Instagram share one Meta app; credentials come from the UI
  // (Facebook screen) and fall back to app/.env. See meta-client.js.
  FACEBOOK: {
    envKeys: ['META_APP_ID', 'META_APP_SECRET'],
    clientId: () => getPlatformApp('FACEBOOK').clientId,
    clientSecret: () => getPlatformApp('FACEBOOK').clientSecret,
    authorizeUrl: `https://www.facebook.com/${V_META}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${V_META}/oauth/access_token`,
    scopes: ['pages_show_list', 'pages_manage_posts', 'pages_read_engagement', 'business_management', 'public_profile'],
  },
  INSTAGRAM: {
    envKeys: ['META_APP_ID', 'META_APP_SECRET'],
    clientId: () => getPlatformApp('FACEBOOK').clientId,
    clientSecret: () => getPlatformApp('FACEBOOK').clientSecret,
    authorizeUrl: `https://www.facebook.com/${V_META}/dialog/oauth`,
    tokenUrl: `https://graph.facebook.com/${V_META}/oauth/access_token`,
    scopes: ['instagram_basic', 'instagram_content_publish', 'pages_show_list', 'pages_read_engagement', 'business_management'],
  },
  // LinkedIn credentials come from the UI (Connections → LinkedIn) when set,
  // falling back to app/.env. That removes the "edit .env and restart" step.
  LINKEDIN: {
    envKeys: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    clientId: () => getLinkedInApp().clientId,
    clientSecret: () => getLinkedInApp().clientSecret,
    authorizeUrl: 'https://www.linkedin.com/oauth/v2/authorization',
    tokenUrl: 'https://www.linkedin.com/oauth/v2/accessToken',
    scopes: linkedinScopes(),
  },
  // Like LinkedIn, GBP credentials can come from the UI (Google Business screen)
  // and fall back to app/.env.
  GOOGLE_BUSINESS: {
    envKeys: ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'],
    clientId: () => getPlatformApp('GOOGLE_BUSINESS').clientId,
    clientSecret: () => getPlatformApp('GOOGLE_BUSINESS').clientSecret,
    authorizeUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes: ['https://www.googleapis.com/auth/business.manage'],
    extraAuthParams: { access_type: 'offline', prompt: 'consent' },
  },
};

export function isConfigured(platform) {
  const cfg = OAUTH[platform];
  return !!(cfg && cfg.clientId() && cfg.clientSecret());
}

export function requiredEnv(platform) {
  return OAUTH[platform]?.envKeys || [];
}

export function redirectUri(platform) {
  return `${config.webUrl.replace(/\/$/, '')}/api/v1/connections/oauth/${platform}/callback`;
}

export function buildAuthUrl(platform, state) {
  const cfg = OAUTH[platform];
  if (!cfg) throw new Error('Unsupported OAuth platform');
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: cfg.clientId(),
    redirect_uri: redirectUri(platform),
    scope: cfg.scopes.join(' '),
    state,
    ...(cfg.extraAuthParams || {}),
  });
  return `${cfg.authorizeUrl}?${params.toString()}`;
}

export async function exchangeCode(platform, code) {
  const cfg = OAUTH[platform];
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri(platform),
    client_id: cfg.clientId(),
    client_secret: cfg.clientSecret(),
  });
  const res = await fetch(cfg.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error_description || json.error?.message || json.error || `Token exchange failed (${res.status})`);
  const expiresAt = json.expires_in ? new Date(Date.now() + json.expires_in * 1000).toISOString() : null;
  return { accessToken: json.access_token, refreshToken: json.refresh_token || null, expiresAt, raw: json };
}

// Discover publish targets (pages / IG accounts / orgs / locations) for the
// account that just authorized. Returns [{ id, name }].
export async function listTargets(platform, bundle) {
  const token = bundle.accessToken;
  try {
    if (platform === 'FACEBOOK' || platform === 'INSTAGRAM') {
      const r = await (await fetch(`https://graph.facebook.com/${V_META}/me/accounts?fields=id,name,instagram_business_account{id,username}&access_token=${encodeURIComponent(token)}`)).json();
      return (r.data || []).map((p) => ({
        id: platform === 'INSTAGRAM' ? (p.instagram_business_account?.id || p.id) : p.id,
        name: platform === 'INSTAGRAM' ? (p.instagram_business_account?.username ? `@${p.instagram_business_account.username}` : p.name) : p.name,
        pageId: p.id, pageToken: p.access_token,
      })).filter((t) => t.id);
    }
    if (platform === 'LINKEDIN') {
      // Handled by linkedin-client (OIDC + legacy /v2/me fallback + Company
      // Pages). Errors must propagate: a bogus "primary" target used to be
      // saved as the author URN, making every later publish fail with 422.
      const { resolveMember, listOrganizations } = await import('../linkedin-client.js');
      const me = await resolveMember(token);
      return [me, ...(await listOrganizations(token))];
    }
    if (platform === 'GOOGLE_BUSINESS') {
      // Handled by google-business-client: walks every account, and composes
      // the account-scoped location name (accounts/…/locations/…) that the v4
      // localPosts endpoint requires. The bare `locations/…` this used to
      // return 404s on every publish.
      const { listTargets: gbpTargets } = await import('../google-business-client.js');
      return gbpTargets(token);
    }
  } catch (e) {
    if (platform === 'LINKEDIN' || platform === 'GOOGLE_BUSINESS') throw e;
    return [{ id: 'primary', name: 'Authorized account', note: e.message }];
  }
  return [];
}
