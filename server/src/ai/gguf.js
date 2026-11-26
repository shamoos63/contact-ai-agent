import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// A later shard of a split GGUF. Ollama loads the set from the first file.
const LATER_SHARD = /-(?!00001-of-)\d{5}-of-\d{5}\.gguf$/i;

export function modelNameFromFile(filename) {
  const base = path.basename(filename).replace(/\.gguf$/i, '');
  const cleaned = base.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return `gguf-${cleaned || 'model'}`;
}

// Folders the dashboard scans. Inside Docker this is the mounted /gguf folder.
// On the computer itself it also looks in LM Studio's default models folder.
export function ggufRoots() {
  const roots = [];
  const seen = new Set();
  const add = (key, dir) => {
    if (!dir) return;
    let abs;
    try { abs = path.resolve(dir); } catch { return; }
    if (seen.has(abs) || !fs.existsSync(abs)) return;
    seen.add(abs);
    roots.push({ key, dir: abs });
  };
  if (process.env.GGUF_DIR) {
    add('gguf', process.env.GGUF_DIR);
    return roots;
  }
  add('gguf', '/gguf');
  add('project', path.resolve('gguf'));
  add('lmstudio', path.join(os.homedir(), '.lmstudio', 'models'));
  add('lmstudio', path.join(os.homedir(), '.cache', 'lm-studio', 'models'));
  return roots;
}

export function ggufFolderLabel() {
  if (process.env.GGUF_HOST_DIR) return process.env.GGUF_HOST_DIR;
  if (process.env.GGUF_DIR && process.env.GGUF_DIR !== '/gguf') return process.env.GGUF_DIR;
  return 'the gguf folder inside the contact-ai-agent project';
}

function walk(root, dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(root, full, out);
      continue;
    }
    if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.gguf')) continue;
    if (LATER_SHARD.test(entry.name)) continue;
    const rel = path.relative(root.dir, full).split(path.sep).join('/');
    let size = 0;
    try { size = fs.statSync(full).size; } catch { /* listed anyway */ }
    out.push({
      id: `${root.key}:${rel}`,
      name: entry.name,
      folder: path.posix.dirname(rel) === '.' ? '' : path.posix.dirname(rel),
      size,
      model: modelNameFromFile(entry.name),
    });
  }
}

export function listGguf() {
  const files = [];
  for (const root of ggufRoots()) walk(root, root.dir, files);
  files.sort((a, b) => a.name.localeCompare(b.name));
  return files;
}

// id is "rootKey:relative/path.gguf" from listGguf. Anything outside those folders is refused.
export function resolveGguf(id) {
  const text = String(id || '');
  const splitAt = text.indexOf(':');
  if (splitAt <= 0) return null;
  const key = text.slice(0, splitAt);
  const rel = text.slice(splitAt + 1);
  if (!rel || rel.includes('..') || rel.startsWith('/') || rel.includes('\\') || !rel.toLowerCase().endsWith('.gguf')) return null;
  const root = ggufRoots().find((r) => r.key === key);
  if (!root) return null;
  const full = path.resolve(root.dir, rel);
  const prefix = root.dir.endsWith(path.sep) ? root.dir : root.dir + path.sep;
  if (full !== root.dir && !full.startsWith(prefix)) return null;
  if (!fs.existsSync(full) || !fs.statSync(full).isFile()) return null;
  return { id, rel, file: full, root, model: modelNameFromFile(path.basename(full)) };
}

// Path Ollama itself can open. The app container sees /gguf; Ollama on this computer sees the real folder.
export function pathForOllama(resolved, ollamaUrl, hostDir = process.env.GGUF_HOST_DIR || '') {
  const rel = resolved.rel.split('\\').join('/');
  const mounted = resolved.root.dir === '/gguf' || resolved.root.dir === path.resolve('/gguf');
  const ollamaInDocker = /\/\/ollama[:/]/.test(ollamaUrl || '');
  if (ollamaInDocker && mounted) return `/gguf/${rel}`;
  if (hostDir && mounted) return `${hostDir.replace(/[\\/]+$/, '').replace(/\\/g, '/')}/${rel}`;
  return resolved.file;
}

export function modelfileFrom(filePath) {
  const quoted = String(filePath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `FROM "${quoted}"\n`;
}
