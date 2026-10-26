import { useEffect, useState } from 'react';
import { api } from '../api.js';

const EMPTY = { name: '', when_text: '', value: '', enabled: true };

export default function Redirects() {
  const [rules, setRules] = useState([]);
  const [form, setForm] = useState(EMPTY);
  const [error, setError] = useState('');

  const load = () => api('/redirects').then(setRules);
  useEffect(() => { load(); }, []);

  const save = async (e) => {
    e.preventDefault();
    setError('');
    try {
      if (form.id) await api(`/redirects/${form.id}`, { method: 'PUT', body: form });
      else await api('/redirects', { method: 'POST', body: form });
      setForm(EMPTY);
      load();
    } catch (err) {
      setError(err.message);
    }
  };
  const toggle = (r) => api(`/redirects/${r.id}`, { method: 'PUT', body: { ...r, enabled: !r.enabled } }).then(load);
  const remove = (r) => confirm(`Delete "${r.name}"?`) && api(`/redirects/${r.id}`, { method: 'DELETE' }).then(load);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="page">
      <h2>Redirects</h2>
      <p className="muted">Tell the AI where to send customers. When a customer's message matches a rule, the AI includes the link or phone number in its reply.</p>

      <form className="card stack" onSubmit={save}>
        <h3>{form.id ? 'Edit rule' : 'New rule'}</h3>
        <label>Name<input dir="auto" placeholder="Sales team" value={form.name} onChange={set('name')} /></label>
        <label>When the customer…<input dir="auto" placeholder="wants to buy, asks for a quote, or wants to talk to sales" value={form.when_text} onChange={set('when_text')} /></label>
        <label>Send them<input dir="auto" placeholder="https://wa.me/9715xxxxxxx or +971 5x xxx xxxx" value={form.value} onChange={set('value')} /></label>
        {error && <div className="error">{error}</div>}
        <div className="row">
          <button className="primary">{form.id ? 'Save' : 'Add rule'}</button>
          {form.id && <button type="button" onClick={() => setForm(EMPTY)}>Cancel</button>}
        </div>
      </form>

      <table className="table">
        <thead><tr><th>On</th><th>Name</th><th>When</th><th>Send</th><th /></tr></thead>
        <tbody>
          {rules.length === 0 && <tr><td colSpan="5" className="muted">No rules yet.</td></tr>}
          {rules.map((r) => (
            <tr key={r.id} className={r.enabled ? '' : 'muted'}>
              <td><input type="checkbox" checked={!!r.enabled} onChange={() => toggle(r)} /></td>
              <td dir="auto"><strong>{r.name}</strong></td>
              <td dir="auto">{r.when_text}</td>
              <td dir="auto">{r.value}</td>
              <td className="row">
                <button onClick={() => setForm({ ...r, enabled: !!r.enabled })}>Edit</button>
                <button className="danger" onClick={() => remove(r)}>Delete</button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
