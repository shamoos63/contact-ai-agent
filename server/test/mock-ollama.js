// A tiny stand-in for Ollama used by the tests: bag-of-words embeddings and an echo chat.
import http from 'node:http';

const DIM = 64;
function vec(text) {
  const v = new Array(DIM).fill(0);
  for (const w of text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean)) {
    let h = 0;
    for (const c of w) h = (h * 31 + c.codePointAt(0)) >>> 0;
    v[h % DIM] += 1;
  }
  return v;
}

export function startMockOllama() {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    calls.push({ path: req.url, data });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b' }, { name: 'bge-m3:latest' }] }));
    if (req.url === '/api/embed') return res.end(JSON.stringify({ embeddings: data.input.map(vec) }));
    if (req.url === '/api/chat') {
      const system = data.messages[0].content;
      const knows = system.includes('9am to 6pm');
      return res.end(JSON.stringify({ message: { role: 'assistant', content: knows ? 'We are open 9am to 6pm.' : 'I am not sure.' } }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
