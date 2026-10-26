import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { api, getSocket, CHANNELS, timeAgo, formatTime } from '../api.js';

export default function Inbox() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [conversations, setConversations] = useState([]);
  const [filter, setFilter] = useState('');
  const [query, setQuery] = useState('');

  useEffect(() => {
    api('/conversations').then(setConversations);
    const socket = getSocket();
    const onConv = (c) =>
      setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort((a, b) => (b.last_message_at || '').localeCompare(a.last_message_at || '')));
    socket.on('conversation', onConv);
    return () => socket.off('conversation', onConv);
  }, []);

  const shown = useMemo(() => {
    const q = query.toLowerCase();
    return conversations.filter(
      (c) =>
        (!filter || c.channel === filter) &&
        (!q || [c.contact_name, c.contact_handle, c.last_message, c.subject].some((v) => v?.toLowerCase().includes(q))),
    );
  }, [conversations, filter, query]);

  return (
    <div className="inbox">
      <section className="conv-list">
        <div className="conv-tools">
          <input placeholder="Search…" value={query} onChange={(e) => setQuery(e.target.value)} />
          <div className="chips">
            <button className={!filter ? 'chip active' : 'chip'} onClick={() => setFilter('')}>All</button>
            {Object.entries(CHANNELS).map(([k, v]) => (
              <button key={k} className={filter === k ? 'chip active' : 'chip'} onClick={() => setFilter(k)} title={v.label}>
                {v.icon}
              </button>
            ))}
          </div>
        </div>
        {shown.length === 0 && <div className="muted pad">No conversations yet. Connect a channel to start receiving messages.</div>}
        {shown.map((c) => (
          <button key={c.id} className={`conv ${String(c.id) === id ? 'selected' : ''}`} onClick={() => navigate(`/inbox/${c.id}`)}>
            <span className="dot" style={{ background: CHANNELS[c.channel]?.color }} title={CHANNELS[c.channel]?.label} />
            <span className="conv-body">
              <span className="conv-top">
                <strong dir="auto">{c.contact_name || c.contact_handle || c.external_id}</strong>
                <small className="muted">{timeAgo(c.last_message_at)}</small>
              </span>
              <span className="conv-preview muted" dir="auto">{c.last_message}</span>
            </span>
            {c.unread > 0 && <span className="badge">{c.unread}</span>}
            {!c.auto_reply && <span className="tag" title="AI is paused, a human is handling this chat">👤</span>}
          </button>
        ))}
      </section>
      {id ? <Conversation key={id} id={Number(id)} /> : <div className="center muted">Select a conversation</div>}
    </div>
  );
}

function Conversation({ id }) {
  const [conv, setConv] = useState(null);
  const [messages, setMessages] = useState([]);
  const [text, setText] = useState('');
  const [typing, setTyping] = useState(false);
  const [error, setError] = useState('');
  const bottom = useRef(null);

  useEffect(() => {
    api(`/conversations/${id}`).then(({ conversation, messages }) => {
      setConv(conversation);
      setMessages(messages);
      if (conversation.unread) api(`/conversations/${id}`, { method: 'PATCH', body: { unread: 0 } });
    });
    const socket = getSocket();
    const onMsg = (m) => {
      if (m.conversation_id !== id) return;
      setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, m]));
      if (m.direction === 'in') api(`/conversations/${id}`, { method: 'PATCH', body: { unread: 0 } });
    };
    const onConv = (c) => c.id === id && setConv(c);
    const onTyping = (t) => t.conversationId === id && setTyping(t.typing);
    socket.on('message', onMsg);
    socket.on('conversation', onConv);
    socket.on('typing', onTyping);
    return () => {
      socket.off('message', onMsg);
      socket.off('conversation', onConv);
      socket.off('typing', onTyping);
    };
  }, [id]);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: 'smooth' }), [messages, typing]);

  if (!conv) return <div className="center muted">Loading…</div>;
  const ch = CHANNELS[conv.channel];

  const send = async (e) => {
    e.preventDefault();
    if (!text.trim()) return;
    setError('');
    try {
      await api(`/conversations/${id}/messages`, { method: 'POST', body: { text } });
      setText('');
    } catch (err) {
      setError(err.message);
    }
  };
  const toggleAi = () => api(`/conversations/${id}`, { method: 'PATCH', body: { auto_reply: !conv.auto_reply } });
  const aiReply = () => api(`/conversations/${id}/ai-reply`, { method: 'POST' }).catch((err) => setError(err.message));
  const toggleStatus = () => api(`/conversations/${id}`, { method: 'PATCH', body: { status: conv.status === 'open' ? 'closed' : 'open' } });

  return (
    <section className="chat">
      <header className="chat-head">
        <div>
          <strong dir="auto">{conv.contact_name || conv.contact_handle}</strong>
          <div className="muted small">
            <span style={{ color: ch?.color }}>{ch?.icon} {ch?.label}</span> · {conv.contact_handle}
            {conv.subject && <> · <span dir="auto">{conv.subject}</span></>}
          </div>
        </div>
        <div className="row">
          <label className="switch" title="When on, the AI answers this customer automatically">
            <input type="checkbox" checked={!!conv.auto_reply} onChange={toggleAi} />
            <span>AI auto-reply</span>
          </label>
          <button onClick={toggleStatus}>{conv.status === 'open' ? 'Close' : 'Reopen'}</button>
        </div>
      </header>
      <div className="messages">
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.direction} ${m.sender}`}>
            <div className="bubble" dir="auto">{m.text}</div>
            <div className="meta small muted">
              {m.sender === 'ai' ? '🤖 AI' : m.sender === 'agent' ? '👤 You' : ''} {formatTime(m.created_at)}
              {m.error && <span className="error"> · not delivered: {m.error}</span>}
            </div>
          </div>
        ))}
        {typing && <div className="msg out ai"><div className="bubble muted">🤖 typing…</div></div>}
        <div ref={bottom} />
      </div>
      <form className="composer" onSubmit={send}>
        <textarea
          dir="auto"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && send(e)}
          placeholder="Type a reply… (Enter to send, Shift+Enter for new line)"
        />
        <div className="col">
          <button className="primary">Send</button>
          <button type="button" onClick={aiReply} title="Let the AI answer now">🤖 AI reply</button>
        </div>
      </form>
      {error && <div className="error pad">{error}</div>}
    </section>
  );
}
