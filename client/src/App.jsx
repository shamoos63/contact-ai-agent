import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes } from 'react-router-dom';
import { api, closeSocket } from './api.js';
import Login from './pages/Login.jsx';
import Inbox from './pages/Inbox.jsx';
import Knowledge from './pages/Knowledge.jsx';
import Redirects from './pages/Redirects.jsx';
import Channels from './pages/Channels.jsx';
import Settings from './pages/Settings.jsx';

export default function App() {
  const [user, setUser] = useState(undefined);

  useEffect(() => {
    api('/me').then(setUser).catch(() => setUser(null));
    const onOut = () => setUser(null);
    window.addEventListener('logged-out', onOut);
    return () => window.removeEventListener('logged-out', onOut);
  }, []);

  if (user === undefined) return <div className="center muted">Loading…</div>;
  if (!user) return <Login onLogin={() => api('/me').then(setUser)} />;

  const logout = async () => {
    await api('/logout', { method: 'POST' });
    closeSocket();
    setUser(null);
  };

  return (
    <div className="layout">
      <aside className="sidebar">
        <div className="brand">🤖 Contact AI</div>
        <nav>
          <NavLink to="/inbox">💬 Inbox</NavLink>
          <NavLink to="/knowledge">📚 Knowledge</NavLink>
          <NavLink to="/redirects">↪️ Redirects</NavLink>
          <NavLink to="/channels">🔌 Channels</NavLink>
          <NavLink to="/settings">⚙️ Settings</NavLink>
        </nav>
        <button className="link" onClick={logout}>Log out ({user.username})</button>
      </aside>
      <main className="main">
        <Routes>
          <Route path="/inbox/:id?" element={<Inbox />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/redirects" element={<Redirects />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/inbox" replace />} />
        </Routes>
      </main>
    </div>
  );
}
