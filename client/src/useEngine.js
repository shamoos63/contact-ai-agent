import { useEffect, useState } from 'react';
import { api, getSocket } from './api.js';

// Live AI engine status: installed models, running downloads and where the files are.
export function useEngine(pollMs = 10000) {
  const [engine, setEngine] = useState(null);
  useEffect(() => {
    let alive = true;
    const load = () => api('/ai/status').then((s) => alive && setEngine(s)).catch(() => {});
    load();
    const timer = setInterval(load, pollMs);
    const socket = getSocket();
    const onDownloads = (downloads) => {
      setEngine((e) => (e ? { ...e, downloads } : e));
      if (downloads.some((d) => d.state === 'done')) load();
    };
    socket.on('model-downloads', onDownloads);
    return () => {
      alive = false;
      clearInterval(timer);
      socket.off('model-downloads', onDownloads);
    };
  }, [pollMs]);
  const reload = () => api('/ai/status').then(setEngine);
  return [engine, reload];
}
