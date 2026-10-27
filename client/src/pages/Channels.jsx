import { useEffect, useState } from 'react';
import { api, getSocket, CHANNELS } from '../api.js';
import { PageHeader } from '../components/ui.jsx';
import { StatusPill } from './Overview.jsx';

export default function Channels() {
  const [status, setStatus] = useState(null);
  const [settings, setSettings] = useState(null);

  const load = () => {
    api('/channels').then(setStatus);
    api('/settings').then(setSettings);
  };
  useEffect(() => {
    load();
    const socket = getSocket();
    socket.on('channels', setStatus);
    return () => socket.off('channels', setStatus);
  }, []);

  if (!status || !settings) return <div className="center muted">Loading…</div>;

  const save = async (patch) => setSettings(await api('/settings', { method: 'PUT', body: patch }));

  return (
    <div className="page">
      <PageHeader title="Channels" subtitle="Connect the places your customers write to you. Every message lands in the shared inbox." />
      <WhatsApp status={status.whatsapp} settings={settings.whatsapp} save={save} />
      <Telegram status={status.telegram} settings={settings.telegram} save={save} />
      <Email accounts={status.email} reload={load} />
      <Meta status={status.meta} settings={settings.meta} save={save} />
    </div>
  );
}

function Status({ value, error }) {
  return (
    <span className="row">
      <StatusPill status={value} error={error} />
      {error && value !== 'connected' && <span className="small error">{error}</span>}
    </span>
  );
}

function Title({ channel, children }) {
  const ch = CHANNELS[channel];
  return <h3 className="row"><span className="channel-dot" style={{ background: ch.color }}>{ch.short}</span>{children}</h3>;
}

function WhatsApp({ status, settings, save }) {
  return (
    <div className="card">
      <div className="card-head">
        <Title channel="whatsapp">WhatsApp</Title>
        <Status value={status.status} error={status.error} />
      </div>
      <p className="muted small">Links like WhatsApp Web. Use a separate business number: WhatsApp can ban numbers it thinks are automated.</p>
      <label className="switch">
        <input type="checkbox" checked={!!settings.enabled} onChange={(e) => save({ whatsapp: { enabled: e.target.checked } })} />
        <span>Enabled</span>
      </label>
      {status.status === 'qr' && status.qr && (
        <div className="qr">
          <img src={status.qr} alt="WhatsApp QR code" />
          <div className="small muted">On the phone: WhatsApp → Settings → Linked devices → Link a device, then scan.</div>
        </div>
      )}
      {status.status === 'connected' && <p>Linked as <strong>{status.me}</strong></p>}
      {settings.enabled && (
        <div className="row">
          <button onClick={() => api('/channels/whatsapp/restart', { method: 'POST' })}>Reconnect</button>
          <button className="danger" onClick={() => confirm('Unlink this WhatsApp number?') && api('/channels/whatsapp/logout', { method: 'POST' })}>Unlink number</button>
        </div>
      )}
    </div>
  );
}

function Telegram({ status, settings, save }) {
  const [token, setToken] = useState(settings.token);
  return (
    <div className="card">
      <div className="card-head">
        <Title channel="telegram">Telegram bot</Title>
        <Status value={status.status} error={status.error} />
      </div>
      <p className="muted small">Create a bot with <a href="https://t.me/BotFather" target="_blank" rel="noreferrer">@BotFather</a> (send /newbot) and paste its token here.</p>
      {status.username && <p>Customers can message <a href={`https://t.me/${status.username}`} target="_blank" rel="noreferrer">@{status.username}</a></p>}
      <div className="row">
        <input className="grow" placeholder="123456789:ABC…" value={token} onChange={(e) => setToken(e.target.value)} />
        <label className="switch">
          <input type="checkbox" checked={!!settings.enabled} onChange={(e) => save({ telegram: { token, enabled: e.target.checked } })} />
          <span>Enabled</span>
        </label>
        <button className="primary" onClick={() => save({ telegram: { token, enabled: true } })}>Save & connect</button>
      </div>
    </div>
  );
}

const NEW_ACCOUNT = { name: '', email: '', username: '', password: '', imap_host: '', imap_port: 993, imap_secure: true, smtp_host: '', smtp_port: 465, smtp_secure: true, enabled: true };

function Email({ accounts, reload }) {
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  const gmail = () => setForm({ ...form, imap_host: 'imap.gmail.com', imap_port: 993, imap_secure: true, smtp_host: 'smtp.gmail.com', smtp_port: 465, smtp_secure: true });
  const test = async () => {
    setMsg('Testing…');
    try {
      await api('/email-accounts/test', { method: 'POST', body: form });
      setMsg('✓ Login to both servers worked');
    } catch (err) {
      setMsg('⚠ ' + err.message);
    }
  };
  const submit = async (e) => {
    e.preventDefault();
    try {
      if (form.id) await api(`/email-accounts/${form.id}`, { method: 'PUT', body: form });
      else await api('/email-accounts', { method: 'POST', body: form });
      setForm(null);
      setMsg('');
      reload();
    } catch (err) {
      setMsg('⚠ ' + err.message);
    }
  };
  const remove = (a) => confirm(`Remove ${a.email}?`) && api(`/email-accounts/${a.id}`, { method: 'DELETE' }).then(reload);

  return (
    <div className="card">
      <div className="card-head">
        <Title channel="email">Email</Title>
        <button onClick={() => { setForm(NEW_ACCOUNT); setMsg(''); }}>+ Add account</button>
      </div>
      <p className="muted small">Gmail or any domain mailbox via IMAP and SMTP. For Gmail, turn on 2-step verification and use an <a href="https://myaccount.google.com/apppasswords" target="_blank" rel="noreferrer">app password</a>. Only emails that arrive after you connect are answered.</p>
      {accounts.map((a) => (
        <div key={a.id} className="row between account">
          <div><strong>{a.email}</strong> <span className="muted small">{a.imap_host}</span></div>
          <div className="row">
            <Status value={a.status} error={a.error} />
            <button onClick={() => { setForm({ ...a, imap_secure: !!a.imap_secure, smtp_secure: !!a.smtp_secure, enabled: !!a.enabled }); setMsg(''); }}>Edit</button>
            <button className="danger" onClick={() => remove(a)}>Remove</button>
          </div>
        </div>
      ))}
      {form && (
        <form className="stack email-form" onSubmit={submit}>
          <div className="row"><button type="button" onClick={gmail}>Use Gmail settings</button></div>
          <div className="grid2">
            <label>Email address<input value={form.email} onChange={set('email')} placeholder="support@yourcompany.com" /></label>
            <label>Sender name<input dir="auto" value={form.name} onChange={set('name')} placeholder="Your Company Support" /></label>
            <label>Login username<input value={form.username} onChange={set('username')} placeholder="usually the email address" /></label>
            <label>Password / app password<input type="password" value={form.password} onChange={set('password')} /></label>
            <label>IMAP server<input value={form.imap_host} onChange={set('imap_host')} placeholder="mail.yourcompany.com" /></label>
            <label>IMAP port<input type="number" value={form.imap_port} onChange={set('imap_port')} /></label>
            <label>SMTP server<input value={form.smtp_host} onChange={set('smtp_host')} placeholder="mail.yourcompany.com" /></label>
            <label>SMTP port<input type="number" value={form.smtp_port} onChange={set('smtp_port')} /></label>
          </div>
          <div className="row">
            <label className="switch"><input type="checkbox" checked={form.imap_secure} onChange={set('imap_secure')} /><span>IMAP SSL</span></label>
            <label className="switch"><input type="checkbox" checked={form.smtp_secure} onChange={set('smtp_secure')} /><span>SMTP SSL (off for port 587)</span></label>
            <label className="switch"><input type="checkbox" checked={form.enabled} onChange={set('enabled')} /><span>Enabled</span></label>
          </div>
          {msg && <div className={msg.startsWith('✓') ? 'ok' : 'error'}>{msg}</div>}
          <div className="row">
            <button type="button" onClick={test}>Test connection</button>
            <button className="primary">Save</button>
            <button type="button" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </form>
      )}
    </div>
  );
}

function Meta({ status, settings, save }) {
  const [form, setForm] = useState(settings);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const webhook = `${window.location.origin}/webhooks/meta`;
  return (
    <div className="card">
      <div className="card-head">
        <Title channel="facebook">Facebook & Instagram</Title>
        <Status value={status.status} />
      </div>
      <p className="muted small">
        Uses the official Meta Graph API. You need a Meta developer app with the Messenger (and Instagram) product, a Facebook Page linked to
        your Instagram business account, and a public address for this server (for example a free Cloudflare Tunnel). See the README for the steps.
      </p>
      <div className="grid2">
        <label>Page ID<input value={form.page_id} onChange={set('page_id')} /></label>
        <label>Page access token<input type="password" value={form.page_token} onChange={set('page_token')} /></label>
        <label>App secret<input type="password" value={form.app_secret} onChange={set('app_secret')} /></label>
        <label>Webhook verify token (any text you choose)<input value={form.verify_token} onChange={set('verify_token')} /></label>
      </div>
      <p className="small">Webhook URL to paste in Meta: <code>{'https://<your-tunnel-domain>/webhooks/meta'}</code> <span className="muted">(locally: {webhook})</span></p>
      <div className="row">
        <label className="switch"><input type="checkbox" checked={!!form.enabled} onChange={set('enabled')} /><span>Facebook Messenger</span></label>
        <label className="switch"><input type="checkbox" checked={!!form.instagram_enabled} onChange={set('instagram_enabled')} /><span>Instagram Direct</span></label>
        <button className="primary" onClick={() => save({ meta: form })}>Save</button>
      </div>
      {status.missing && <div className="small muted">Still needed: {status.missing.join(', ')}</div>}
    </div>
  );
}
