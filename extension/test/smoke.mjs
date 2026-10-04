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
const check = async (label, query, expected) => {
  await input.fill(query);
  await page.waitForFunction(() => !/Searching|Indexing/.test(document.querySelector('#semantic-find-host').shadowRoot.getElementById('status').textContent));
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

  await check('paraphrase', 'how to delete my account', /close your account/);
  await check('paraphrase', 'why did my build get killed', /ran out of memory/);
  await check('paraphrase', 'where do I put my API keys safely', /environment variables/);

  // While a new query is pending, the highlights of the previous answer stay.
  const pending = await shadowEval((root, q) => {
    const el = root.getElementById('q');
    el.value = q;
    el.dispatchEvent(new Event('input'));
    return { status: root.getElementById('status').textContent, current: [...CSS.highlights.get('sf-current') ?? []].map((r) => r.toString()).join(' ') };
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
} finally {
  await ctx.close();
  server.close();
}
