import { useEffect, useState } from 'react';
import { Download, Trash2, FolderOpen, Copy, Check, Pause, Cpu, Gauge } from 'lucide-react';
import { api, formatBytes } from '../api.js';
import { useEngine } from '../useEngine.js';
import { PageHeader, Pill, DownloadProgress } from '../components/ui.jsx';

export default function Engine() {
  const [engine, reload] = useEngine(5000);
  const [settings, setSettings] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api('/settings').then(setSettings);
  }, []);

  if (!engine || !settings) return <div className="center muted">Loading…</div>;

  const inUse = (name) => [settings.chat_model, settings.embed_model].some((m) => m === name || `${m}:latest` === name);
  const installed = (name) => engine.installed.some((m) => m.name === name || m.name === `${name}:latest`);
  const downloading = (name) => engine.downloads.some((d) => d.model === name && d.state === 'downloading');
  const totalSize = engine.installed.reduce((s, m) => s + (m.size || 0), 0);
  const activeDownloads = engine.downloads.filter((d) => d.state !== 'done' || Date.now() - d.finishedAt < 60000);

  const act = async (fn) => {
    setError('');
    try {
      await fn();
      reload();
    } catch (err) {
      setError(err.message);
    }
  };
  const pull = (model) => act(() => api('/ai/pull', { method: 'POST', body: { model } }));
  const cancel = (model) => act(() => api('/ai/cancel', { method: 'POST', body: { model } }));
  const remove = (model) => confirm(`Delete ${model} from this computer?`) && act(() => api(`/ai/models/${encodeURIComponent(model)}`, { method: 'DELETE' }));
  const use = async (model, kind) => {
    const key = kind === 'chat' ? 'chat_model' : 'embed_model';
    if (kind === 'embed' && !confirm('Switching the search model re-learns the whole knowledge base. Continue?')) return;
    setSettings(await api('/settings', { method: 'PUT', body: { [key]: model } }));
  };

  return (
    <div className="page">
      <PageHeader
        title="AI engine"
        subtitle="The local AI models that read your knowledge base and write the replies. Everything runs on this computer."
        actions={engine.online ? <Pill tone="ok">Ollama running</Pill> : <Pill tone="error" title={engine.error}>Ollama not reachable</Pill>}
      />
      {error && <div className="alert error">{error}</div>}

      <div className="grid3">
        <div className="card stat">
          <span className="muted small">Chat model</span>
          <strong>{settings.chat_model}</strong>
          <span className={engine.chatModelReady ? 'ok small' : 'warn small'}>{engine.chatModelReady ? 'Installed' : 'Not installed'}</span>
        </div>
        <div className="card stat">
          <span className="muted small">Knowledge search model</span>
          <strong>{settings.embed_model}</strong>
          <span className={engine.embedModelReady ? 'ok small' : 'warn small'}>{engine.embedModelReady ? 'Installed' : 'Not installed'}</span>
        </div>
        <div className="card stat">
          <span className="muted small">Disk space used</span>
          <strong>{formatBytes(totalSize)}</strong>
          <span className="muted small">{engine.installed.length} model{engine.installed.length === 1 ? '' : 's'} installed</span>
        </div>
      </div>

      {engine.online && <SpeedCard engine={engine} chatModel={settings.chat_model} />}

      {activeDownloads.length > 0 && (
        <section className="card">
          <h3><Download size={16} /> Downloads</h3>
          <div className="stack">
            {activeDownloads.map((d) => (
              <div key={d.model} className="row download-row">
                <div className="grow"><DownloadProgress d={d} /></div>
                {d.state === 'downloading' && <button onClick={() => cancel(d.model)} title="Pause"><Pause size={14} /> Pause</button>}
                {(d.state === 'cancelled' || d.state === 'error') && <button onClick={() => pull(d.model)}><Download size={14} /> Resume</button>}
              </div>
            ))}
          </div>
        </section>
      )}

      <section className="card">
        <h3><Cpu size={16} /> Installed models</h3>
        {engine.installed.length === 0 ? (
          <p className="muted">No models yet. Download one from the list below.</p>
        ) : (
          <table className="table flat">
            <thead><tr><th>Model</th><th>Size</th><th>Details</th><th /></tr></thead>
            <tbody>
              {engine.installed.map((m) => (
                <tr key={m.name}>
                  <td><strong>{m.name}</strong> {inUse(m.name) && <span className="tag-soft">In use</span>}</td>
                  <td>{formatBytes(m.size)}</td>
                  <td className="muted small">{[m.parameters && `${m.parameters} parameters`, m.quantization].filter(Boolean).join(' · ')}</td>
                  <td className="right">
                    {!inUse(m.name) && <button className="icon danger" onClick={() => remove(m.name)} title="Delete"><Trash2 size={15} /></button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h3><Download size={16} /> Suggested models</h3>
        <p className="muted small">Sizes are approximate download sizes. The exact size shows as soon as a download starts.</p>
        <table className="table flat">
          <thead><tr><th>Model</th><th>Used for</th><th>Size</th><th /></tr></thead>
          <tbody>
            {engine.catalog.map((m) => (
              <tr key={m.name}>
                <td><strong>{m.name}</strong><div className="small muted">{m.note}</div></td>
                <td>{m.kind === 'chat' ? 'Writing replies' : 'Knowledge search'}</td>
                <td>≈ {formatBytes(m.size)}</td>
                <td className="right nowrap">
                  {installed(m.name) ? (
                    inUse(m.name) ? <span className="ok small"><Check size={14} /> In use</span>
                      : <button onClick={() => use(m.name, m.kind)}>Use this</button>
                  ) : downloading(m.name) ? (
                    <span className="muted small">Downloading…</span>
                  ) : (
                    <button className="primary" disabled={!engine.online} onClick={() => pull(m.name)}><Download size={14} /> Download</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <CustomModel onPull={pull} disabled={!engine.online} />
      </section>

      <FilesCard path={engine.modelsPath} />
    </div>
  );
}

function CustomModel({ onPull, disabled }) {
  const [name, setName] = useState('');
  return (
    <form className="row custom-model" onSubmit={(e) => { e.preventDefault(); onPull(name.trim()); setName(''); }}>
      <input className="grow" placeholder="Any other model from ollama.com/library, e.g. gemma2:9b" value={name} onChange={(e) => setName(e.target.value)} />
      <button disabled={disabled || !name.trim()}><Download size={14} /> Download</button>
    </form>
  );
}

function FilesCard({ path }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    await navigator.clipboard?.writeText(path);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  return (
    <section className="card">
      <h3><FolderOpen size={16} /> Where the model files are</h3>
      <div className="path-box">
        <code>{path}</code>
        <button className="icon" onClick={copy} title="Copy">{copied ? <Check size={15} /> : <Copy size={15} />}</button>
      </div>
      <div className="steps">
        <p><strong>To move the models to another computer</strong> (so it doesn't have to download them again):</p>
        <ol>
          <li>Stop the app on this computer: <code>docker compose down</code></li>
          <li>Copy the whole <code>ollama-models</code> folder (with its <code>blobs</code> and <code>manifests</code> folders inside) to a USB drive.</li>
          <li>On the other computer, put it inside the contact-ai-agent project folder, then run <code>docker compose up -d</code>. The models appear here as installed.</li>
        </ol>
        <p className="muted small">
          If Ollama is installed directly on the other computer (not in Docker), copy the contents into its models folder instead:
          <code>%USERPROFILE%\.ollama\models</code> on Windows or <code>~/.ollama/models</code> on Mac and Linux.
        </p>
      </div>
    </section>
  );
}

const secs = (ms) => `${(ms / 1000).toFixed(1)}s`;

function SpeedCard({ engine, chatModel }) {
  const chat = engine.loaded?.find((m) => m.name === chatModel || m.name === `${chatModel}:latest`);
  const last = engine.timings?.[0];
  const where = !chat ? null : chat.gpuPercent >= 90 ? ['ok', 'Graphics card (GPU)'] : chat.gpuPercent > 0 ? ['warn', `Partly on GPU (${chat.gpuPercent}%)`] : ['error', 'Processor only (CPU), slow'];
  const tips = [];
  if (chat && chat.gpuPercent < 90) {
    tips.push('The model is running on the processor. A graphics card makes replies 5 to 20 times faster. See "Making replies faster" in the README: on Windows the easiest way is to install the Ollama app directly, which uses your NVIDIA or AMD card automatically.');
  }
  if (last && last.loadMs > 10000) tips.push(`Loading the model took ${secs(last.loadMs)}. That happens once; the model now stays in memory for 24 hours between messages.`);
  if (last && last.tokensPerSecond && last.tokensPerSecond < 8) tips.push(`The model writes ${last.tokensPerSecond} tokens (word pieces) per second. A smaller model like qwen2.5:3b is about twice as fast, with simpler answers.`);
  return (
    <section className="card">
      <h3><Gauge size={16} /> Speed</h3>
      <div className="list">
        <div className="list-row">
          <span className="grow">Chat model running on</span>
          {where ? <span className={where[0]}>{where[1]}</span> : <span className="muted">Not loaded yet (loads with the first message)</span>}
        </div>
        {last && (
          <div className="list-row">
            <span className="grow">Last reply took</span>
            <strong>{secs(last.totalMs)}</strong>
          </div>
        )}
      </div>
      {engine.timings?.length > 0 && (
        <table className="table flat timings">
          <thead><tr><th>When</th><th>Total</th><th>Loading model</th><th>Reading question</th><th>Writing answer</th></tr></thead>
          <tbody>
            {engine.timings.slice(0, 5).map((t) => (
              <tr key={t.at}>
                <td className="muted small">{new Date(t.at).toLocaleTimeString()}</td>
                <td><strong>{secs(t.totalMs)}</strong></td>
                <td>{secs(t.loadMs)}</td>
                <td>{secs(t.promptMs)} <span className="muted small">({t.promptTokens} tokens)</span></td>
                <td>{secs(t.outputMs)} <span className="muted small">({t.tokensPerSecond}/s)</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {tips.map((t) => <div key={t} className="alert warn small">{t}</div>)}
    </section>
  );
}
