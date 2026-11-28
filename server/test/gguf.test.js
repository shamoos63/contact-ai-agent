import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listGguf, modelNameFromFile, modelfileFrom, ollamaCreateBody, pathForOllama, resolveGguf } from '../src/ai/gguf.js';

test('gguf model names stay valid for Ollama', () => {
  assert.equal(modelNameFromFile('google_gemma-4-Q4_K_M.gguf'), 'gguf-google_gemma-4-q4_k_m');
  assert.equal(modelNameFromFile('My Model.GGUF'), 'gguf-my-model');
});

test('only gguf files inside the configured folder can be imported', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gguf-'));
  const previous = process.env.GGUF_DIR;
  process.env.GGUF_DIR = dir;
  try {
    fs.mkdirSync(path.join(dir, 'google'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'google', 'gemma-4-Q4_K_M.gguf'), 'not a real model');
    fs.writeFileSync(path.join(dir, 'google', 'gemma-4-Q4_K_M-00002-of-00002.gguf'), 'shard');
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'no');
    const files = listGguf();
    assert.equal(files.length, 1);
    assert.equal(files[0].name, 'gemma-4-Q4_K_M.gguf');
    assert.equal(files[0].model, 'gguf-gemma-4-q4_k_m');
    const resolved = resolveGguf(files[0].id);
    assert.equal(resolved.model, 'gguf-gemma-4-q4_k_m');
    assert.equal(resolveGguf('gguf:../secret.gguf'), null);
    assert.equal(resolveGguf('gguf:notes.txt'), null);
    assert.equal(pathForOllama(resolved, 'http://localhost:11434', '/host/models'), resolved.file);
  } finally {
    if (previous === undefined) delete process.env.GGUF_DIR;
    else process.env.GGUF_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('creating a model tells Ollama which GGUF file to read', () => {
  const body = ollamaCreateBody('gguf-gemma', '/gguf/google/gemma-4.gguf');
  assert.equal(body.from, '/gguf/google/gemma-4.gguf');
  assert.match(body.modelfile, /^FROM "\/gguf\/google\/gemma-4\.gguf"\n$/);
});

test('a GGUF on this computer is opened by its real path when Ollama is not in Docker', () => {
  const resolved = {
    rel: 'google/gemma-4.gguf',
    file: '/Users/me/.lmstudio/models/google/gemma-4.gguf',
    root: { key: 'lmstudio', dir: '/Users/me/.lmstudio/models' },
  };
  assert.equal(
    pathForOllama(resolved, 'http://host.docker.internal:11434', '/Users/me/.lmstudio/models'),
    resolved.file,
  );
  assert.equal(
    modelfileFrom(resolved.file),
    'FROM "/Users/me/.lmstudio/models/google/gemma-4.gguf"\n',
  );
});

test('Docker Ollama reads the mounted folder, and the Mac Ollama app reads the host folder', () => {
  const resolved = {
    rel: 'google/gemma-4.gguf',
    file: '/gguf/google/gemma-4.gguf',
    root: { key: 'gguf', dir: '/gguf' },
  };
  assert.equal(pathForOllama(resolved, 'http://ollama:11434', 'C:/Users/me/.lmstudio/models'), '/gguf/google/gemma-4.gguf');
  assert.equal(
    pathForOllama(resolved, 'http://host.docker.internal:11434', 'C:/Users/me/.lmstudio/models'),
    'C:/Users/me/.lmstudio/models/google/gemma-4.gguf',
  );
});
