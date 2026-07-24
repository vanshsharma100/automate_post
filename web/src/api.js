// Tiny fetch client. Access token kept in memory (never localStorage — doc 08).
// Refresh token lives in an HttpOnly cookie; on 401 we try one silent refresh.
let accessToken = null;
const listeners = new Set();

export function setToken(t) { accessToken = t; }
export function getToken() { return accessToken; }
export function onAuthLost(fn) { listeners.add(fn); return () => listeners.delete(fn); }

const BASE = '/api/v1';

async function request(method, path, body, { retry = true } = {}) {
  const res = await fetch(BASE + path, {
    method,
    headers: { 'content-type': 'application/json', ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}) },
    body: body != null ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  // A 401 on an auth route means bad credentials/expired refresh — surface it
  // directly rather than masking it behind a refresh attempt.
  if (res.status === 401 && retry && !path.startsWith('/auth/')) {
    // Try a silent refresh once.
    const r = await fetch(BASE + '/auth/refresh', { method: 'POST', credentials: 'same-origin' });
    if (r.ok) {
      const data = await r.json();
      accessToken = data.accessToken;
      return request(method, path, body, { retry: false });
    }
    accessToken = null;
    listeners.forEach((fn) => fn());
    const err = new Error('Session expired');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Request failed (${res.status})`);
    err.code = json?.error?.code || 'ERROR';
    err.status = res.status;
    err.details = json?.error?.details;
    throw err;
  }
  return json;
}

// Raw binary upload (a File/Blob) — used for media. Sends the bytes as the body
// with the file's own content-type, which the server reads via express.raw.
async function upload(path, file) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: {
      'content-type': file.type || 'application/octet-stream',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
    body: file,
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json; try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text }; }
  if (!res.ok) {
    const err = new Error(json?.error?.message || `Upload failed (${res.status})`);
    err.code = json?.error?.code || 'ERROR';
    err.status = res.status;
    throw err;
  }
  return json;
}

export const api = {
  get: (p) => request('GET', p),
  post: (p, b) => request('POST', p, b),
  put: (p, b) => request('PUT', p, b),
  patch: (p, b) => request('PATCH', p, b),
  del: (p, b) => request('DELETE', p, b),
  upload,
  raw: request,
};
