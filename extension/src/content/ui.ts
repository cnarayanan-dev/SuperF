// Overlay markup and styles. The overlay lives in a shadow root, so page CSS cannot reach it.

export const PAGE_CSS = `
::highlight(sf-match) { background: #ffe58a; color: #111; }
::highlight(sf-current) { background: #ff9d3c; color: #111; }
`;

export const OVERLAY_HTML = `
<div class="box">
  <div class="row">
    <input id="q" type="text" placeholder="Find on page" autocomplete="off" spellcheck="false">
    <span id="count"></span>
    <button id="prev" title="Previous (Shift+Enter)">&#8593;</button>
    <button id="next" title="Next (Enter)">&#8595;</button>
    <button id="close" title="Close (Esc)">&#10005;</button>
  </div>
  <div class="row">
    <button id="settings" title="Settings" aria-expanded="false">Settings</button>
    <span id="status"></span>
  </div>
  <div id="panel" hidden>
    <label>Score threshold <input type="range" name="threshold" min="0" max="1" step="0.01"><output></output></label>
    <label>Semantic weight <input type="range" name="weight" min="0" max="1" step="0.05"><output></output></label>
    <label>Chunk length <input type="range" name="chunkLength" min="1" max="6" step="1"><output></output></label>
    <label>Overlap <input type="range" name="overlap" min="0" max="2" step="1"><output></output></label>
    <label class="check"><input type="checkbox" id="cross"> Chunks may cross paragraphs</label>
    <label>Highlight length <input type="range" name="highlightLength" min="1" max="3" step="1"><output></output></label>
    <div id="stats"></div>
    <ol id="list"></ol>
    <div class="row">
      <span id="model"></span>
      <button id="reset" title="Restore the defaults">Reset</button>
    </div>
  </div>
</div>
`;

export const OVERLAY_CSS = `
:host { color-scheme: light dark; }
.box {
  width: 380px; padding: 8px; border-radius: 10px; box-sizing: border-box;
  font: 13px/1.4 system-ui, sans-serif; color: #1f2328; background: #fff;
  border: 1px solid #d0d7de; box-shadow: 0 8px 24px rgba(0, 0, 0, .2);
}
.row { display: flex; align-items: center; gap: 6px; }
.row + .row { margin-top: 6px; }
#q {
  flex: 1; min-width: 0; padding: 5px 8px; font: inherit; color: inherit;
  background: transparent; border: 1px solid #d0d7de; border-radius: 6px; outline: none;
}
#q:focus { border-color: #0969da; }
#count { min-width: 38px; text-align: right; color: #656d76; font-variant-numeric: tabular-nums; }
button {
  font: inherit; color: inherit; background: transparent; cursor: pointer;
  border: 1px solid transparent; border-radius: 6px; padding: 3px 7px;
}
button:hover { background: rgba(128, 128, 128, .18); }
#settings { border-color: #d0d7de; padding: 2px 10px; }
#settings[aria-expanded=true] { background: #0969da; border-color: #0969da; color: #fff; }
#reset { border-color: #d0d7de; }
#status { flex: 1; text-align: right; color: #656d76; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#panel { margin-top: 8px; padding-top: 8px; border-top: 1px solid #d0d7de; }
#panel[hidden] { display: none; }
#stats { margin-top: 8px; color: #656d76; font-size: 12px; white-space: pre-line; }
#model { flex: 1; color: #656d76; font-size: 12px; }
label { display: grid; grid-template-columns: 120px 1fr 36px; align-items: center; gap: 6px; }
label.check { display: flex; margin: 2px 0; }
output { text-align: right; font-variant-numeric: tabular-nums; }
#list { margin: 8px 0 0; padding: 0; list-style: none; max-height: 240px; overflow: auto; }
#list li { padding: 3px 4px; border-radius: 4px; cursor: pointer; font-size: 12px; }
#list li.current { background: rgba(255, 157, 60, .3); }
#list b { display: block; font-weight: 600; color: #656d76; }
@media (prefers-color-scheme: dark) {
  .box { color: #e6edf3; background: #22272e; border-color: #444c56; }
  #q, #panel, #settings:not([aria-expanded=true]), #reset { border-color: #444c56; }
  #count, #status, #stats, #model, #list b { color: #9198a1; }
}
`;
