import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api.js';
import { PageHeader, Pill, DownloadProgress } from '../components/ui.jsx';
import { useEngine } from '../useEngine.js';

export default function Settings() {
  const [s, setS] = useState(null);
  const [ai, loadAi] = useEngine(5000);
  const [saved, setSaved] = useState('');

  useEffect(() => {
    api('/settings').then(setS);
  }, []);

  if (!s) return <div className="center muted">Loading…</div>;
  const set = (k) => (e) => setS({ ...s, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const save = async (e) => {
    e.preventDefault();
    const { company_name, system_prompt, fallback_message, auto_reply, reply_delay_seconds, temperature, ollama_url, chat_model, embed_model } = s;
    setS(await api('/settings', {
      method: 'PUT',
      body: { company_name, system_prompt, fallback_message, auto_reply, ollama_url, chat_model, embed_model,
        reply_delay_seconds: Number(reply_delay_seconds), temperature: Number(temperature) },
    }));
    setSaved('Saved ✓');
    setTimeout(() => setSaved(''), 2000);
    loadAi();
  };

  return (
    <div className="page">
      <PageHeader title="Settings" />
      <form className="stack" onSubmit={save}>
        <div className="card stack">
          <h3>Assistant</h3>
          <label>Company name<input dir="auto" value={s.company_name} onChange={set('company_name')} /></label>
          <label>
            Personality and instructions
            <textarea dir="auto" rows="5" value={s.system_prompt} onChange={set('system_prompt')} />
            <small className="muted">{'{company}'} is replaced by the company name. The AI always replies in the customer's language (Arabic or English).</small>
          </label>
          <label>When the AI doesn't know the answer<input dir="auto" value={s.fallback_message} onChange={set('fallback_message')} /></label>
          <div className="row">
            <label className="switch"><input type="checkbox" checked={!!s.auto_reply} onChange={set('auto_reply')} /><span>AI replies automatically on all channels</span></label>
            <label>Wait before replying (seconds)<input type="number" min="0" max="60" value={s.reply_delay_seconds} onChange={set('reply_delay_seconds')} /></label>
            <label>Creativity (0–1)<input type="number" min="0" max="1" step="0.1" value={s.temperature} onChange={set('temperature')} /></label>
          </div>
        </div>

        <div className="card stack">
          <div className="card-head">
            <h3>AI engine (Ollama)</h3>
            {ai && (ai.online ? <Pill tone="ok">Running</Pill> : <Pill tone="error">Not reachable</Pill>)}
          </div>
          <label>Ollama address<input value={s.ollama_url} onChange={set('ollama_url')} /></label>
          <div className="grid2">
            <label>
              Chat model
              <input value={s.chat_model} onChange={set('chat_model')} />
              <ModelState ai={ai} model={s.chat_model} ready={ai?.chatModelReady} />
            </label>
            <label>
              Embedding model (for the knowledge base)
              <input value={s.embed_model} onChange={set('embed_model')} />
              <ModelState ai={ai} model={s.embed_model} ready={ai?.embedModelReady} />
            </label>
          </div>
          <small className="muted">
            Good free choices for Arabic + English: <code>qwen2.5:7b</code> (or <code>qwen2.5:14b</code> on a strong GPU) for chat, and <code>bge-m3</code> for embeddings.
            Changing the embedding model re-learns the whole knowledge base.
          </small>
          <small><Link to="/engine">Manage models, see download progress and where the files are →</Link></small>
        </div>

        <div className="row">
          <button className="primary">Save settings</button>
          <span className="ok">{saved}</span>
        </div>
      </form>
      <SalesHandoff />
      <Password />
    </div>
  );
}

function ModelState({ ai, model, ready }) {
  if (!ai?.online) return null;
  const d = ai.downloads?.find((x) => x.model === model && x.state !== 'done');
  if (d) return <DownloadProgress d={d} />;
  if (ready) return <small className="ok">✓ Installed</small>;
  return (
    <small className="warn">
      Not installed. <button type="button" className="link" onClick={() => api('/ai/pull', { method: 'POST', body: { model } })}>Download now</button>
    </small>
  );
}

function SalesHandoff() {
  const [h, setH] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api('/settings').then((s) => setH(s.sales_handoff));
  }, []);
  if (!h) return null;
  const team = h.team?.length ? h.team : [{ name: '', phone: '', email: '' }];
  const setMember = (i, k, v) => setH({ ...h, team: team.map((m, j) => (j === i ? { ...m, [k]: v } : m)) });
  const save = async (e) => {
    e.preventDefault();
    const clean = { ...h, team: team.filter((m) => m.name || m.phone || m.email), cooldown_hours: Number(h.cooldown_hours) || 24 };
    if (clean.enabled && !clean.team.length) return setMsg('⚠ Add at least one team member');
    setH((await api('/settings', { method: 'PUT', body: { sales_handoff: clean } })).sales_handoff);
    setMsg('✓ Saved');
    setTimeout(() => setMsg(''), 2000);
  };
  return (
    <form className="card stack" onSubmit={save}>
      <div className="card-head">
        <h3>Sales handoff</h3>
        <label className="switch"><input type="checkbox" checked={!!h.enabled} onChange={(e) => setH({ ...h, enabled: e.target.checked })} /><span>On</span></label>
      </div>
      <p className="muted small">
        When a customer wants to buy, the AI first asks what they need (product, quantity, budget, city). When they answer, it tells
        them the sales manager will contact them, and sends the customer's name, number and a short summary of what they need to these
        people on WhatsApp (and email if you add one). The customer is never given the sales team's own number. You can also send any
        chat by hand with "Send to sales" in the inbox.
      </p>
      <label>
        Hand off when the customer…
        <input dir="auto" value={h.when} onChange={(e) => setH({ ...h, when: e.target.value })} />
      </label>
      <div className="stack">
        <span className="label">Sales team</span>
        {team.map((m, i) => (
          <div key={i} className="team-row">
            <label>Name<input dir="auto" value={m.name} onChange={(e) => setMember(i, 'name', e.target.value)} placeholder="Rami" /></label>
            <label>WhatsApp number<input value={m.phone} onChange={(e) => setMember(i, 'phone', e.target.value)} placeholder="+971 55 123 4567" /></label>
            <label>Email (optional)<input value={m.email || ''} onChange={(e) => setMember(i, 'email', e.target.value)} placeholder="rami@company.com" /></label>
            <button type="button" className="danger" onClick={() => setH({ ...h, team: team.filter((_, j) => j !== i) })}>Remove</button>
          </div>
        ))}
        <div><button type="button" onClick={() => setH({ ...h, team: [...team, { name: '', phone: '', email: '' }] })}>+ Add person</button></div>
        <small className="muted">Include the country code. The lead is sent from your connected WhatsApp number, so WhatsApp must be connected under Channels. Messages from these numbers are never answered by the AI.</small>
      </div>
      <div className="grid2">
        <label>
          Write the summary in
          <select value={h.brief_language} onChange={(e) => setH({ ...h, brief_language: e.target.value })}>
            <option>English</option>
            <option>Arabic</option>
          </select>
        </label>
        <label>Don't send the same customer again for (hours)<input type="number" min="1" value={h.cooldown_hours} onChange={(e) => setH({ ...h, cooldown_hours: e.target.value })} /></label>
      </div>
      {msg && <div className={msg.startsWith('✓') ? 'ok' : 'error'}>{msg}</div>}
      <div><button className="primary">Save sales handoff</button></div>
    </form>
  );
}

function Password() {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [msg, setMsg] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      await api('/password', { method: 'POST', body: { current, next } });
      setMsg('✓ Password changed');
      setCurrent('');
      setNext('');
    } catch (err) {
      setMsg('⚠ ' + err.message);
    }
  };
  return (
    <form className="card stack" onSubmit={submit}>
      <h3>Change password</h3>
      <div className="grid2">
        <label>Current password<input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} /></label>
        <label>New password<input type="password" value={next} onChange={(e) => setNext(e.target.value)} /></label>
      </div>
      {msg && <div className={msg.startsWith('✓') ? 'ok' : 'error'}>{msg}</div>}
      <div><button className="primary">Change password</button></div>
    </form>
  );
}
