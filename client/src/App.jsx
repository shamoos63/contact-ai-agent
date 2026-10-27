import { useEffect, useState } from 'react';
import { NavLink, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { LayoutDashboard, MessageSquare, BookOpen, CornerUpRight, Plug, Cpu, Settings as SettingsIcon, LogOut, Menu, Bot, Forward } from 'lucide-react';
import { api, closeSocket, getSocket } from './api.js';
import { useEngine } from './useEngine.js';
import Login from './pages/Login.jsx';
import Overview from './pages/Overview.jsx';
import Inbox from './pages/Inbox.jsx';
import Knowledge from './pages/Knowledge.jsx';
import Redirects from './pages/Redirects.jsx';
import Channels from './pages/Channels.jsx';
import Engine from './pages/Engine.jsx';
import Forwarding from './pages/Forwarding.jsx';
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
  return <Shell user={user} onLogout={logout} />;
}

function Shell({ user, onLogout }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [engine] = useEngine(15000);
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    const load = () => api('/stats').then((s) => setUnread(s.unread)).catch(() => {});
    load();
    const socket = getSocket();
    socket.on('conversation', load);
    return () => socket.off('conversation', load);
  }, []);

  const downloading = engine?.downloads?.find((d) => d.state === 'downloading');
  const engineTone = !engine ? 'muted' : !engine.online ? 'error' : downloading || !engine.chatModelReady || !engine.embedModelReady ? 'warn' : 'ok';
  const engineLabel = !engine ? 'Checking…' : !engine.online ? 'AI offline'
    : downloading ? `Downloading ${downloading.total ? Math.floor((downloading.completed / downloading.total) * 100) + '%' : '…'}`
    : !engine.chatModelReady || !engine.embedModelReady ? 'Models missing' : 'AI ready';

  const links = [
    ['/overview', LayoutDashboard, 'Overview'],
    ['/inbox', MessageSquare, 'Inbox', unread],
    ['/knowledge', BookOpen, 'Knowledge'],
    ['/redirects', CornerUpRight, 'Redirects'],
    ['/forwarding', Forward, 'Email forwarding'],
    ['/channels', Plug, 'Channels'],
    ['/engine', Cpu, 'AI engine'],
    ['/settings', SettingsIcon, 'Settings'],
  ];

  return (
    <div className="layout">
      <header className="mobile-bar">
        <button className="icon" onClick={() => setOpen(!open)} aria-label="Menu"><Menu size={20} /></button>
        <span className="brand"><Bot size={20} /> Contact AI</span>
      </header>
      <aside className={`sidebar ${open ? 'open' : ''}`}>
        <div className="brand"><span className="brand-mark"><Bot size={18} /></span> Contact AI</div>
        <nav>
          {links.map(([to, Icon, label, badge]) => (
            <NavLink key={to} to={to}>
              <Icon size={18} /> <span className="grow">{label}</span>
              {badge > 0 && <span className="badge">{badge}</span>}
            </NavLink>
          ))}
        </nav>
        <NavLink to="/engine" className={`engine-chip ${engineTone}`}>
          <span className="pill-dot" /> {engineLabel}
        </NavLink>
        <div className="user-row">
          <span className="avatar small-avatar">{user.username[0]?.toUpperCase()}</span>
          <span className="grow">{user.username}</span>
          <button className="icon" onClick={onLogout} title="Log out"><LogOut size={16} /></button>
        </div>
      </aside>
      {open && <div className="scrim" onClick={() => setOpen(false)} />}
      <main className="main">
        <Routes>
          <Route path="/overview" element={<Overview />} />
          <Route path="/inbox/:id?" element={<Inbox />} />
          <Route path="/knowledge" element={<Knowledge />} />
          <Route path="/redirects" element={<Redirects />} />
          <Route path="/forwarding" element={<Forwarding />} />
          <Route path="/channels" element={<Channels />} />
          <Route path="/engine" element={<Engine />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="*" element={<Navigate to="/overview" replace />} />
        </Routes>
      </main>
    </div>
  );
}
