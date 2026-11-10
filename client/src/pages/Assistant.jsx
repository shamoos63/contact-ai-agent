import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, getSocket } from '../api.js';
import { PageHeader, Pill } from '../components/ui.jsx';

const KIND = { reminder: '⏰ Reminder', event: '📅 Appointment', message: '💬 Message', email: '✉️ Email', briefing: '☀️ Daily summary' };
const TONE = { pending: 'warn', done: 'ok', failed: 'error', cancelled: 'muted' };
const STATUS = { pending: 'Waiting', done: 'Done', failed: 'Failed', cancelled: 'Cancelled' };
const NEW_OWNER = { name: '', phone: '', telegram: '', enabled: true };

function when(iso, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-GB', { timeZone, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
  } catch {
    return new Date(iso).toLocaleString();
  }
}

function what(t) {
  const p = t.payload || {};
  if (t.kind === 'message') return `To ${p.label}: ${p.text}`;
  if (t.kind === 'email') return `To ${p.label}: ${p.subject}`;
  if (t.kind === 'event') return p.title;
  if (t.kind === 'briefing') return `Sent to ${t.owner_name || 'owner'}`;
  return p.text;
}

export default function Assistant() {
  const [a, setA] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState('');

  useEffect(() => {
    api('/settings').then((s) => setA(s.assistant));
  }, []);
  useEffect(() => {
    const load = () => api(`/assistant/tasks${showAll ? '' : '?status=pending'}`).then(setTasks);
    load();
    const socket = getSocket();
    socket.on('tasks', load);
    return () => socket.off('tasks', load);
  }, [showAll]);
  if (!a) return <div className="page"><PageHeader title="Assistant" /></div>;

  const owners = a.owners?.length ? a.owners : [{ ...NEW_OWNER }];
  const setOwner = (i, patch) => setA({ ...a, owners: owners.map((o, j) => (j === i ? { ...o, ...patch } : o)) });
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [a.timezone];

  const save = async (e) => {
    e.preventDefault();
    if (a.enabled && !owners.some((o) => o.enabled !== false && (o.phone || o.telegram))) return setMsg('⚠ Add at least one number or Telegram username');
    setA((await api('/settings', { method: 'PUT', body: { assistant: a } })).assistant);
    setMsg('✓ Saved');
    setTimeout(() => setMsg(''), 2000);
  };
  const cancel = async (t) => {
    if (!confirm(`Cancel #${t.id}?`)) return;
    await api(`/assistant/tasks/${t.id}/cancel`, { method: 'POST' });
  };

  return (
    <div className="page">
      <PageHeader
        title="Assistant"
        subtitle="Numbers you add here don't get customer answers. When they message the bot on WhatsApp or Telegram (text or voice), it works as their personal assistant: it sets reminders, saves appointments, and sends messages or emails to clients now or later."
      />

      <form className="stack" onSubmit={save}>
        <div className="card stack">
          <div className="card-head">
            <h3>Assistant</h3>
            <label className="switch"><input type="checkbox" checked={!!a.enabled} onChange={(e) => setA({ ...a, enabled: e.target.checked })} /><span>On</span></label>
          </div>
          <div className="grid2">
            <label>
              Your time zone
              <select value={a.timezone} onChange={(e) => setA({ ...a, timezone: e.target.value })}>
                {zones.map((z) => <option key={z}>{z}</option>)}
              </select>
            </label>
            <label>Remind me before appointments (minutes)<input type="number" min="0" value={a.event_reminder_minutes} onChange={(e) => setA({ ...a, event_reminder_minutes: e.target.value })} /></label>
            <label>
              Daily summary at (optional)
              <input type="time" value={a.daily_briefing || ''} onChange={(e) => setA({ ...a, daily_briefing: e.target.value })} />
              <small className="muted">Every day at this time, each person gets today's numbers and what's scheduled. Leave empty for none.</small>
            </label>
            <label className="switch">
              <input type="checkbox" checked={a.confirm_before_sending !== false} onChange={(e) => setA({ ...a, confirm_before_sending: e.target.checked })} />
              <span>Show me messages and emails first, and send only after I reply "yes"</span>
            </label>
          </div>
        </div>

        <div className="card stack">
          <h3>Who can give tasks</h3>
          {owners.map((o, i) => (
            <div key={i} className="team-row">
              <label>Name<input dir="auto" value={o.name} onChange={(e) => setOwner(i, { name: e.target.value })} placeholder="Hisham" /></label>
              <label>WhatsApp number<input value={o.phone} onChange={(e) => setOwner(i, { phone: e.target.value })} placeholder="+963 944 123 456" /></label>
              <label>Telegram username (optional)<input value={o.telegram || ''} onChange={(e) => setOwner(i, { telegram: e.target.value })} placeholder="@hisham" /></label>
              <div className="row">
                <label className="switch"><input type="checkbox" checked={o.enabled !== false} onChange={(e) => setOwner(i, { enabled: e.target.checked })} /><span>On</span></label>
                <button type="button" className="danger" onClick={() => setA({ ...a, owners: owners.filter((_, j) => j !== i) })}>Remove</button>
              </div>
            </div>
          ))}
          <div><button type="button" onClick={() => setA({ ...a, owners: [...owners, { ...NEW_OWNER }] })}><Plus size={15} /> Add person</button></div>
          <small className="muted">They message your connected WhatsApp number (or the Telegram bot) from their own phone. Use the number they message from.</small>
        </div>

        <div className="row">
          <span className="grow" />
          {msg && <span className={msg.startsWith('✓') ? 'ok' : 'error'}>{msg}</span>}
          <button className="primary">Save</button>
        </div>
      </form>

      <div className="card stack">
        <h3>Things to try</h3>
        <div className="grid2">
          <ul className="muted">
            <li>Remind me tomorrow at 9 to call Ahmad</li>
            <li>I have a meeting with Sami on Thursday at 4</li>
            <li>Tell Mona her order is ready</li>
            <li>Send +971 50 123 4567 "we are open today until 8" at 5pm</li>
            <li>Email sami@company.com the new price list: …</li>
            <li>What do I have tomorrow? · Cancel #12 · Summary of today</li>
          </ul>
          <ul className="muted" dir="rtl">
            <li>ذكرني بكرا الساعة 9 اتصل بأحمد</li>
            <li>عندي اجتماع مع سامي الخميس الساعة 4</li>
            <li>قول لمنى إنو طلبها جاهز</li>
            <li>ابعت لـ ‎+971 50 123 4567‎ "فاتحين اليوم لل 8" الساعة 5</li>
            <li>شو عندي بكرا؟ · الغي #12 · ملخص اليوم</li>
          </ul>
        </div>
      </div>

      <div className="card stack">
        <div className="card-head">
          <h3>{showAll ? 'All tasks' : 'Coming up'}</h3>
          <button type="button" onClick={() => setShowAll(!showAll)}>{showAll ? 'Show coming up' : 'Show history'}</button>
        </div>
        {!tasks.length ? (
          <p className="muted">{showAll ? 'No tasks yet.' : 'Nothing scheduled.'}</p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="table flat">
              <thead><tr><th>#</th><th>When</th><th>What</th><th>For</th><th>Status</th><th /></tr></thead>
              <tbody>
                {tasks.map((t) => (
                  <tr key={t.id}>
                    <td>{t.id}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>{when(t.payload?.event_at || t.run_at, a.timezone)}</td>
                    <td dir="auto"><strong>{KIND[t.kind] || t.kind}</strong> · {what(t)}</td>
                    <td>{t.owner_name || '—'}</td>
                    <td><Pill tone={TONE[t.status]} title={t.result || ''}>{STATUS[t.status] || t.status}</Pill></td>
                    <td>{t.status === 'pending' && <button type="button" className="danger" onClick={() => cancel(t)}>Cancel</button>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
