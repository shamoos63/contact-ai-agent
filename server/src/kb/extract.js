import path from 'node:path';
import * as cheerio from 'cheerio';
import mammoth from 'mammoth';
import { PDFParse } from 'pdf-parse';

export async function extractFile(buffer, filename) {
  const ext = path.extname(filename).toLowerCase();
  if (ext === '.pdf') {
    const parser = new PDFParse({ data: new Uint8Array(buffer) });
    try {
      return (await parser.getText()).text;
    } finally {
      await parser.destroy();
    }
  }
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer })).value;
  if (['.html', '.htm'].includes(ext)) return htmlToText(buffer.toString('utf8')).text;
  if (['.txt', '.md', '.csv', '.json'].includes(ext)) return buffer.toString('utf8');
  throw new Error(`Unsupported file type "${ext}". Use PDF, DOCX, TXT, MD, CSV or HTML.`);
}

export function htmlToText(html) {
  const $ = cheerio.load(html);
  const title = $('title').first().text().trim();
  $('script, style, noscript, svg, iframe, nav, footer, header form').remove();
  const blocks = [];
  $('h1, h2, h3, h4, h5, h6, p, li, td, th, dt, dd, blockquote, pre').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    if (t) blocks.push(t);
  });
  let text = blocks.join('\n');
  if (text.length < 200) text = $('body').text().replace(/\s+/g, ' ').trim();
  return { title, text };
}

export async function extractUrl(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; ContactAIAgent/1.0)' },
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) throw new Error(`Could not fetch page: HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (type.includes('application/pdf')) {
    const buf = Buffer.from(await res.arrayBuffer());
    return { title: url, text: await extractFile(buf, 'page.pdf') };
  }
  return htmlToText(await res.text());
}

// Split text into overlapping chunks of roughly `size` characters on paragraph/sentence boundaries.
export function chunkText(text, size = 900, overlap = 150) {
  const clean = text.replace(/\r/g, '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  if (!clean) return [];
  const pieces = clean.split(/(?<=[.!?؟。\n])\s+/);
  const chunks = [];
  let current = '';
  for (const piece of pieces) {
    if ((current + ' ' + piece).length > size && current) {
      chunks.push(current.trim());
      current = current.slice(-overlap) + ' ' + piece;
    } else {
      current = current ? current + ' ' + piece : piece;
    }
    while (current.length > size * 1.5) {
      chunks.push(current.slice(0, size).trim());
      current = current.slice(size - overlap);
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}
