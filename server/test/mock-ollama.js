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

// Answers the tests queue up for the owner assistant, one per request.
export const assistantAnswers = [];

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
    if (req.url === '/api/ps') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 6e9, size_vram: 0 }] }));
    if (req.url === '/api/delete') return res.end('{}');
    if (req.url === '/api/tags') return res.end(JSON.stringify({ models: [{ name: 'qwen2.5:7b', size: 4683087332, details: { parameter_size: '7.6B', quantization_level: 'Q4_K_M' } }, { name: 'bge-m3:latest', size: 1157672605, details: { parameter_size: '566.70M' } }] }));
    if (req.url === '/api/embed') return res.end(JSON.stringify({ embeddings: data.input.map(vec) }));
    if (req.url === '/api/chat') {
      await new Promise((r) => setTimeout(r, Number(process.env.MOCK_CHAT_DELAY || 0)));
      const system = data.messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
      if (system.includes('AI assistant.') && system.includes('on behalf of')) {
        const draft = system.match(/^Draft: (.*)$/m)?.[1] || '';
        const intro = /introduce yourself|عرفو عن حالك/.test(system.split('Draft:')[0].split('asked you:')[1] || '') ? 'Hi, I am the assistant. ' : '';
        return res.end(JSON.stringify({ message: { role: 'assistant', content: intro + draft } }));
      }
      if (system.includes('You are the personal assistant of')) {
        if (!data.format) return res.end(JSON.stringify({ message: { role: 'assistant', content: 'no schema' } }));
        return res.end(JSON.stringify({ message: { role: 'assistant', content: JSON.stringify(assistantAnswers.shift() || { action: 'help' }) } }));
      }
      if (data.messages[0].content.includes('forwarding rules')) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: /invoice/i.test(data.messages[0].content.split('Email:')[1]) ? '1' : 'none' } }));
      }
      const knows = system.includes('9am to 6pm');
      const lastUser = [...data.messages].reverse().find((m) => m.role === 'user')?.content || '';
      if (lastUser.includes('Which of these teams should handle it?')) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: /printer/i.test(lastUser) ? 'maintenance' : 'none' } }));
      }
      if (lastUser.includes('Write a brief for our Sales team')) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Wants 3 iPhone 16 phones, delivery to Dubai this week.' } }));
      }
      if (lastUser.includes('Write a brief for our Maintenance request team')) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Laptop screen is broken, customer is in Sharjah.' } }));
      }
      // Like a small model that answers from the knowledge and forgets the tag, unless reminded at the end.
      if (/[\u0600-\u06FF]/.test(lastUser) && system.includes('TEAM HANDOFF:') && !/\d/.test(lastUser)) {
        const reminded = data.messages.at(-1).content.includes('needs our Sales team');
        return res.end(JSON.stringify({ message: { role: 'assistant', content: reminded ? 'أكيد! أي جهاز بدك، وكم ميزانيتك، ووين التوصيل؟' : 'نعم، نبيع أجهزة مستعملة.' } }));
      }
      if (system.includes('TEAM HANDOFF:')) {
        const detailed = /\d/.test(lastUser);
        if (/want to buy/i.test(lastUser) && system.includes('[ASK:sales]')) {
          return res.end(JSON.stringify({ message: { role: 'assistant', content: detailed
            ? 'Great, 3 iPhones noted. Our team will contact you shortly. [HANDOFF:sales]'
            : 'Happy to help! Which product do you need, how many, and to which city? [ASK:sales]' } }));
        }
        if (/repair|broken/i.test(lastUser) && system.includes('[ASK:maintenance]')) {
          // Written the way small models often do: with the topic's name instead of its id.
          return res.end(JSON.stringify({ message: { role: 'assistant', content: 'Sorry to hear that! Which device is it, what is the problem, and where are you? [ASK: Maintenance request]' } }));
        }
      }
      if (/what is toptech/i.test(lastUser)) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'TopTech是我们提供最新科技产品的商店。' } }));
      }
      if (/write that again in English/.test(lastUser)) {
        return res.end(JSON.stringify({ message: { role: 'assistant', content: 'TopTech is our shop for the latest tech products.' } }));
      }
      return res.end(JSON.stringify({
        message: { role: 'assistant', content: knows ? 'We are open 9am to 6pm.' : 'I am not sure.' },
        load_duration: 42e9, prompt_eval_count: 1450, prompt_eval_duration: 38e9, eval_count: 60, eval_duration: 12e9,
      }));
    }
    res.statusCode = 404;
    res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, () => resolve({ server, calls, url: `http://127.0.0.1:${server.address().port}` })));
}
