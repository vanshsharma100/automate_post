import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, setToken, onAuthLost } from './api.js';
import { Toaster, Spinner } from './ui.jsx';
import { Login } from './screens/Login.jsx';
import { Shell } from './components/Shell.jsx';

const AppCtx = createContext(null);
export const useApp = () => useContext(AppCtx);

export function App() {
  const [booting, setBooting] = useState(true);
  const [user, setUser] = useState(null);
  const [boot, setBoot] = useState(null);
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  const [theme, setTheme] = useState(() => localStorage.getItem('ap_theme') || 'dark');
  const [master, setMaster] = useState('MANUAL');

  // Theme
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('ap_theme', theme);
  }, [theme]);

  // Routing
  const navigate = useCallback((path) => {
    if (path !== window.location.pathname) window.history.pushState({}, '', path);
    setRoute(parseRoute(path));
  }, []);
  useEffect(() => {
    const onPop = () => setRoute(parseRoute(window.location.pathname));
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  const loadBootstrap = useCallback(async () => {
    const data = await api.get('/bootstrap');
    setBoot(data);
    setUser(data.user);
    setMaster(data.masterSwitch);
    return data;
  }, []);

  // Initial session restore via refresh cookie.
  useEffect(() => {
    (async () => {
      try {
        const r = await fetch('/api/v1/auth/refresh', { method: 'POST', credentials: 'same-origin' });
        if (r.ok) {
          const d = await r.json();
          setToken(d.accessToken);
          await loadBootstrap();
        }
      } catch { /* not logged in */ }
      setBooting(false);
    })();
  }, [loadBootstrap]);

  // React to silent-refresh failure.
  useEffect(() => onAuthLost(() => { setUser(null); setBoot(null); }), []);

  const onLoggedIn = useCallback(async (u) => {
    if (u?.mustChangePassword) { setUser(u); return; }
    await loadBootstrap();
    navigate('/');
  }, [loadBootstrap, navigate]);

  const logout = useCallback(async () => {
    try { await api.post('/auth/logout'); } catch { /* ignore */ }
    setToken(null); setUser(null); setBoot(null); navigate('/login');
  }, [navigate]);

  if (booting) {
    return <div style={{ height: '100vh', display: 'grid', placeItems: 'center' }}><Spinner /></div>;
  }

  const ctx = {
    user, boot, theme, master, route, navigate, logout,
    setTheme, toggleTheme: () => setTheme((t) => (t === 'dark' ? 'light' : 'dark')),
    setMaster, setUser, reloadBootstrap: loadBootstrap,
    platformMeta: boot?.platformMeta || {}, platformCaps: boot?.platformCaps || {}, enums: boot?.enums || {},
  };

  return (
    <AppCtx.Provider value={ctx}>
      {!user || !boot ? <Login onLoggedIn={onLoggedIn} forcedUser={user} /> : <Shell />}
      <Toaster />
    </AppCtx.Provider>
  );
}

function parseRoute(pathname) {
  const parts = pathname.replace(/^\/+|\/+$/g, '').split('/');
  const name = parts[0] || 'dashboard';
  return { name: name === '' ? 'dashboard' : name, param: parts[1] || null, path: pathname };
}
