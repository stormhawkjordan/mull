'use strict';
/* Compare mode: same prompt, two models, one after the other. */

const cmp = { a: null, b: null, running: false };
const cmpEl = (side) => $(side === 'a' ? 'cmpColA' : 'cmpColB');

function openCompare() {
  if (models.length < 2) { toast('Add at least two models to compare them'); return; }
  $('compare').hidden = false;
  for (const [side, sel] of [['a', $('cmpSelA')], ['b', $('cmpSelB')]]) {
    const keep = sel.value;
    sel.innerHTML = '';
    for (const m of models) sel.appendChild(new Option(`${m.name} (${fmtSize(m.size)})`, m.id));
    sel.value = keep && models.some((m) => m.id === keep) ? keep : (side === 'a' ? (activeId || models[0].id) : (models.find((m) => m.id !== (activeId || models[0].id)) || models[1]).id);
  }
  $('cmpPrompt').focus();
}
const closeCompare = () => { if (!cmp.running) $('compare').hidden = true; };

function cmpReset(side) {
  const col = cmpEl(side);
  cmp[side] = { text: '', thought: '', tokens: 0, t0: 0, tFirst: 0 };
  col.querySelector('.cmp-out').innerHTML = ''; col.querySelector('.cmp-stats').textContent = ''; col.querySelector('.cmp-status').textContent = 'Waiting…';
  col.classList.remove('err');
}

let cmpPaint = false;
function cmpRender(side) {
  if (cmpPaint) return; cmpPaint = true;
  requestAnimationFrame(() => {
    cmpPaint = false;
    for (const s of ['a', 'b']) {
      const st = cmp[s]; if (!st) continue;
      const out = cmpEl(s).querySelector('.cmp-out');
      out.innerHTML = (st.thought && settings.showThinking ? `<details class="think"><summary><span class="lbl">Thinking</span></summary><div class="tbody"></div></details>` : '') + `<div class="abody">${md(st.text)}</div>`;
      const tb = out.querySelector('.tbody'); if (tb) tb.textContent = st.thought;
    }
  });
}

api.onCompareEvent((ev) => {
  const st = cmp[ev.side]; if (!st) return;
  const col = cmpEl(ev.side), status = col.querySelector('.cmp-status');
  if (ev.type === 'status') status.textContent = ev.progress != null && ev.text.startsWith('Loading') ? `${ev.text} ${Math.round(ev.progress * 100)}%` : ev.text;
  else if (ev.type === 'text' || ev.type === 'thought') {
    if (!st.tFirst && (ev.text || ev.n)) { st.tFirst = performance.now(); status.textContent = ev.type === 'thought' ? 'Thinking…' : 'Writing…'; }
    if (ev.type === 'thought') st.thought += ev.text; else { st.text += ev.text; status.textContent = 'Writing…'; }
    st.tokens += ev.n || 0; cmpRender(ev.side);
  } else if (ev.type === 'done') {
    status.textContent = ev.aborted ? 'Stopped' : 'Done';
    col.querySelector('.cmp-stats').textContent = `${ev.tokens} tokens · ${(ev.tokens / Math.max(ev.seconds - (ev.ttft || 0), 0.05)).toFixed(1)} tok/s · first token ${ev.ttft != null ? ev.ttft.toFixed(2) + 's' : '–'} · ${ev.seconds.toFixed(1)}s total` + (ev.thoughtTokens ? ` · ${ev.thoughtTokens} thinking` : '');
    cmpRender(ev.side);
  } else if (ev.type === 'error') { status.textContent = 'Error: ' + cleanErr(ev.message); col.classList.add('err'); }
});

async function runCompare() {
  const prompt = $('cmpPrompt').value.trim();
  if (!prompt || cmp.running) return;
  const a = $('cmpSelA').value, b = $('cmpSelB').value;
  if (a === b && !confirm('Both sides use the same model. Compare it with itself?')) return;
  cmp.running = true; $('cmpRun').hidden = true; $('cmpStop').hidden = false;
  cmpReset('a'); cmpReset('b');
  const persona = currentPersona(cur());
  const ejecting = $('cmpEject').checked && !!activeId;
  try {
    await api.runCompare({
      a, b, prompt, system: persona.system, ejectFirst: ejecting,
      opts: { a: loadOpts(a), b: loadOpts(b) },
      gen: { temperature: persona.temperature ?? +S('temperature'), topP: +S('topP'), topK: +S('topK'), minP: +S('minP'), repeatPenalty: +S('repeatPenalty'), maxTokens: +S('maxTokens') || 0, seed: S('seed') },
      thinking: { mode: S('thinkingMode'), budget: +S('thinkingBudget') || 2048 },
    });
  } catch (e) { toast(cleanErr(e)); }
  cmp.running = false; $('cmpRun').hidden = false; $('cmpStop').hidden = true;
}

$('openCompare').onclick = openCompare;
$('closeCompare').onclick = closeCompare;
$('cmpRun').onclick = runCompare;
$('cmpStop').onclick = () => api.stopCompare();
$('cmpPrompt').onkeydown = (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); runCompare(); } };
$('compare').addEventListener('mousedown', (e) => { if (e.target === $('compare')) closeCompare(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('compare').hidden) closeCompare(); });
