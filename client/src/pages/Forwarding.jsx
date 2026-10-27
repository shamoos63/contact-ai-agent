import { useEffect, useState } from 'react';
import { Forward, FlaskConical, Sparkles, Type } from 'lucide-react';
import { api } from '../api.js';
import { PageHeader, Pill } from '../components/ui.jsx';

const EMPTY = { name: '', match_type: 'keywords', match_text: '', match_field: 'any', forward_to: '', account_id: '', ai_reply: true, include_attachments: true, enabled: true };
const FIELDS = { any: 'anywhere', from: 'the sender', subject: 'the subject', body: 'the message' };

export default function Forwarding() {
  const [rules, setRules] = useState([]);
  const [accounts, setAccounts] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');

  const load = () => api('/email-rules').then(setRules);
  useEffect(() => {
    load();
    api('/email-accounts').then(setAccounts);
  }, []);

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (form.id) await api(`/email-rules/${form.id}`, { method: 'PUT', body: form });
      else await api('/email-rules', { method: 'POST', body: form });
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  const edit = (r) => setForm({ ...r, account_id: r.account_id || '', ai_reply: !!r.ai_reply, include_attachments: !!r.include_attachments, enabled: !!r.enabled });
  const toggle = (r) => api(`/email-rules/${r.id}`, { method: 'PUT', body: { ...r, enabled: !r.enabled } }).then(load);
  const remove = (r) => confirm(`Delete the rule "${r.name}"?`) && api(`/email-rules/${r.id}`, { method: 'DELETE' }).then(load);
  const accountName = (id) => accounts.find((a) => a.id === id)?.email || 'deleted account';

  return (
    <div className="page">
      <PageHeader
        title="Email forwarding"
        subtitle="Send incoming emails to the right person in your team. When an email matches a rule, it is forwarded with its attachments, and the customer can still get an AI answer."
      />

      <form className="card stack" onSubmit={save}>
        <h3>{form.id ? 'Edit rule' : 'New rule'}</h3>
        <label>Name<input dir="auto" placeholder="Invoices to accounting" value={form.name} onChange={set('name')} /></label>

        <div className="stack">
          <span className="label">How to recognise the emails</span>
          <div className="choice">
            <button type="button" className={form.match_type === 'keywords' ? 'active' : ''} onClick={() => setForm({ ...form, match_type: 'keywords' })}>
              <Type size={16} /> <span><strong>Keywords</strong><small>Instant. Matches exact words.</small></span>
            </button>
            <button type="button" className={form.match_type === 'ai' ? 'active' : ''} onClick={() => setForm({ ...form, match_type: 'ai' })}>
              <Sparkles size={16} /> <span><strong>Let the AI decide</strong><small>Understands meaning in any language. Slower.</small></span>
            </button>
          </div>
        </div>

        {form.match_type === 'keywords' ? (
          <div className="grid2">
            <label>Keywords (comma separated)<input dir="auto" placeholder="invoice, payment, فاتورة, دفع" value={form.match_text} onChange={set('match_text')} /></label>
            <label>
              Look in
              <select value={form.match_field} onChange={set('match_field')}>
                {Object.entries(FIELDS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </label>
          </div>
        ) : (
          <label>
            Which emails should be forwarded?
            <textarea dir="auto" rows="2" placeholder="Job applications and CVs, or anyone asking to work with us" value={form.match_text} onChange={set('match_text')} />
          </label>
        )}

        <div className="grid2">
          <label>Forward to (one or more addresses)<input placeholder="accounting@yourcompany.com, manager@yourcompany.com" value={form.forward_to} onChange={set('forward_to')} /></label>
          <label>
            For emails arriving at
            <select value={form.account_id} onChange={set('account_id')}>
              <option value="">All email accounts</option>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
            </select>
          </label>
        </div>
        <div className="row">
          <label className="switch"><input type="checkbox" checked={form.ai_reply} onChange={set('ai_reply')} /><span>AI still replies to the customer</span></label>
          <label className="switch"><input type="checkbox" checked={form.include_attachments} onChange={set('include_attachments')} /><span>Include attachments</span></label>
        </div>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button className="primary">{form.id ? 'Save' : 'Add rule'}</button>
          {form.id && <button type="button" onClick={() => setForm(EMPTY)}>Cancel</button>}
        </div>
      </form>

      <TestBox accounts={accounts} />

      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>On</th><th>Rule</th><th>When</th><th>Forward to</th><th>Then</th><th /></tr></thead>
          <tbody>
            {rules.length === 0 && <tr><td colSpan="6"><div className="empty"><Forward size={28} /><p>No forwarding rules yet.</p></div></td></tr>}
            {rules.map((r) => (
              <tr key={r.id} className={r.enabled ? '' : 'muted'}>
                <td><input type="checkbox" checked={!!r.enabled} onChange={() => toggle(r)} /></td>
                <td dir="auto">
                  <strong>{r.name}</strong>
                  <div className="small muted">{r.account_id ? accountName(r.account_id) : 'All accounts'}</div>
                </td>
                <td dir="auto">
                  {r.match_type === 'ai' ? <><span className="tag-soft">AI</span> {r.match_text}</> : <>Has <em>{r.match_text}</em> in {FIELDS[r.match_field]}</>}
                </td>
                <td className="small">{r.forward_to}</td>
                <td>{r.ai_reply ? <Pill tone="ok">AI replies too</Pill> : <Pill tone="muted">Team only</Pill>}</td>
                <td className="row">
                  <button onClick={() => edit(r)}>Edit</button>
                  <button className="danger" onClick={() => remove(r)}>Delete</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function TestBox({ accounts }) {
  const [t, setT] = useState({ from: '', subject: '', text: '', account_id: '' });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setT({ ...t, [k]: e.target.value });
  const run = async (e) => {
    e.preventDefault();
    setBusy(true);
    setResult(null);
    try {
      setResult(await api('/email-rules/test', { method: 'POST', body: t }));
    } catch (err) {
      setResult({ error: err.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="card stack" onSubmit={run}>
      <h3><FlaskConical size={16} /> Try a sample email</h3>
      <div className="grid2">
        <label>From<input placeholder="customer@example.com" value={t.from} onChange={set('from')} /></label>
        <label>Subject<input dir="auto" value={t.subject} onChange={set('subject')} /></label>
      </div>
      <label>Message<textarea dir="auto" rows="3" value={t.text} onChange={set('text')} /></label>
      <div className="row">
        {accounts.length > 1 && (
          <select className="grow" value={t.account_id} onChange={set('account_id')}>
            <option value="">Any account</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.email}</option>)}
          </select>
        )}
        <button className="primary" disabled={busy || !(t.subject || t.text)}>{busy ? 'Checking…' : 'Check rules'}</button>
      </div>
      {result?.error && <div className="error">{result.error}</div>}
      {Array.isArray(result) && (result.length === 0
        ? <div className="muted">No rule matches. The email stays in the inbox and the AI answers as usual.</div>
        : result.map((r) => <div key={r.id} className="ok">✓ "{r.name}" → forwarded to {r.forward_to}{r.ai_reply ? ', and the AI replies' : ', no AI reply'}</div>))}
    </form>
  );
}
