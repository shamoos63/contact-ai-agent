import { CHANNELS, initials, formatBytes, formatDuration } from '../api.js';

export function PageHeader({ title, subtitle, actions }) {
  return (
    <header className="page-header">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="row">{actions}</div>}
    </header>
  );
}

export function Avatar({ name, channel, size = 40 }) {
  const ch = CHANNELS[channel];
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.38 }}>
      {initials(name)}
      {ch && <span className="avatar-badge" style={{ background: ch.color }} title={ch.label}>{ch.short}</span>}
    </span>
  );
}

export function ChannelTag({ channel }) {
  const ch = CHANNELS[channel];
  if (!ch) return null;
  return <span className="channel-tag" style={{ '--c': ch.color }}>{ch.label}</span>;
}

export function Pill({ tone = 'muted', children, title }) {
  return <span className={`pill ${tone}`} title={title}><span className="pill-dot" />{children}</span>;
}

export function ProgressBar({ value, indeterminate }) {
  return (
    <div className={`progress ${indeterminate ? 'indeterminate' : ''}`}>
      <div style={{ width: indeterminate ? undefined : `${Math.max(0, Math.min(100, value))}%` }} />
    </div>
  );
}

export function DownloadProgress({ d }) {
  const pct = d.total ? (d.completed / d.total) * 100 : 0;
  const eta = d.speed ? (d.total - d.completed) / d.speed : 0;
  const label = {
    downloading: d.total ? `${pct.toFixed(1)}%` : d.status,
    done: 'Installed',
    error: 'Failed',
    cancelled: 'Paused',
  }[d.state];
  return (
    <div className="download">
      <div className="row between">
        <strong>{d.model}</strong>
        <span className={d.state === 'error' ? 'error' : d.state === 'done' ? 'ok' : 'muted'}>{label}</span>
      </div>
      <ProgressBar value={d.state === 'done' ? 100 : pct} indeterminate={d.state === 'downloading' && !d.total} />
      <div className="row between small muted">
        <span>
          {d.total ? `${formatBytes(d.completed)} of ${formatBytes(d.total)}` : d.status}
          {d.state === 'downloading' && d.speed > 0 && ` · ${formatBytes(d.speed)}/s`}
        </span>
        {d.state === 'downloading' && eta > 0 && <span>{formatDuration(eta)} left</span>}
        {d.state === 'cancelled' && <span>Download again to resume where it stopped</span>}
      </div>
      {d.error && <div className="error small">{d.error}</div>}
    </div>
  );
}
