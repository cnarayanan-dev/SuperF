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
const ui = (selector) => page.locator(`#semantic-find-host ${selector}`);
const slider = (name) => ui(`input[name=${name}]`);
const valueOf = (name) => ui(`label:has(input[name=${name}]) output`).textContent();
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
  await ui('#reset').click();
  assert.deepEqual([await valueOf('threshold'), await valueOf('weight')], ['0.35', '0.7']);
  assert.deepEqual([(await stored()).threshold, (await stored()).weight], [0.35, 0.7]);

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
} finally {
  await ctx.close();
  server.close();
}
