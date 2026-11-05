import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { api } from '../api.js';
import { PageHeader } from '../components/ui.jsx';

const NEW_TOPIC = { name: '', enabled: true, when: '', ask: '', keywords: '', team: [{ name: '', phone: '', email: '' }] };

export default function Handoff() {
  const [h, setH] = useState(null);
  const [msg, setMsg] = useState('');
  useEffect(() => {
    api('/settings').then((s) => setH(s.handoff));
  }, []);
  if (!h) return <div className="page"><PageHeader title="Team handoff" /></div>;

  const cats = h.categories || [];
  const setCat = (i, patch) => setH({ ...h, categories: cats.map((c, j) => (j === i ? { ...c, ...patch } : c)) });
  const team = (c) => (c.team?.length ? c.team : [{ name: '', phone: '', email: '' }]);
  const setMember = (i, k, key, v) => setCat(i, { team: team(cats[i]).map((m, j) => (j === k ? { ...m, [key]: v } : m)) });

  const save = async (e) => {
    e.preventDefault();
    const ready = cats.filter((c) => c.enabled !== false && (c.team || []).some((m) => m.phone || m.email));
    if (h.enabled && !ready.length) return setMsg('⚠ Add at least one person with a WhatsApp number or email to a topic');
    setH((await api('/settings', { method: 'PUT', body: { handoff: { ...h, cooldown_hours: Number(h.cooldown_hours) || 24 } } })).handoff);
    setMsg('✓ Saved');
    setTimeout(() => setMsg(''), 2000);
  };

  return (
    <form className="page" onSubmit={save}>
      <PageHeader
        title="Team handoff"
        subtitle="Requests the AI passes to a person. For each topic, the AI first asks the customer for the details you list, then sends the customer's name, number and a short summary to that topic's team on WhatsApp. The customer is never given your team's own number."
      />

      <div className="card stack">
        <div className="card-head">
          <h3>Handoff</h3>
          <label className="switch"><input type="checkbox" checked={!!h.enabled} onChange={(e) => setH({ ...h, enabled: e.target.checked })} /><span>On</span></label>
        </div>
        <div className="grid2">
          <label>
            Write the summary in
            <select value={h.brief_language} onChange={(e) => setH({ ...h, brief_language: e.target.value })}>
              <option>English</option>
              <option>Arabic</option>
            </select>
          </label>
          <label>Don't send the same customer for the same topic again for (hours)<input type="number" min="1" value={h.cooldown_hours} onChange={(e) => setH({ ...h, cooldown_hours: e.target.value })} /></label>
        </div>
        <small className="muted">Requests are sent from your connected WhatsApp number, so WhatsApp must be connected under Channels. Messages from team numbers are never answered by the AI. A topic with nobody in it is skipped.</small>
      </div>

      {cats.map((c, i) => (
        <div key={c.id || `new-${i}`} className="card stack">
          <div className="card-head">
            <input dir="auto" className="topic-name" placeholder="Topic name, e.g. Maintenance request" value={c.name} onChange={(e) => setCat(i, { name: e.target.value })} />
            <div className="row">
              <label className="switch"><input type="checkbox" checked={c.enabled !== false} onChange={(e) => setCat(i, { enabled: e.target.checked })} /><span>On</span></label>
              <button type="button" className="icon danger" title="Delete topic" onClick={() => confirm(`Delete "${c.name || 'this topic'}"?`) && setH({ ...h, categories: cats.filter((_, j) => j !== i) })}><Trash2 size={16} /></button>
            </div>
          </div>
          <label>
            Hand off when the customer…
            <input dir="auto" value={c.when} placeholder="needs a repair, maintenance or a technician visit" onChange={(e) => setCat(i, { when: e.target.value })} />
          </label>
          <label>
            First ask them for
            <input dir="auto" value={c.ask} placeholder="which device, what the problem is, their location" onChange={(e) => setCat(i, { ask: e.target.value })} />
          </label>
          <label>
            Keywords (optional)
            <input dir="auto" value={c.keywords || ''} placeholder="اشتري, شراء, سعر, بدي جهاز, buy, price" onChange={(e) => setCat(i, { keywords: e.target.value })} />
            <small className="muted">Comma separated. When a customer's message contains one of these, the AI always follows the handoff steps for this topic.</small>
          </label>
          <div className="stack">
            <span className="label">Send to</span>
            {team(c).map((m, k) => (
              <div key={k} className="team-row">
                <label>Name<input dir="auto" value={m.name} onChange={(e) => setMember(i, k, 'name', e.target.value)} placeholder="Rami" /></label>
                <label>WhatsApp number<input value={m.phone} onChange={(e) => setMember(i, k, 'phone', e.target.value)} placeholder="+971 55 123 4567" /></label>
                <label>Email (optional)<input value={m.email || ''} onChange={(e) => setMember(i, k, 'email', e.target.value)} placeholder="rami@company.com" /></label>
                <button type="button" className="danger" onClick={() => setCat(i, { team: team(c).filter((_, j) => j !== k) })}>Remove</button>
              </div>
            ))}
            <div><button type="button" onClick={() => setCat(i, { team: [...team(c), { name: '', phone: '', email: '' }] })}>+ Add person</button></div>
          </div>
        </div>
      ))}

      <div className="row">
        <button type="button" onClick={() => setH({ ...h, categories: [...cats, { ...NEW_TOPIC }] })}><Plus size={15} /> Add topic</button>
        <span className="grow" />
        {msg && <span className={msg.startsWith('✓') ? 'ok' : 'error'}>{msg}</span>}
        <button className="primary">Save</button>
      </div>
    </form>
  );
}
