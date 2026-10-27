import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { MessageSquare, Bot, User, Inbox as InboxIcon, BookOpen, CornerUpRight, AlertTriangle, CheckCircle2, Circle } from 'lucide-react';
import { api, getSocket, CHANNELS, timeAgo } from '../api.js';
import { useEngine } from '../useEngine.js';
import { PageHeader, Pill, Avatar, DownloadProgress } from '../components/ui.jsx';

export default function Overview() {
  const [stats, setStats] = useState(null);
  const [channels, setChannels] = useState(null);
  const [recent, setRecent] = useState([]);
  const [engine] = useEngine();

  useEffect(() => {
    const load = () => {
      api('/stats').then(setStats);
      api('/conversations').then((c) => setRecent(c.slice(0, 6)));
    };
    load();
    api('/channels').then(setChannels);
    const socket = getSocket();
    socket.on('conversation', load);
    socket.on('channels', setChannels);
    return () => {
      socket.off('conversation', load);
      socket.off('channels', setChannels);
    };
  }, []);

  if (!stats || !channels) return <div className="center muted">Loading…</div>;

  const today = Object.fromEntries(stats.today.map((t) => [t.sender, t.n]));
  const channelRows = [
    { key: 'whatsapp', status: channels.whatsapp.status, detail: channels.whatsapp.me },
    { key: 'telegram', status: channels.telegram.status, detail: channels.telegram.username && '@' + channels.telegram.username },
    {
      key: 'email',
      status: channels.email.length ? (channels.email.every((a) => a.status === 'connected') ? 'connected' : channels.email.some((a) => a.status === 'error') ? 'error' : 'connecting') : 'disabled',
      detail: channels.email.length ? `${channels.email.length} account${channels.email.length > 1 ? 's' : ''}` : null,
    },
    { key: 'facebook', status: channels.meta.status === 'configured' ? 'connected' : channels.meta.status, detail: null },
    { key: 'instagram', status: channels.meta.status === 'configured' && channels.meta.instagram ? 'connected' : 'disabled', detail: null },
  ];
  const connected = channelRows.filter((c) => c.status === 'connected').length;
  const downloads = (engine?.downloads || []).filter((d) => d.state === 'downloading');
  const setup = [
    { done: engine?.chatModelReady && engine?.embedModelReady, label: 'Download the AI models', to: '/engine' },
    { done: stats.knowledge > 0, label: 'Teach the AI about your company', to: '/knowledge' },
    { done: stats.redirects > 0, label: 'Add where to send customers', to: '/redirects' },
    { done: connected > 0, label: 'Connect at least one channel', to: '/channels' },
  ];

  return (
    <div className="page">
      <PageHeader title="Overview" subtitle="How your AI assistant is doing today." />

      {setup.some((s) => !s.done) && (
        <section className="card setup">
          <h3>Getting started</h3>
          <div className="setup-steps">
            {setup.map((s) => (
              <Link key={s.label} to={s.to} className={s.done ? 'done' : ''}>
                {s.done ? <CheckCircle2 size={18} /> : <Circle size={18} />} {s.label}
              </Link>
            ))}
          </div>
        </section>
      )}

      <div className="grid4">
        <Stat icon={<InboxIcon size={18} />} label="Unread" value={stats.unread} to="/inbox" />
        <Stat icon={<MessageSquare size={18} />} label="Customer messages today" value={today.customer || 0} />
        <Stat icon={<Bot size={18} />} label="AI replies today" value={today.ai || 0} />
        <Stat icon={<User size={18} />} label="Your replies today" value={today.agent || 0} />
      </div>
      {stats.failedToday > 0 && (
        <div className="alert warn"><AlertTriangle size={16} /> {stats.failedToday} message{stats.failedToday > 1 ? 's' : ''} could not be delivered today. Check the channel connections.</div>
      )}

      <div className="grid2 top">
        <section className="card">
          <div className="card-head"><h3>Channels</h3><Link to="/channels" className="small">Manage</Link></div>
          <div className="list">
            {channelRows.map((c) => (
              <div key={c.key} className="list-row">
                <span className="channel-dot" style={{ background: CHANNELS[c.key].color }}>{CHANNELS[c.key].short}</span>
                <span className="grow">{CHANNELS[c.key].label} {c.detail && <span className="muted small">· {c.detail}</span>}</span>
                <StatusPill status={c.status} />
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-head"><h3>AI engine</h3><Link to="/engine" className="small">Manage</Link></div>
          {!engine ? <p className="muted">Checking…</p> : !engine.online ? (
            <div className="alert error">Ollama is not running, so the AI can't reply.</div>
          ) : (
            <div className="list">
              <div className="list-row"><Bot size={16} /><span className="grow">Replies</span><ModelPill ready={engine.chatModelReady} /></div>
              <div className="list-row"><BookOpen size={16} /><span className="grow">Knowledge search</span><ModelPill ready={engine.embedModelReady} /></div>
              <div className="list-row"><BookOpen size={16} /><span className="grow">Knowledge sources</span><strong>{stats.knowledge}</strong></div>
              <div className="list-row"><CornerUpRight size={16} /><span className="grow">Redirect rules</span><strong>{stats.redirects}</strong></div>
            </div>
          )}
          {downloads.map((d) => <DownloadProgress key={d.model} d={d} />)}
        </section>
      </div>

      <section className="card">
        <div className="card-head"><h3>Latest conversations</h3><Link to="/inbox" className="small">Open inbox</Link></div>
        {recent.length === 0 ? <p className="muted">No conversations yet.</p> : (
          <div className="list">
            {recent.map((c) => (
              <Link key={c.id} to={`/inbox/${c.id}`} className="list-row link-row">
                <Avatar name={c.contact_name || c.contact_handle} channel={c.channel} size={34} />
                <span className="grow ellipsis">
                  <strong dir="auto">{c.contact_name || c.contact_handle}</strong>
                  <span className="muted small ellipsis" dir="auto"> {c.last_message}</span>
                </span>
                {c.unread > 0 && <span className="badge">{c.unread}</span>}
                <span className="muted small">{timeAgo(c.last_message_at)}</span>
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}

function Stat({ icon, label, value, to }) {
  const body = (
    <>
      <span className="stat-icon">{icon}</span>
      <span className="stat-value">{value}</span>
      <span className="muted small">{label}</span>
    </>
  );
  return to ? <Link to={to} className="card stat link-card">{body}</Link> : <div className="card stat">{body}</div>;
}

export function StatusPill({ status, error }) {
  const map = {
    connected: ['ok', 'Connected'], configured: ['ok', 'Configured'], qr: ['warn', 'Scan QR'],
    connecting: ['warn', 'Connecting'], reconnecting: ['warn', 'Reconnecting'], disabled: ['muted', 'Off'],
    stopped: ['muted', 'Stopped'], incomplete: ['warn', 'Needs setup'], logged_out: ['warn', 'Logged out'], error: ['error', 'Error'],
  };
  const [tone, label] = map[status] || ['muted', status];
  return <Pill tone={tone} title={error}>{label}</Pill>;
}

function ModelPill({ ready }) {
  return ready ? <Pill tone="ok">Ready</Pill> : <Pill tone="warn">Not installed</Pill>;
}
