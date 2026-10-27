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
    if (req.url === '/api/pull') {
      // Stream a fake two-layer download.
      const total = Number(process.env.MOCK_PULL_TOTAL || 1000);
      const step = total / 4;
      for (let done = 0; done <= total; done += step) {
        res.write(JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total, completed: done }) + '\n');
        res.write(JSON.stringify({ status: 'pulling def', digest: 'sha256:def', total: 10, completed: 10 }) + '\n');
        await new Promise((r) => setTimeout(r, Number(process.env.MOCK_PULL_DELAY || 20)));
      }
      return res.end(JSON.stringify({ status: 'success' }) + '\n');
    }
    if (req.url === '/api/delete') return res.end('{}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 4683087332, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }, { name: 'bge-m3:latest', size: 1157672605, details: { parameter_size: '566.70M' } }] }));
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
