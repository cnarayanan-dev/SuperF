// End to end smoke test: loads dist/ in Chromium and drives the overlay on a local page.
// Run "npm run build" first. Needs "npx playwright install chromium" once.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
// The shortcut grants activeTab, which a test cannot press. The test copy gets localhost access instead.
const ext = mkdtempSync(join(tmpdir(), 'semantic-find-ext-'));
cpSync(join(here, '..', 'dist'), ext, { recursive: true });
const manifest = JSON.parse(readFileSync(join(ext, 'manifest.json'), 'utf8'));
manifest.host_permissions = ['http://localhost/*'];
writeFileSync(join(ext, 'manifest.json'), JSON.stringify(manifest));

const server = createServer((_, res) => res.setHeader('content-type', 'text/html').end(readFileSync(join(here, 'page.html'))));
await new Promise((r) => server.listen(0, r));
const url = `http://localhost:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(tmpdir(), 'semantic-find-profile-')), {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const page = await ctx.newPage();
await page.goto(url);
const toggle = () => sw.evaluate(async () => { const [tab] = await chrome.tabs.query({ active: true, currentWindow: true }); await openSearch(tab); });
const input = page.locator('#semantic-find-host #q');
const count = page.locator('#semantic-find-host #count');
const status = page.locator('#semantic-find-host #status');
const currentText = () => page.evaluate(() => [...CSS.highlights.get('sf-current') ?? []].map((r) => r.toString()).join(' | '));
// The answer is in, and so is the second model call that picks the highlight inside a long chunk.
const answered = () => page.waitForFunction(() => {
  const root = document.querySelector('#semantic-find-host').shadowRoot;
  return !/Searching|Indexing/.test(root.getElementById('status').textContent) && !root.getElementById('st-highlight').textContent.endsWith('…');
});
const sentenceCount = (text) => (text.match(/[.!?](?=\s|$)/g) ?? []).length;
const check = async (label, query, expected) => {
  await input.fill(query);
  await answered();
  const got = await currentText();
  console.log(`${label.padEnd(10)} "${query}" -> ${await count.textContent() || '0'}  ${JSON.stringify(got.slice(0, 80))}  [${await status.textContent()}]`);
  if (expected === null) assert.equal(got, '', `${label}: expected no result`);
  else assert.match(got, expected, label);
};

const shadowEval = (fn, arg) => page.evaluate(`(${fn})(document.querySelector('#semantic-find-host').shadowRoot, ${JSON.stringify(arg)})`);
const highlighted = () => page.evaluate(() => [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0));
const ui = (selector) => page.locator(`#semantic-find-host ${selector}`);
const slider = (name) => ui(`input[name=${name}]`);
const valueOf = (name) => ui(`label:has(input[name=${name}]) output`).textContent();
const settled = () => page.waitForFunction(() => {
  const root = document.querySelector('#semantic-find-host').shadowRoot;
  return !/Searching|Indexing/.test(root.getElementById('status').textContent) && root.getElementById('st-index').textContent !== '…';
});
const chunkCount = async () => { await settled(); return Number(await ui('#st-chunks').textContent()); };
const stored = async () => (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings;

try {
  // A setting stored by an earlier build, which still had the Word mode.
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'word', threshold: 0.35, minS: 1, maxS: 2, weight: 0.7, dev: false } }));
  await toggle();
  await input.waitFor();
  assert.equal(await page.locator('#semantic-find-host [data-mode]').count(), 0, 'no mode switch');
  assert.equal(await page.locator('#semantic-find-host button', { hasText: /^(Word|Semantic)$/ }).count(), 0, 'no mode buttons');
  assert.equal('mode' in (await stored()), false, 'stored mode is gone');
  assert.equal('dev' in (await stored()), false, 'stored dev setting is gone');

  // First search on the page: nothing is highlighted while the page is being indexed.
  await input.fill('rollback');
  const duringIndexing = await page.waitForFunction(() => {
    const text = document.querySelector('#semantic-find-host').shadowRoot.getElementById('status').textContent;
    return text === 'Indexing…' && { n: [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0) };
  }, null, { polling: 'raf' });
  assert.equal((await duringIndexing.jsonValue()).n, 0, 'no highlight while indexing');

  await check('exact', 'rollback', /rollback/i);
  await check('typo', 'bandwitdh', /bandwidth/);
  await check('hidden', 'optimization', null);
  assert.equal(await status.textContent(), 'No good match');
  await check('inline', 'relay login to', /relay login to/);

  // The Settings button opens the settings panel. The old Alt+D shortcut does nothing.
  assert.ok(await ui('#settings').isVisible(), 'Settings button is visible');
  await input.press('Alt+KeyD');
  assert.equal(await ui('#panel').isVisible(), false, 'Alt+D does nothing');
  await ui('#settings').click();
  assert.ok(await ui('#panel').isVisible(), 'Settings button opens the panel');
  await check('synonym', 'undo a release', /rollback/);
  assert.match(await ui('#list li').first().textContent(), /semantic 0\.\d\d · fuzzy 0\.\d\d · blended \d\.\d\d /);
  assert.match(await ui('#st-chunks').textContent(), /^\d+$/);
  assert.match(await ui('#st-index').textContent(), /^\d+ ms \((webgpu|wasm) fp16\)/);
  assert.match(await ui('#st-latency').textContent(), /^\d+ ms$/);
  assert.match(await ui('#st-model-ms').textContent(), /^\d+ ms$/);
  assert.equal(await ui('#st-model').textContent(), 'Xenova/all-MiniLM-L6-v2');
  console.log(`index ${await ui('#st-index').textContent()}, keystroke to result ${await ui('#st-latency').textContent()}, model ${await ui('#st-model-ms').textContent()}`);

  // A click in the result list selects and scrolls to that result.
  await ui('#list li').nth(1).click();
  assert.match(await count.textContent(), /^2\//);
  assert.doesNotMatch(await currentText(), /rollback to restore/);

  // Score threshold and semantic weight re-rank at once, so the new result is there without waiting for the model.
  const moveSlider = (name, value) => shadowEval((root, [name, value]) => {
    const el = root.querySelector(`input[name=${name}]`);
    el.value = value;
    el.dispatchEvent(new Event('input'));
    return { count: root.getElementById('count').textContent, status: root.getElementById('status').textContent, second: root.querySelectorAll('#list li')[1]?.textContent ?? '' };
  }, [name, value]);
  const strict = await moveSlider('threshold', '1');
  assert.deepEqual([strict.count, strict.status], ['', 'No good match'], 'threshold 1 hides every result at once');
  assert.equal(await valueOf('threshold'), '1');
  const loose = await moveSlider('threshold', '0.35');
  assert.match(loose.count, /^1\//);
  const blended = await moveSlider('weight', '1');
  assert.notEqual(blended.second, loose.second, 'semantic weight changes the blended score at once');

  // Settings and the open panel survive closing and reopening the overlay. Reset restores the defaults.
  await moveSlider('threshold', '0.5');
  await input.press('Escape');
  await toggle();
  assert.ok(await ui('#panel').isVisible(), 'the panel is still open');
  assert.deepEqual([await valueOf('threshold'), await valueOf('weight')], ['0.5', '1']);
  // They also survive a page load, where they come back from storage.
  await page.reload();
  await toggle();
  await input.waitFor();
  assert.ok(await ui('#panel').isVisible(), 'the panel is open after a reload');
  assert.deepEqual([await valueOf('threshold'), await valueOf('weight')], ['0.5', '1']);
  await ui('#reset').click();
  assert.deepEqual([await valueOf('threshold'), await valueOf('weight')], ['0.35', '0.7']);
  assert.deepEqual([(await stored()).threshold, (await stored()).weight], [0.35, 0.7]);

  // Chunk length and overlap index the page again when the slider is released. The panel shows the new chunk count.
  assert.equal('minS' in (await stored()) || 'maxS' in (await stored()), false, 'minimum and maximum sentence settings are gone');
  await check('exact', 'rollback', /rollback/i);
  const atDefault = await chunkCount();
  await slider('chunkLen').fill('1');
  assert.equal(await valueOf('chunkLen'), '1');
  const atOne = await chunkCount();
  assert.ok(atOne > atDefault, `chunk length 1 gives more chunks (${atOne}) than 2 (${atDefault})`);
  assert.match(await currentText(), /^[^.]*rollback[^.]*\.$/i, 'the chunk is one sentence');
  await slider('overlap').fill('2');
  assert.equal(await valueOf('overlap'), '0', 'overlap stays below chunk length');
  await slider('chunkLen').fill('3');
  const atThree = await chunkCount();
  await slider('overlap').fill('2');
  assert.equal(await valueOf('overlap'), '2');
  assert.ok(await chunkCount() > atThree, 'overlap gives more chunks');
  assert.match(await ui('#st-index').textContent(), /^\d+ ms \(/, 'the panel shows the indexing time of this configuration');
  await slider('chunkLen').fill('2');
  assert.equal(await valueOf('overlap'), '1', 'lowering the chunk length lowers the overlap');
  await ui('#reset').click();
  assert.deepEqual([await valueOf('chunkLen'), await valueOf('overlap')], ['2', '0']);
  assert.equal(await chunkCount(), atDefault);

  // A configuration that was already tried on this page comes back without indexing again.
  const indexStat = async () => { await settled(); return ui('#st-index').textContent(); };
  const setChunkLen = async (n) => { await slider('chunkLen').fill(String(n)); return indexStat(); };
  const firstTime = await setChunkLen(2);
  assert.doesNotMatch(firstTime, /reused/);
  assert.doesNotMatch(await setChunkLen(4), /reused/, 'a new configuration is indexed');
  assert.notEqual(await chunkCount(), atDefault);
  assert.equal(await setChunkLen(2), `${firstTime}, reused`, 'back at chunk length 2 the first index is reused');
  assert.equal(await chunkCount(), atDefault);
  assert.match(await currentText(), /rollback/i, 'the query is searched again on the reused index');
  assert.match(await setChunkLen(4), /reused/, 'and so is the index for chunk length 4');
  console.log(`switching 2 -> 4 -> 2: ${firstTime} -> ${await setChunkLen(2)}`);

  // A change to the page text leads to a new index. The old text finds its index again.
  await input.press('Escape');
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p id="added">Zebras are not mentioned anywhere else.</p>'));
  await toggle();
  assert.doesNotMatch(await indexStat(), /reused/, 'changed page text is indexed');
  assert.equal(await chunkCount(), atDefault + 1);
  await check('new text', 'zebras', /Zebras/);
  await input.press('Escape');
  await page.evaluate(() => document.getElementById('added').remove());
  await toggle();
  assert.match(await indexStat(), /reused/, 'the earlier page text still has its index');
  await check('exact', 'rollback', /rollback/i);

  // Highlight length is separate from chunk length. A chunk no longer than the highlight is marked whole.
  assert.equal(await valueOf('hlLen'), '2');
  await check('whole', 'how do I get HTTPS for my domain', /certificate is issued automatically/);
  assert.equal(await ui('#st-highlight').textContent(), 'whole chunk, no model call');
  await setChunkLen(1);
  await check('whole', 'rollback', /rollback/i);
  assert.equal(await ui('#st-highlight').textContent(), 'whole chunk, no model call');

  // Inside a longer chunk a second model call picks the sentences that answer the query.
  await setChunkLen(4);
  await check('pick 2', 'how do I get HTTPS for my domain', /certificate is issued automatically/);
  assert.ok(sentenceCount(await currentText()) <= 2, 'at most 2 sentences are highlighted');
  assert.match(await ui('#st-highlight').textContent(), /^by sentence, model \d+ ms, \d+ ms after keystroke$/);
  console.log(`highlight ${await ui('#st-highlight').textContent()} (first query, sentences are embedded)`);
  await check('pick 2', 'where is the TLS cert coming from', /certificate is issued automatically/);
  console.log(`highlight ${await ui('#st-highlight').textContent()} (later query, sentence vectors are kept)`);

  // Changing the highlight length keeps the index and the result order, and only redoes the highlights.
  const listTexts = () => ui('#list li').allTextContents();
  const [indexBefore, orderBefore] = [await ui('#st-index').textContent(), await listTexts()];
  await slider('hlLen').fill('1');
  await answered();
  assert.equal(sentenceCount(await currentText()), 1);
  assert.match(await currentText(), /certificate is issued automatically/);
  await slider('hlLen').fill('3');
  await answered();
  assert.equal(sentenceCount(await currentText()), 3);
  assert.deepEqual([await ui('#st-index').textContent(), await listTexts()], [indexBefore, orderBefore]);
  await slider('hlLen').fill('2');

  // A late answer to the second call of an older query is dropped. The next query is typed at the
  // moment the second call starts, and 100 ms later its answer has not narrowed the old highlight.
  const typedDuringSecondCall = shadowEval((root, next) => new Promise((resolve, reject) => {
    const stat = root.getElementById('st-highlight');
    const seen = new MutationObserver(() => {
      if (!stat.textContent.endsWith('…')) return;
      seen.disconnect();
      const el = root.getElementById('q');
      el.value = next;
      el.dispatchEvent(new Event('input'));
      setTimeout(() => resolve([...CSS.highlights.get('sf-current') ?? []].join(' ')), 100);
    });
    seen.observe(stat, { childList: true, characterData: true, subtree: true });
    setTimeout(() => reject(new Error('the second model call never started')), 10000);
  }), 'where are my login tokens kept');
  await input.fill('how do I get HTTPS for my domain');
  const oldHighlight = await typedDuringSecondCall;
  assert.match(oldHighlight, /certificate is issued automatically/);
  assert.ok(sentenceCount(oldHighlight) > 2, 'the older query keeps its whole chunk highlighted');
  await check('stale 2', 'where are my login tokens kept', /Tokens are stored/);
  assert.ok(sentenceCount(await currentText()) <= 2);
  await page.waitForTimeout(400);
  assert.match(await currentText(), /Tokens are stored/, 'a late highlight for the older query is dropped');

  await slider('hlLen').fill('3');
  await ui('#reset').click();
  assert.equal(await valueOf('hlLen'), '2', 'Reset restores highlight length 2');
  await check('exact', 'rollback', /rollback/i);

  // Chunks may cross paragraph borders. The checkbox is off by default.
  const cross = ui('#cross');
  assert.equal(await cross.isChecked(), false);
  await setChunkLen(4);
  const within = await chunkCount();
  await cross.check();
  assert.doesNotMatch(await indexStat(), /reused/, 'crossing is part of the configuration');
  const crossing = await chunkCount();
  assert.ok(crossing < within, `crossing gives fewer chunks (${crossing}) than staying inside paragraphs (${within})`);

  // A highlight that spans two paragraphs is drawn in both, and scrolling goes to its start.
  await slider('hlLen').fill('3');
  await check('2 paras', 'rollback', /rollback/i);
  const spanning = await page.evaluate(() => [...CSS.highlights.get('sf-current')].map((r) => {
    const el = r.startContainer.parentElement.closest('p, h1, h2, nav');
    const box = r.getBoundingClientRect();
    return { same: el === r.endContainer.parentElement.closest('p, h1, h2, nav'), index: [...document.querySelectorAll('p, h1, h2, nav')].indexOf(el), visible: box.top >= 0 && box.bottom <= innerHeight };
  }));
  assert.ok(spanning.length >= 2, 'the highlight has one range per paragraph');
  assert.ok(spanning.every((r) => r.same), 'each range stays inside its paragraph');
  assert.equal(new Set(spanning.map((r) => r.index)).size, spanning.length, 'the ranges are in different paragraphs');
  assert.ok(spanning[0].visible, 'the start of the highlight is scrolled into view');
  assert.equal(sentenceCount((await currentText()).replaceAll(' | ', ' ')), 3);

  // Highlight picking by sentence works inside a chunk that covers several paragraphs.
  await slider('hlLen').fill('2');
  await check('pick x', 'rollback', /rollback/i);
  assert.equal(await currentText(), 'If a release breaks production, run relay rollback to restore the previous version. Rollbacks complete within seconds.', 'the two sentences on rollback are picked out of a chunk that covers two paragraphs');
  assert.match(await ui('#st-highlight').textContent(), /^by sentence/);

  // Off and on again: both indexes are still there.
  await cross.uncheck();
  assert.match(await indexStat(), /reused/);
  assert.equal(await chunkCount(), within, 'with the checkbox off the chunks are as before');
  await cross.check();
  assert.match(await indexStat(), /reused/);
  assert.equal(await chunkCount(), crossing);
  await ui('#reset').click();
  assert.equal(await cross.isChecked(), false, 'Reset turns crossing off');
  assert.equal((await stored()).cross, false);
  await check('exact', 'rollback', /rollback/i);

  // Only a few indexes are kept per tab. The least recently used one is dropped.
  for (const n of [1, 3, 5, 6]) await setChunkLen(n);
  assert.doesNotMatch(await setChunkLen(2), /reused/, 'after four other configurations chunk length 2 is indexed again');
  assert.match(await setChunkLen(6), /reused/, 'the most recent ones are kept');
  await ui('#reset').click();
  assert.match(await indexStat(), /reused/);

  await check('paraphrase', 'how to delete my account', /close your account/);
  await check('paraphrase', 'why did my build get killed', /ran out of memory/);
  await check('paraphrase', 'where do I put my API keys safely', /environment variables/);

  // While a new query is pending, the highlights of the previous answer stay.
  const pending = await shadowEval((root, q) => {
    const el = root.getElementById('q');
    el.value = q;
    el.dispatchEvent(new Event('input'));
    return { status: root.getElementById('status').textContent, current: [...CSS.highlights.get('sf-current') ?? []].join(' ') };
  }, 'undo a release');
  assert.equal(pending.status, 'Searching…');
  assert.match(pending.current, /environment variables/, 'previous highlight stays while pending');
  await check('synonym', 'undo a release', /rollback/);

  // Answers to an older query are dropped when the user keeps typing.
  await input.fill('how to delete my account');
  await page.waitForTimeout(160); // past the debounce, the model call is in flight
  await check('stale', 'why did my build get killed', /ran out of memory/);
  await page.waitForTimeout(400);
  assert.match(await currentText(), /ran out of memory/, 'a late answer to the older query is dropped');

  await check('junk', 'best pizza in naples', null);
  assert.equal(await status.textContent(), 'No good match');

  // Enter and Shift+Enter cycle through the results.
  await check('cycle', 'undo a release', /rollback/);
  const total = (await count.textContent()).split('/')[1];
  assert.ok(Number(total) >= 2, 'cycle query needs two results');
  await input.press('Enter');
  assert.equal(await count.textContent(), `2/${total}`);
  assert.doesNotMatch(await currentText(), /rollback to restore/);
  await input.press('Shift+Enter');
  assert.equal(await count.textContent(), `1/${total}`);

  // An empty query clears the highlights.
  await input.fill('');
  assert.equal(await highlighted(), 0, 'empty query clears highlights');
  assert.equal(await count.textContent(), '');

  await check('exact', 'rollback', /rollback/i);
  await input.press('Escape');
  assert.equal(await page.locator('#semantic-find-host').isVisible(), false);
  assert.equal(await page.evaluate(() => CSS.highlights.size), 0);
  console.log('\nsmoke test passed');
} catch (e) {
  console.log('overlay state:', await shadowEval((root) => ({ status: root.getElementById('status').textContent, index: root.getElementById('st-index').textContent, highlight: root.getElementById('st-highlight').textContent, query: root.getElementById('q').value })).catch(() => 'not available'));
  throw e;
} finally {
  await ctx.close();
  server.close();
}
