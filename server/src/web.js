import * as cheerio from 'cheerio';
import { extractUrl } from './kb/extract.js';

// Online access for the owner assistant: search the web and read pages. Free, no API key.
// Uses the SearXNG container (it asks Google, Bing, DuckDuckGo… for us) and falls back to
// DuckDuckGo's plain HTML page when SearXNG isn't running.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
const searxngUrl = () => (process.env.SEARXNG_URL || '').replace(/\/+$/, '');

async function searxng(query, limit) {
  const res = await fetch(`${searxngUrl()}/search?format=json&q=${encodeURIComponent(query)}`, {
    headers: { Accept: 'application/json', 'User-Agent': UA },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`SearXNG answered HTTP ${res.status}`);
  const data = await res.json();
  return (data.results || []).slice(0, limit).map((r) => ({ title: r.title || r.url, url: r.url, snippet: r.content || '' }));
}

async function duckduckgo(query, limit) {
  const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
    headers: { 'User-Agent': UA, 'Accept-Language': 'en,ar;q=0.8' },
    signal: AbortSignal.timeout(20000),
  });
  if (!res.ok) throw new Error(`DuckDuckGo answered HTTP ${res.status}`);
  const $ = cheerio.load(await res.text());
  const out = [];
  $('.result').each((_, el) => {
    if ($(el).hasClass('result--ad')) return;
    const a = $(el).find('a.result__a').first();
    let url = a.attr('href') || '';
    const wrapped = url.match(/[?&]uddg=([^&]+)/);
    if (wrapped) url = decodeURIComponent(wrapped[1]);
    if (url.startsWith('//')) url = 'https:' + url;
    if (!/^https?:\/\//.test(url)) return;
    out.push({ title: a.text().trim() || url, url, snippet: $(el).find('.result__snippet').text().trim() });
  });
  return out.slice(0, limit);
}

export async function webSearch(query, { limit = 6 } = {}) {
  const errors = [];
  if (searxngUrl()) {
    try {
      const results = await searxng(query, limit);
      if (results.length) return results;
    } catch (err) {
      errors.push(err.message);
    }
  }
  try {
    return await duckduckgo(query, limit);
  } catch (err) {
    errors.push(err.message);
    throw new Error(`Couldn't reach the internet (${errors.join('; ')})`);
  }
}

// Text of a page, cut to `max` characters. Never throws: a page that can't be read is skipped.
export async function readPage(url, max = 3000) {
  try {
    const { title, text } = await extractUrl(url);
    const clean = String(text || '').replace(/\s+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return clean ? { url, title: title || url, text: clean.slice(0, max) } : null;
  } catch {
    return null;
  }
}

export const firstUrl = (text) => String(text || '').match(/https?:\/\/[^\s<>"'«»]+/)?.[0]?.replace(/[).,،]+$/, '') || null;
