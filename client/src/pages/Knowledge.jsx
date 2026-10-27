import { useEffect, useState } from 'react';
import { FileUp, Globe, PenLine, FlaskConical, BookOpen } from 'lucide-react';
import { api, getSocket, formatTime, formatBytes } from '../api.js';
import { PageHeader, Pill } from '../components/ui.jsx';

export default function Knowledge() {
  const [sources, setSources] = useState([]);
  const [tab, setTab] = useState('files');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [editing, setEditing] = useState(null);

  const load = () => api('/kb').then(setSources);
  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('kb', load);
    return () => socket.off('kb', load);
  }, []);

  const run = async (fn) => {
    setBusy(true);
    setNotice('');
    try {
      const result = await fn();
      const failed = Array.isArray(result) ? result.filter((r) => r.error) : [];
      if (failed.length) setNotice(failed.map((f) => `${f.name || f.url}: ${f.error}`).join('\n'));
      await load();
      return true;
    } catch (err) {
      setNotice(err.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = (s) => confirm(`Delete "${s.title}" from the knowledge base?`) && api(`/kb/${s.id}`, { method: 'DELETE' }).then(load);
  const refresh = (s) => run(() => api(`/kb/${s.id}/refresh`, { method: 'POST' }));
  const edit = async (s) => setEditing(await api(`/kb/${s.id}`));

  return (
    <div className="page">
      <PageHeader title="Knowledge base" subtitle="Everything the AI knows about your company. Add documents, web pages or typed notes in Arabic or English. The AI only answers from what is here." />

      <div className="card">
        <div className="tabs">
          {['files', 'url', 'text'].map((t) => (
            <button key={t} className={tab === t ? 'tab active' : 'tab'} onClick={() => setTab(t)}>
              {{ files: <><FileUp size={15} /> Upload documents</>, url: <><Globe size={15} /> Web pages</>, text: <><PenLine size={15} /> Write text</> }[t]}
            </button>
          ))}
        </div>
        {tab === 'files' && <FileForm busy={busy} onSubmit={(form) => run(() => api('/kb/files', { method: 'POST', form }))} />}
        {tab === 'url' && <UrlForm busy={busy} onSubmit={(url) => run(() => api('/kb/url', { method: 'POST', body: { url } }))} />}
        {tab === 'text' && <TextForm busy={busy} onSubmit={(body) => run(() => api('/kb/text', { method: 'POST', body }))} />}
        {notice && <pre className="error">{notice}</pre>}
      </div>

      <TestBox />

      <div className="table-wrap"><table className="table">
        <thead>
          <tr><th>Source</th><th>Type</th><th>Status</th><th>Added</th><th /></tr>
        </thead>
        <tbody>
          {sources.length === 0 && <tr><td colSpan="5"><div className="empty"><BookOpen size={28} /><p>Nothing yet. Add your first document above.</p></div></td></tr>}
          {sources.map((s) => (
            <tr key={s.id}>
              <td dir="auto">
                <strong>{s.title}</strong>
                {s.origin && s.type === 'url' && <div className="small"><a href={s.origin} target="_blank" rel="noreferrer">{s.origin}</a></div>}
              </td>
              <td><span className="tag-soft">{s.type}</span>{s.size > 0 && <div className="small muted">{formatBytes(s.size)} of text</div>}</td>
              <td>
                {s.status === 'ready' && <Pill tone="ok">Learned · {s.chunk_count} parts</Pill>}
                {s.status === 'pending' && <Pill tone="warn">Learning…</Pill>}
                {s.status === 'error' && <><Pill tone="error">Failed</Pill><div className="small error">{s.error}</div></>}
              </td>
              <td className="small muted">{formatTime(s.created_at)}</td>
              <td className="row">
                <button onClick={() => edit(s)}>Edit</button>
                {s.type === 'url' && <button onClick={() => refresh(s)}>Refresh</button>}
                <button className="danger" onClick={() => remove(s)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table></div>

      {editing && (
        <div className="modal" onClick={() => setEditing(null)}>
          <div className="card wide" onClick={(e) => e.stopPropagation()}>
            <h3>Edit source</h3>
            <TextForm
              busy={busy}
              initial={editing}
              submitLabel="Save and re-learn"
              onSubmit={async (body) => (await run(() => api(`/kb/${editing.id}`, { method: 'PUT', body }))) && setEditing(null)}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function FileForm({ busy, onSubmit }) {
  const [files, setFiles] = useState([]);
  const submit = async (e) => {
    e.preventDefault();
    const form = new FormData();
    for (const f of files) form.append('files', f);
    if (await onSubmit(form)) { setFiles([]); e.target.reset(); }
  };
  return (
    <form onSubmit={submit} className="stack">
      <input type="file" multiple accept=".pdf,.docx,.txt,.md,.csv,.html,.htm" onChange={(e) => setFiles([...e.target.files])} />
      <small className="muted">PDF, Word (.docx), text, Markdown, CSV or HTML. Up to 20 files at once.</small>
      <button className="primary" disabled={busy || !files.length}>{busy ? 'Uploading…' : 'Upload'}</button>
    </form>
  );
}

function UrlForm({ busy, onSubmit }) {
  const [url, setUrl] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    if (await onSubmit(url)) setUrl('');
  };
  return (
    <form onSubmit={submit} className="stack">
      <textarea rows="3" placeholder={'https://example.com/about\nhttps://example.com/pricing'} value={url} onChange={(e) => setUrl(e.target.value)} />
      <small className="muted">One or more page addresses, one per line.</small>
      <button className="primary" disabled={busy || !url.trim()}>{busy ? 'Reading pages…' : 'Add pages'}</button>
    </form>
  );
}

function TextForm({ busy, onSubmit, initial, submitLabel = 'Add' }) {
  const [title, setTitle] = useState(initial?.title || '');
  const [content, setContent] = useState(initial?.content || '');
  const submit = async (e) => {
    e.preventDefault();
    if ((await onSubmit({ title, content })) && !initial) { setTitle(''); setContent(''); }
  };
  return (
    <form onSubmit={submit} className="stack">
      <input dir="auto" placeholder="Title, e.g. Opening hours / ساعات العمل" value={title} onChange={(e) => setTitle(e.target.value)} />
      <textarea dir="auto" rows="8" placeholder="Write anything the AI should know: FAQs, prices, policies, addresses…" value={content} onChange={(e) => setContent(e.target.value)} />
      <button className="primary" disabled={busy || !title.trim() || !content.trim()}>{submitLabel}</button>
    </form>
  );
}

function TestBox() {
  const [question, setQuestion] = useState('');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const ask = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      setResult(await api('/kb-test', { method: 'POST', body: { question } }));
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="card">
      <h3><FlaskConical size={16} /> Try it</h3>
      <form className="row" onSubmit={ask}>
        <input dir="auto" className="grow" placeholder="Ask like a customer would, e.g. ما هي أسعاركم؟" value={question} onChange={(e) => setQuestion(e.target.value)} />
        <button className="primary" disabled={busy || !question.trim()}>{busy ? 'Thinking…' : 'Ask'}</button>
      </form>
      {result?.error && <div className="error">{result.error}</div>}
      {result?.reply && (
        <div className="test-result">
          <div className="bubble" dir="auto">{result.reply}</div>
          <div className="small muted">
            Used: {result.sources.length ? result.sources.map((s) => `${s.title} (${Math.round(s.score * 100)}%)`).join(', ') : 'no knowledge matched'}
          </div>
        </div>
      )}
    </div>
  );
}
