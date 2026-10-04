// Downloads the test pages listed in sources.json and writes pages.json (the lock file).
// Usage: node fetch.mjs [--force] [id ...]
// Pages with "commit": true go to html/ (open licence, checked in).
// All others go to local/ (gitignored, copyrighted, fetch them yourself).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';
const args = process.argv.slice(2);
const force = args.includes('--force');
const only = args.filter(a => !a.startsWith('--'));

const sources = JSON.parse(readFileSync(join(here, 'sources.json'), 'utf8'));
const lockPath = join(here, 'pages.json');
const lock = existsSync(lockPath) ? Object.fromEntries(JSON.parse(readFileSync(lockPath, 'utf8')).map(p => [p.id, p])) : {};

// Rough visible-text word count. Only used to sort pages into size buckets.
// The real extractor lives in the extension and will give slightly different numbers.
function countWords(html) {
  const text = html
    .replace(/<(script|style|noscript|svg|template|head)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ');
  return (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu) || []).length;
}
const bucket = w => w < 2500 ? '1k' : w < 7500 ? '5k' : w < 15000 ? '10k' : '20k';

for (const s of sources) {
  if (only.length && !only.includes(s.id)) continue;
  const file = join(s.commit ? 'html' : 'local', s.id + '.html');
  const abs = join(here, file);
  let html;
  if (existsSync(abs) && !force) {
    html = readFileSync(abs, 'utf8');
  } else {
    try {
      const res = await fetch(s.url, { headers: { 'user-agent': UA, 'accept-language': 'en' }, redirect: 'follow' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      html = await res.text();
    } catch (e) {
      console.error('FAILED', s.id, e.message);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, html);
    lock[s.id] = { ...lock[s.id], fetchedAt: new Date().toISOString().slice(0, 10) };
  }
  const sha256 = createHash('sha256').update(html).digest('hex');
  if (lock[s.id]?.sha256 && lock[s.id].sha256 !== sha256) console.warn('CHANGED', s.id, '(labels in bench/cases may no longer match)');
  const words = countWords(html);
  lock[s.id] = { id: s.id, type: s.type, file, words, bucket: bucket(words), fetchedAt: lock[s.id]?.fetchedAt ?? null, sha256 };
  console.log(s.id.padEnd(30), String(words).padStart(6), 'words', bucket(words).padStart(4), file);
}

const out = sources.map(s => lock[s.id]).filter(Boolean);
writeFileSync(lockPath, '[\n' + out.map(p => '  ' + JSON.stringify(p)).join(',\n') + '\n]\n');
