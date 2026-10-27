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
