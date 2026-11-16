import { useEffect, useState } from 'react';
import { Plus } from 'lucide-react';
import { api, getSocket } from '../api.js';
import { PageHeader, Pill } from '../components/ui.jsx';

const KIND = { reminder: '⏰ Reminder', event: '📅 Appointment', message: '💬 Message', email: '✉️ Email', briefing: '☀️ Daily summary', review: '🧠 Self-review' };
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

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function Skills({ timeZone }) {
  const [list, setList] = useState([]);
  const [rule, setRule] = useState('');
  useEffect(() => {
    const load = () => api('/skills').then(setList);
    load();
    const socket = getSocket();
    socket.on('skills', load);
    return () => socket.off('skills', load);
  }, []);
  const add = async (e) => {
    e.preventDefault();
    setList(await api('/skills', { method: 'POST', body: { text: rule } }));
    setRule('');
  };
  return (
    <div className="card stack">
      <h3>Skills it learned</h3>
      <small className="muted">
        Teach new abilities by chat. Rules change how customers are answered ("from now on tell customers delivery is free over 500 AED").
        Regular jobs run by themselves ("every Friday at 5 send Nour the week's summary", "كل يوم الساعة 9 دورلي على سعر الذهب وخبرني").
        Messages still wait for your "yes" if that is on.
      </small>
      {list.length > 0 && (
        <table className="table flat">
          <thead><tr><th>#</th><th>Kind</th><th>What</th><th>Next run</th><th>On</th><th /></tr></thead>
          <tbody>
            {list.map((s) => (
              <tr key={s.id}>
                <td>{s.id}</td>
                <td className="nowrap">{s.kind === 'rule' ? '📏 Rule' : `⚙️ ${s.repeat === 'weekly' ? `Every ${DAYS[s.weekday]}` : 'Every day'} ${s.time}`}</td>
                <td dir="auto">{s.text}</td>
                <td className="nowrap small">{s.kind === 'job' && s.enabled && s.next_run ? when(s.next_run, timeZone) : '—'}</td>
                <td><input type="checkbox" checked={!!s.enabled} onChange={(e) => api(`/skills/${s.id}/enabled`, { method: 'POST', body: { enabled: e.target.checked } }).then(setList)} /></td>
                <td><button type="button" className="danger" onClick={() => confirm('Delete this skill?') && api(`/skills/${s.id}`, { method: 'DELETE' }).then(setList)}>Delete</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <form className="row" onSubmit={add}>
        <input className="grow" dir="auto" value={rule} onChange={(e) => setRule(e.target.value)} placeholder="Add a rule, e.g. Always ask which city before giving a delivery price" />
        <button className="primary" disabled={!rule.trim()}>Add rule</button>
      </form>
    </div>
  );
}

const REPO = 'https://github.com/shamoos63/contact-ai-agent';

// What owners asked for that the assistant can't do yet.
function Wishes() {
  const [list, setList] = useState([]);
  useEffect(() => {
    const load = () => api('/wishes').then(setList);
    load();
    const socket = getSocket();
    socket.on('wishes', load);
    return () => socket.off('wishes', load);
  }, []);
  if (!list.length) return null;
  const issue = (w) => `${REPO}/issues/new?title=${encodeURIComponent(`Assistant: ${w.text}`.slice(0, 120))}&body=${encodeURIComponent(`Asked ${w.times} time(s) in the assistant chat${w.owner_name ? ` by ${w.owner_name}` : ''}:\n\n> ${w.text}`)}`;
  return (
    <div className="card stack">
      <h3>Things it can't do yet</h3>
      <small className="muted">You asked for these and the assistant couldn't do them. Send one to the developer as a GitHub issue, or mark it done once it's built.</small>
      <table className="table flat">
        <tbody>
          {list.map((w) => (
            <tr key={w.id}>
              <td dir="auto">{w.text}{w.times > 1 && <span className="muted"> ×{w.times}</span>}</td>
              <td className="right nowrap">
                <a className="button" href={issue(w)} target="_blank" rel="noreferrer">Request on GitHub</a>{' '}
                <button type="button" onClick={() => api(`/wishes/${w.id}/done`, { method: 'POST' }).then(setList)}>Done</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SavedContacts() {
  const [data, setData] = useState({ owners: [], contacts: [] });
  const [form, setForm] = useState({ owner_key: '', name: '', phone: '', email: '' });
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => api('/assistant/contacts').then(setData);
    load();
    const socket = getSocket();
    socket.on('owner_contacts', load);
    return () => socket.off('owner_contacts', load);
  }, []);
  const ownerName = (key) => data.owners.find((o) => o.key === key)?.name || key;
  const add = async (e) => {
    e.preventDefault();
    setErr('');
    try {
      await api('/assistant/contacts', { method: 'POST', body: { ...form, owner_key: form.owner_key || data.owners[0]?.key } });
      setForm({ ...form, name: '', phone: '', email: '' });
    } catch (e2) {
      setErr(e2.message);
    }
  };
  const remove = async (c) => confirm(`Delete ${c.name}?`) && api(`/assistant/contacts/${c.id}`, { method: 'DELETE' });
  return (
    <div className="card stack">
      <h3>Saved contacts</h3>
      <small className="muted">Names and numbers each person asked the assistant to remember ("save Nour +971 50 123 4567" / "احفظ رقم نور …"). Everyone has their own list. When a name matches more than one person, the assistant asks which one.</small>
      {data.contacts.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="table flat">
            <thead><tr><th>Name</th><th>Number / email</th><th>Saved by</th><th /></tr></thead>
            <tbody>
              {data.contacts.map((c) => (
                <tr key={c.id}>
                  <td><bdi>{c.name}</bdi></td>
                  <td>{[c.phone, c.email].filter(Boolean).join(', ')}</td>
                  <td>{ownerName(c.owner_key)}</td>
                  <td><button type="button" className="danger" onClick={() => remove(c)}>Delete</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.owners.length > 0 ? (
        <form className="team-row" onSubmit={add}>
          <label>For<select value={form.owner_key || data.owners[0]?.key} onChange={(e) => setForm({ ...form, owner_key: e.target.value })}>{data.owners.map((o) => <option key={o.key} value={o.key}>{o.name}</option>)}</select></label>
          <label>Name<input dir="auto" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Nour" /></label>
          <label>WhatsApp number<input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="+971 50 123 4567" /></label>
          <label>Email (optional)<input value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} placeholder="nour@company.com" /></label>
          <button className="primary">Add</button>
        </form>
      ) : <p className="muted">Add a person under "Who can give tasks" and save first.</p>}
      {err && <span className="error">{err}</span>}
    </div>
  );
}

// The assistant page also edits a few settings kept under their own keys.
const EXTRAS = ['followups', 'customer_memory', 'self_review'];

export default function Assistant() {
  const [a, setA] = useState(null);
  const [tasks, setTasks] = useState([]);
  const [showAll, setShowAll] = useState(false);
  const [msg, setMsg] = useState('');
  const withExtras = (s) => setA({ ...s.assistant, ...Object.fromEntries(EXTRAS.map((k) => [k, s[k]])) });

  useEffect(() => {
    api('/settings').then(withExtras);
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
    const extras = Object.fromEntries(EXTRAS.map((k) => [k, a[k]]));
    if (extras.followups) extras.followups = { ...extras.followups, hours: Math.max(2, Number(extras.followups.hours) || 24) };
    withExtras(await api('/settings', { method: 'PUT', body: { assistant: a, ...extras } }));
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
            <label className="switch">
              <input type="checkbox" checked={a.web_access !== false} onChange={(e) => setA({ ...a, web_access: e.target.checked })} />
              <span>Online access: search the web, read links I send, and learn new things (added to Knowledge only after I reply "yes"). Customers never get web answers.</span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={a.ask_when_unsure !== false} onChange={(e) => setA({ ...a, ask_when_unsure: e.target.checked })} />
              <span>Ask me when the AI can't answer a customer. I reply with the answer, it goes to the customer and is remembered in Knowledge.</span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={a.alerts !== false} onChange={(e) => setA({ ...a, alerts: e.target.checked })} />
              <span>Tell me right away about complaints, refunds and cancellations</span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={a.followups?.enabled !== false} onChange={(e) => setA({ ...a, followups: { ...a.followups, enabled: e.target.checked } })} />
              <span>Follow up with customers who asked about prices and went quiet</span>
            </label>
            {a.followups?.enabled !== false && (
              <div className="row">
                <label>
                  After (hours)
                  <input type="number" min="2" max="168" value={a.followups?.hours ?? 24} onChange={(e) => setA({ ...a, followups: { ...a.followups, hours: e.target.value } })} />
                </label>
                <label className="grow">
                  How
                  <select value={a.followups?.mode || 'remind_me'} onChange={(e) => setA({ ...a, followups: { ...a.followups, mode: e.target.value } })}>
                    <option value="remind_me">Ask me first (I reply "yes")</option>
                    <option value="send">Send the follow-up by itself</option>
                  </select>
                </label>
              </div>
            )}
            <label className="switch">
              <input type="checkbox" checked={a.customer_memory?.enabled !== false} onChange={(e) => setA({ ...a, customer_memory: { enabled: e.target.checked } })} />
              <span>Remember customers: short notes (name, what they want, preferences) used in later replies and shown in the inbox</span>
            </label>
            <label className="switch">
              <input type="checkbox" checked={a.self_review?.enabled !== false} onChange={(e) => setA({ ...a, self_review: { ...a.self_review, enabled: e.target.checked } })} />
              <span>Every week, send me a business report and what the AI wants to learn</span>
            </label>
            {a.self_review?.enabled !== false && (
              <div className="row">
                <label className="grow">
                  Day
                  <select value={a.self_review?.day || 'Sunday'} onChange={(e) => setA({ ...a, self_review: { ...a.self_review, day: e.target.value } })}>
                    {DAYS.map((d) => <option key={d}>{d}</option>)}
                  </select>
                </label>
                <label>At<input type="time" value={a.self_review?.time || '10:00'} onChange={(e) => setA({ ...a, self_review: { ...a.self_review, time: e.target.value } })} /></label>
              </div>
            )}
            {a.alerts !== false && (
              <label>
                Alert words (comma separated)
                <textarea dir="auto" rows={2} value={a.alert_keywords || ''} onChange={(e) => setA({ ...a, alert_keywords: e.target.value })} />
                <small className="muted">Questions and alerts go to the first person under "Who can give tasks".</small>
              </label>
            )}
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

      <SavedContacts />

      <Skills timeZone={a.timezone} />

      <Wishes />

      <div className="card stack">
        <h3>Things to try</h3>
        <div className="grid2">
          <ul className="muted">
            <li>Search the price of iPhone 16 Pro in Dubai · Learn about … · send a link</li>
            <li>Save Nour +971 50 123 4567 · then "tell Nour…"</li>
            <li>Remind me tomorrow at 9 to call Ahmad</li>
            <li>I have a meeting with Sami on Thursday at 4</li>
            <li>Tell Mona her order is ready</li>
            <li>Send +971 50 123 4567 "we are open today until 8" at 5pm</li>
            <li>Email sami@company.com the new price list: …</li>
            <li>What do I have tomorrow? · Cancel #12 · Summary of today</li>
          </ul>
          <ul className="muted" dir="rtl">
            <li>دورلي على سعر iPhone 16 Pro بدبي · تعلم عن … · ابعت رابط</li>
            <li>احفظ رقم نور ‎+971 50 123 4567‎ · بعدين "احكي مع نور…"</li>
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
