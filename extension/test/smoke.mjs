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
const panel = page.locator('#semantic-find-host #panel');
const settingsButton = page.locator('#semantic-find-host #settings');
const items = page.locator('#semantic-find-host #list li');
const currentText = () => page.evaluate(() => [...CSS.highlights.get('sf-current') ?? []].map((r) => r.toString()).join(' | '));
// The answer is in, and so is the second model call that picks the highlight inside a long chunk.
const answered = () => page.waitForFunction(() => {
  const root = document.querySelector('#semantic-find-host').shadowRoot;
  return !/Searching|Indexing/.test(root.getElementById('status').textContent) && !root.getElementById('stats').textContent.includes('by sentence…');
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

try {
  // A setting stored by an earlier build, which still had the Word mode.
  await sw.evaluate(() => chrome.storage.local.set({ settings: { mode: 'word', threshold: 0.35, minS: 1, maxS: 2, weight: 0.7, dev: true, chunkLength: 0, overlap: 5 } }));
  await toggle();
  await input.waitFor();
  assert.equal(await page.locator('#semantic-find-host [data-mode]').count(), 0, 'no mode switch');
  assert.equal(await page.locator('#semantic-find-host button', { hasText: /^(Word|Semantic)$/ }).count(), 0, 'no mode buttons');
  const storedKeys = Object.keys((await sw.evaluate(() => chrome.storage.local.get('settings'))).settings);
  assert.deepEqual(storedKeys.filter((k) => ['mode', 'dev', 'minS', 'maxS'].includes(k)), [], 'stored keys of earlier builds are gone');

  // First search on the page: nothing is highlighted while the page is being indexed.
  await input.fill('rollback');
  const duringIndexing = await page.waitForFunction(() => {
    const text = document.querySelector('#semantic-find-host').shadowRoot.getElementById('status').textContent;
    return text === 'Indexing…' && { n: [...CSS.highlights.values()].reduce((n, h) => n + h.size, 0) };
  }, null, { polling: 'raf' });
  assert.equal((await duringIndexing.jsonValue()).n, 0, 'no highlight while indexing');

  // Stored values outside their range fall back into it.
  await settingsButton.click();
  assert.equal(await panel.locator('input[name=chunkLength]').inputValue(), '1');
  assert.equal(await panel.locator('input[name=overlap]').inputValue(), '0');
  await panel.locator('#reset').click();
  await settingsButton.click();

  await check('exact', 'rollback', /rollback/i);
  await check('typo', 'bandwitdh', /bandwidth/);
  await check('hidden', 'optimization', null);
  assert.equal(await status.textContent(), 'No good match');
  await check('inline', 'relay login to', /relay login to/);

  // The Settings button toggles the settings panel. Alt+D does nothing.
  assert.equal(await panel.isVisible(), false, 'panel starts closed');
  await input.press('Alt+KeyD');
  assert.equal(await panel.isVisible(), false, 'Alt+D does nothing');
  await settingsButton.click();
  assert.ok(await panel.isVisible(), 'Settings opens the panel');
  await settingsButton.click();
  assert.equal(await panel.isVisible(), false, 'Settings closes the panel');
  await settingsButton.click();

  await check('synonym', 'undo a release', /rollback/);
  assert.match(await items.first().textContent(), /semantic 0\.\d\d · fuzzy [01]\.\d\d · blended [01]\.\d\d/);
  const stats = await panel.locator('#stats').textContent();
  assert.match(stats, /^\d+ chunks, indexed in \d+ ms \((webgpu|wasm) fp16\)/);
  assert.match(stats, /Result in \d+ ms, model \d+ ms/);
  assert.equal(await panel.locator('#model').textContent(), 'Xenova/all-MiniLM-L6-v2');

  // Clicking a result in the list selects it.
  await items.nth(1).click();
  assert.match(await count.textContent(), /^2\//);
  assert.doesNotMatch(await currentText(), /rollback to restore/);

  // Threshold and weight re-rank at once, without a model call.
  const slide = (name, value) => shadowEval((root, [name, value]) => {
    const el = root.querySelector(`input[name=${name}]`);
    el.value = value;
    el.dispatchEvent(new Event('input'));
    el.dispatchEvent(new Event('change'));
    return {
      shown: el.nextElementSibling.textContent,
      count: root.getElementById('count').textContent,
      status: root.getElementById('status').textContent,
      top: root.querySelector('#list li')?.textContent ?? '',
    };
  }, [name, value]);
  assert.deepEqual(await slide('threshold', '1'), { shown: '1', count: '', status: 'No good match', top: '' });
  assert.equal((await slide('threshold', '0')).count, '1/10');
  assert.match((await slide('weight', '0')).top, /blended 1\.00/, 'weight 0 ranks by fuzzy score');
  assert.equal((await slide('weight', '0.25')).shown, '0.25');

  // Settings and the open panel survive closing the overlay and a page reload.
  await slide('threshold', '0.5');
  await input.press('Escape');
  await page.reload();
  await toggle();
  await input.waitFor();
  assert.ok(await panel.isVisible(), 'panel is still open');
  assert.equal(await panel.locator('input[name=threshold]').inputValue(), '0.5');
  assert.equal(await panel.locator('input[name=weight]').inputValue(), '0.25');

  // Reset restores the defaults and keeps the panel open.
  await panel.locator('#reset').click();
  assert.equal(await panel.locator('input[name=threshold]').inputValue(), '0.35');
  assert.equal(await panel.locator('input[name=weight]').inputValue(), '0.7');
  assert.ok(await panel.isVisible());
  const afterReset = (await sw.evaluate(() => chrome.storage.local.get('settings'))).settings;
  assert.deepEqual([afterReset.threshold, afterReset.weight, afterReset.panel], [0.35, 0.7, true]);

  // Chunk length and overlap re-index when the slider is released, not at every step.
  const indexed = async () => {
    const h = await page.waitForFunction(() => {
      const root = document.querySelector('#semantic-find-host').shadowRoot;
      const m = /^(\d+) chunks, indexed in/.exec(root.getElementById('stats').textContent);
      return m && !/Searching|Indexing/.test(root.getElementById('status').textContent) && Number(m[1]);
    });
    return h.jsonValue();
  };
  const drag = (name, value, release) => shadowEval((root, [name, value, release]) => {
    const el = root.querySelector(`input[name=${name}]`);
    el.value = value;
    el.dispatchEvent(new Event('input'));
    if (release) el.dispatchEvent(new Event('change'));
    const shown = (n) => root.querySelector(`input[name=${n}]`).nextElementSibling.textContent;
    return { chunkLength: shown('chunkLength'), overlap: shown('overlap'), stats: root.getElementById('stats').textContent };
  }, [name, value, release]);
  assert.equal(await panel.locator('input[name=minS], input[name=maxS]').count(), 0, 'no min and max sentence sliders');
  const twoSentences = await indexed();
  const dragged = await drag('chunkLength', '1', false);
  assert.equal(dragged.chunkLength, '1');
  assert.match(dragged.stats, new RegExp(`^${twoSentences} chunks, indexed in`), 'dragging does not re-index');
  await drag('chunkLength', '1', true);
  const oneSentence = await indexed();
  assert.ok(oneSentence > twoSentences, `chunk length 1 gives more chunks (${oneSentence} > ${twoSentences})`);
  await check('chunk 1', 'undo a release', /rollback/);
  assert.doesNotMatch(await currentText(), /Rollbacks complete/, 'a chunk of length 1 is one sentence');

  // Overlap is always smaller than the chunk length.
  assert.equal((await drag('overlap', '2', true)).overlap, '0');
  await drag('chunkLength', '3', true);
  assert.equal((await drag('overlap', '2', true)).overlap, '2');
  assert.equal((await drag('chunkLength', '2', true)).overlap, '1', 'lowering chunk length lowers overlap');
  await indexed();
  // With overlap 1 the last sentence of a paragraph of three shares a chunk with the one before it.
  await check('overlap', 'where are tokens stored', /approve the session\. Tokens are stored/);
  await input.fill('');

  await panel.locator('#reset').click();
  assert.equal(await panel.locator('input[name=chunkLength]').inputValue(), '2');
  assert.equal(await panel.locator('input[name=overlap]').inputValue(), '0');
  assert.equal(await indexed(), twoSentences, 'Reset restores the chunk count');

  // A configuration that was already tried on this page comes back without indexing again.
  const slider = (name) => panel.locator(`input[name=${name}]`);
  const statsLine = async (start) => (await panel.locator('#stats').textContent()).split('\n').find((line) => line.includes(start)) ?? '';
  const indexLine = async () => { await indexed(); return statsLine('chunks'); };
  const setChunkLength = async (n) => { await slider('chunkLength').fill(String(n)); return indexLine(); };
  await check('exact', 'rollback', /rollback/i);
  const firstTime = await setChunkLength(2);
  assert.doesNotMatch(firstTime, /reused/);
  assert.doesNotMatch(await setChunkLength(4), /reused/, 'a new configuration is indexed');
  assert.notEqual(await indexed(), twoSentences);
  assert.equal(await setChunkLength(2), `${firstTime}, reused`, 'back at chunk length 2 the first index is reused');
  assert.match(await currentText(), /rollback/i, 'the query is searched again on the reused index');
  assert.match(await setChunkLength(4), /reused/, 'and so is the index for chunk length 4');
  console.log(`switching 2 -> 4 -> 2: ${firstTime} -> ${await setChunkLength(2)}`);

  // A change to the page text leads to a new index. The old text finds its index again.
  await input.press('Escape');
  await page.evaluate(() => document.body.insertAdjacentHTML('beforeend', '<p id="added">Zebras are not mentioned anywhere else.</p>'));
  await toggle();
  assert.doesNotMatch(await indexLine(), /reused/, 'changed page text is indexed');
  assert.equal(await indexed(), twoSentences + 1);
  await check('new text', 'zebras', /Zebras/);
  await input.press('Escape');
  await page.evaluate(() => document.getElementById('added').remove());
  await toggle();
  assert.match(await indexLine(), /reused/, 'the earlier page text still has its index');
  await check('exact', 'rollback', /rollback/i);

  // Highlight length is separate from chunk length. A chunk no longer than the highlight is marked whole.
  assert.equal(await slider('highlightLength').inputValue(), '2');
  await check('whole', 'how do I get HTTPS for my domain', /certificate is issued automatically/);
  assert.equal(await statsLine('Highlight'), 'Highlight: whole chunk, no model call');
  await setChunkLength(1);
  await check('whole', 'rollback', /rollback/i);
  assert.equal(await statsLine('Highlight'), 'Highlight: whole chunk, no model call');

  // Inside a longer chunk a second model call picks the sentences that answer the query.
  await setChunkLength(4);
  await check('pick 2', 'how do I get HTTPS for my domain', /certificate is issued automatically/);
  assert.ok(sentenceCount(await currentText()) <= 2, 'at most 2 sentences are highlighted');
  assert.match(await statsLine('Highlight'), /^Highlight: by sentence, model \d+ ms, \d+ ms after keystroke$/);
  console.log(`${await statsLine('Highlight')} (first query, sentences are embedded)`);
  await check('pick 2', 'where is the TLS cert coming from', /certificate is issued automatically/);
  console.log(`${await statsLine('Highlight')} (later query, sentence vectors are kept)`);

  // Changing the highlight length keeps the index and the result order, and only redoes the highlights.
  const [indexBefore, orderBefore] = [await indexLine(), await items.allTextContents()];
  await slider('highlightLength').fill('1');
  await answered();
  assert.equal(sentenceCount(await currentText()), 1);
  assert.match(await currentText(), /certificate is issued automatically/);
  await slider('highlightLength').fill('3');
  await answered();
  assert.equal(sentenceCount(await currentText()), 3);
  assert.deepEqual([await indexLine(), await items.allTextContents()], [indexBefore, orderBefore]);
  await slider('highlightLength').fill('2');

  // A late answer to the second call of an older query is dropped. The next query is typed at the
  // moment the second call starts, and 100 ms later its answer has not narrowed the old highlight.
  const typedDuringSecondCall = shadowEval((root, next) => new Promise((resolve, reject) => {
    const stats = root.getElementById('stats');
    const seen = new MutationObserver(() => {
      if (!stats.textContent.includes('by sentence…')) return;
      seen.disconnect();
      const el = root.getElementById('q');
      el.value = next;
      el.dispatchEvent(new Event('input'));
      setTimeout(() => resolve([...CSS.highlights.get('sf-current') ?? []].map((range) => range.cloneContents().textContent).join(' ')), 100);
    });
    seen.observe(stats, { childList: true, characterData: true, subtree: true });
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

  await slider('highlightLength').fill('3');
  await panel.locator('#reset').click();
  assert.equal(await slider('highlightLength').inputValue(), '2', 'Reset restores highlight length 2');
  await check('exact', 'rollback', /rollback/i);

  // Chunks may cross paragraph borders. The checkbox is off by default.
  const cross = panel.locator('#cross');
  assert.equal(await cross.isChecked(), false);
  await setChunkLength(4);
  const within = await indexed();
  await cross.check();
  assert.doesNotMatch(await indexLine(), /reused/, 'crossing is part of the configuration');
  const crossing = await indexed();
  assert.ok(crossing < within, `crossing gives fewer chunks (${crossing}) than staying inside paragraphs (${within})`);

  // A highlight that spans two paragraphs is drawn in both, and scrolling goes to its start.
  await slider('highlightLength').fill('3');
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
  await slider('highlightLength').fill('2');
  await check('pick x', 'rollback', /rollback/i);
  assert.equal(await currentText(), 'If a release breaks production, run relay rollback to restore the previous version. Rollbacks complete within seconds.', 'the two sentences on rollback are picked out of a chunk that covers two paragraphs');
  assert.match(await statsLine('Highlight'), /^Highlight: by sentence/);

  // Off and on again: both indexes are still there.
  await cross.uncheck();
  assert.match(await indexLine(), /reused/);
  assert.equal(await indexed(), within, 'with the checkbox off the chunks are as before');
  await cross.check();
  assert.match(await indexLine(), /reused/);
  assert.equal(await indexed(), crossing);
  await panel.locator('#reset').click();
  assert.equal(await cross.isChecked(), false, 'Reset turns crossing off');
  assert.equal((await sw.evaluate(() => chrome.storage.local.get('settings'))).settings.cross, false);
  await check('exact', 'rollback', /rollback/i);

  // Only a few indexes are kept per tab. The least recently used one is dropped.
  await setChunkLength(1);
  await setChunkLength(3);
  await setChunkLength(5);
  await setChunkLength(6);
  assert.doesNotMatch(await setChunkLength(2), /reused/, 'after four other configurations chunk length 2 is indexed again');
  assert.match(await setChunkLength(6), /reused/, 'the most recent ones are kept');
  await panel.locator('#reset').click();
  assert.match(await indexLine(), /reused/);

  await check('paraphrase', 'how to delete my account', /close your account/);
  await check('paraphrase', 'why did my build get killed', /ran out of memory/);
  await check('paraphrase', 'where do I put my API keys safely', /environment variables/);

  // While a new query is pending, the highlights of the previous answer stay.
  const pending = await shadowEval((root, q) => {
    const el = root.getElementById('q');
    el.value = q;
    el.dispatchEvent(new Event('input'));
    return { status: root.getElementById('status').textContent, current: [...CSS.highlights.get('sf-current') ?? []].map((range) => range.cloneContents().textContent).join(' ') };
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
  console.log('overlay state:', await shadowEval((root) => ({ status: root.getElementById('status').textContent, stats: root.getElementById('stats').textContent, query: root.getElementById('q').value })).catch(() => 'not available'));
  throw e;
} finally {
  await ctx.close();
  server.close();
}
