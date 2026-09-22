'use strict';
/* Model browser: search Hugging Face for GGUF models, pick a file, download with progress / pause / resume.
   Uses helpers from renderer.js ($, el, esc, fmtSize, cleanErr, toast, models, renderModels, selectModel, sysInfo). */

const hf = { results: [], expanded: new Set(), files: new Map(), gpu: null, query: '', status: '', opened: false, onlyFits: store.get('mull.onlyFits', false) };
const dls = new Map(); // key -> { key, repo, file, size, received, total, speed, state, message, id }
const rowRefs = new Map();
const CHIPS = ['1b instruct', '3b instruct', '7b instruct', 'qwen3', 'llama 3.2', 'gemma 3', 'phi 4 mini', 'deepseek r1 distill', 'smollm2'];
const QUANT_PREF = ['Q4_K_M', 'Q4_K_S', 'Q5_K_M', 'Q4_0', 'Q6_K', 'Q8_0', 'Q3_K_M'];

const fmtN = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n || 0));
const quantOf = (name) => (name.match(/(IQ\d_[A-Z0-9]+|Q\d(?:_K)?(?:_[A-Z0-9]+)?|BF16|F16|F32)(?=[.\-_]|$)/i) || [''])[0].toUpperCase();
const fmtEta = (s) => (!isFinite(s) || s < 0 ? '' : s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m ${Math.round(s % 60)}s` : `${Math.round(s)}s`);
function ago(iso) {
  if (!iso) return '';
  const d = (Date.now() - new Date(iso).getTime()) / 864e5;
  return d < 1 ? 'today' : d < 30 ? `${Math.round(d)}d ago` : d < 365 ? `${Math.round(d / 30)}mo ago` : `${Math.round(d / 365)}y ago`;
}
function parseRepo(q) {
  q = q.trim();
  const m = q.match(/huggingface\.co\/([\w.-]+\/[\w.-]+)/i);
  if (m) return m[1];
  return /^[\w.-]+\/[\w.-]+$/.test(q) ? q : null;
}

/* How well will a file of this size run on this PC? Weights plus ~15% and 0.6 GB for the context/cache. */
function fitOf(size) {
  if (!size) return null;
  const need = size * 1.15 + 0.6e9;
  const ram = (sysInfo?.ramGB || 0) * 1073741824;
  const vram = (hf.gpu?.vramGB || 0) * 1073741824;
  if (vram && need <= vram * 0.92) return { cls: 'ok', text: 'Fits your GPU' };
  if (need <= ram * 0.7) return { cls: 'ok', text: vram ? 'Fits RAM (slower)' : 'Fits your RAM' };
  if (need <= ram * 0.9) return { cls: 'warn', text: 'Tight on memory' };
  return { cls: 'bad', text: 'Too big for this PC' };
}

/* ---------------- Sidebar "Models" tab: quick shortcuts into the full search ---------------- */
let discoverBuilt = false;
function renderDiscover() {
  if (discoverBuilt) return;
  discoverBuilt = true;
  const box = $('discoverChips'); box.innerHTML = '';
  for (const c of CHIPS) {
    const b = el('button', 'chip-s'); b.type = 'button'; b.textContent = c;
    b.onclick = async () => { await openBrowser(); if (!$('browser').hidden) { $('hfQuery').value = c; runSearch(c); } };
    box.appendChild(b);
  }
}
$('discoverGo').onclick = openBrowser;

/* ---------------- Open / close ---------------- */
let hfNetRelease = null;
/* Lets another already-online session (the wizard) hand its network hold to this dialog instead of
   letting it lapse, so going wizard -> "Browse all models" doesn't prompt again or leak the hold. */
function adoptNetworkHold(release) { hfNetRelease = release; }
async function openBrowser() {
  if (!hfNetRelease) {
    const release = await ensureNetwork('Getting models searches and downloads from Hugging Face.');
    if (!release) return;
    hfNetRelease = release;
  }
  $('browser').hidden = false;
  if (!hf.opened) {
    hf.opened = true;
    $('hfChips').innerHTML = '';
    for (const c of CHIPS) { const b = el('button', 'chip-s'); b.type = 'button'; b.textContent = c; b.onclick = () => { $('hfQuery').value = c; runSearch(c); }; $('hfChips').appendChild(b); }
    api.modelsDir().then((d) => { $('dirText').textContent = d; });
    api.gpuInfo().then((g) => { hf.gpu = g; renderResults(); });
    runSearch('');
  }
  $('hfOnlyFits').checked = hf.onlyFits;
  $('hfQuery').focus();
}
const closeBrowser = () => { $('browser').hidden = true; hfNetRelease?.(); hfNetRelease = null; };

/* Whether a repo has at least one file that fits this PC. null while we don't know yet (kicks off
   loading its file list, same as expanding it manually — renderResults() re-filters once it lands). */
function repoFits(repo) {
  const f = hf.files.get(repo);
  if (!f) { loadFiles(repo); return null; }
  if (f.loading || f.error) return null;
  return f.list.some((x) => !x.split && !x.projector && x.size && fitOf(x.size)?.cls !== 'bad');
}

/* ---------------- Search + results ---------------- */
async function runSearch(q) {
  hf.query = q; hf.status = 'Searching…'; renderResults();
  try {
    const repo = parseRepo(q);
    if (repo) { hf.results = [{ id: repo, downloads: 0, likes: 0 }]; hf.expanded = new Set([repo]); hf.status = ''; renderResults(); loadFiles(repo); return; }
    hf.results = await api.hfSearch(q);
    hf.status = hf.results.length ? '' : 'No GGUF models found. Try a different search.';
  } catch (e) { hf.results = []; hf.status = cleanErr(e); }
  renderResults();
}

async function loadFiles(repo) {
  if (hf.files.has(repo) && !hf.files.get(repo).error) return;
  hf.files.set(repo, { loading: true });
  renderResults();
  try { hf.files.set(repo, { list: (await api.hfFiles(repo)) }); }
  catch (e) { hf.files.set(repo, { error: cleanErr(e) }); }
  renderResults();
}

function bestFile(list) {
  const ok = list.filter((f) => !f.split && !f.projector && f.size && fitOf(f.size)?.cls !== 'bad');
  for (const q of QUANT_PREF) { const f = ok.find((x) => quantOf(x.path) === q); if (f) return f; }
  return ok.sort((a, b) => a.size - b.size)[0] || null;
}

function renderResults() {
  const body = $('hfBody'); const keepScroll = body.scrollTop;
  body.innerHTML = '';
  if (hf.status) body.appendChild(el('div', 'empty', esc(hf.status)));
  if (!hf.query && !hf.status) body.appendChild(el('div', 'sys', 'Most downloaded GGUF models (many are large). Try a size chip above such as “1b instruct” for models that run well on most PCs, then open one to see file sizes.'));
  let checking = 0;
  for (const r of hf.results) {
    if (hf.onlyFits) {
      const fits = repoFits(r.id);
      if (fits === null) { checking++; continue; } // still loading its sizes; will reappear (or not) once known
      if (fits === false) continue;
    }
    const open = hf.expanded.has(r.id);
    const [owner, name] = r.id.split('/');
    const card = el('div', 'repo' + (open ? ' open' : ''));
    const head = el('div', 'repo-h');
    head.innerHTML = `<span class="caret">${ic(open ? 'chevron-down' : 'chevron-right', 14)}</span><div class="rt"><span class="rn">${esc(name)}</span><span class="ro">${esc(owner)}</span></div>` +
      `<span class="rm">${[r.downloads ? fmtN(r.downloads) + ' downloads' : '', r.likes ? fmtN(r.likes) + ' likes' : '', r.updated ? ago(r.updated) : ''].filter(Boolean).join(' · ')}</span>`;
    head.onclick = () => { if (open) hf.expanded.delete(r.id); else { hf.expanded.add(r.id); loadFiles(r.id); } renderResults(); };
    card.appendChild(head);
    if (open) card.appendChild(renderFiles(r.id));
    body.appendChild(card);
  }
  if (hf.onlyFits && checking) body.appendChild(el('div', 'sys', `Checking ${checking} more for fit…`));
  if (hf.onlyFits && !checking && !body.children.length && !hf.status) body.appendChild(el('div', 'empty', "None of these results fit this PC. Try a different search, or turn the checkbox off to see everything."));
  body.scrollTop = keepScroll;
}

function renderFiles(repo) {
  const box = el('div', 'files');
  const f = hf.files.get(repo);
  if (!f || f.loading) { box.appendChild(el('div', 'sys', 'Loading files…')); return box; }
  if (f.error) {
    box.appendChild(el('div', 'errline', esc(f.error)));
    const b = el('button', 'small', 'Retry'); b.type = 'button'; b.onclick = () => { hf.files.delete(repo); loadFiles(repo); };
    box.appendChild(b); return box;
  }
  const usable = f.list.filter((x) => !x.split && !x.projector).sort((a, b) => a.size - b.size);
  const hidden = f.list.length - usable.length;
  const best = bestFile(f.list);
  if (!usable.length) box.appendChild(el('div', 'sys', 'No single-file GGUF models here.' + (hidden ? ' (Split and vision-projector files aren\'t supported yet.)' : '')));
  for (const file of usable) {
    const key = `${repo}/${file.path}`; const d = dls.get(key); const fit = fitOf(file.size);
    const row = el('div', 'frow');
    const q = quantOf(file.path);
    row.innerHTML = `<div class="fn"><span class="q">${esc(q || 'GGUF')}</span>${file === best ? '<span class="star" title="Good balance of quality and size for this PC">Recommended</span>' : ''}<div class="ff">${esc(file.path)}</div></div>` +
      `<div class="fs">${file.size ? fmtSize(file.size) : '?'}</div>` +
      `<div class="fit ${fit?.cls || ''}">${fit ? esc(fit.text) : ''}</div>`;
    const act = el('div', 'fa');
    if (file.installed || d?.state === 'done') act.appendChild(el('span', 'okline', '✓ Installed'));
    else if (d && d.state === 'downloading') act.appendChild(el('span', 'dim', 'Downloading…'));
    else {
      const b = el('button', 'small' + (file === best ? ' primary' : ''), file.partial ? `Resume ${Math.round((file.partial / file.size) * 100)}%` : 'Download'); b.type = 'button';
      b.onclick = () => startDownload(repo, file);
      act.appendChild(b);
    }
    row.appendChild(act); box.appendChild(row);
  }
  if (hidden) box.appendChild(el('div', 'sys', `${hidden} split / vision-projector file(s) hidden.`));
  const link = el('button', 'ghost small', 'View on Hugging Face ' + ic('external', 12)); link.type = 'button';
  link.onclick = () => api.openExternal(`https://huggingface.co/${repo}`);
  box.appendChild(link);
  return box;
}

/* ---------------- Downloads ---------------- */
async function startDownload(repo, f) {
  // a no-op if network is already on (e.g. the Get Models dialog already turned it on for this session);
  // otherwise asks, and goes back offline right after the request is sent (not after the download finishes —
  // once the connection is open, switching this back off doesn't interrupt it).
  const release = await ensureNetwork('Downloading this model needs network access.');
  if (!release) return;
  try {
    const key = `${repo}/${f.path}`;
    dls.set(key, { key, repo, file: f.path, size: f.size, received: f.partial || 0, total: f.size, speed: 0, state: 'downloading' });
    renderPanel(); renderResults(); updateChip();
    try { await api.dlStart({ repo, file: f.path, size: f.size }); }
    catch (e) { const d = dls.get(key); if (d) { d.state = 'error'; d.message = cleanErr(e); } renderPanel(); renderResults(); }
  } finally { release(); }
}

function markFile(repo, path, patch) {
  const f = hf.files.get(repo)?.list?.find((x) => x.path === path);
  if (f) Object.assign(f, patch);
}

function progressText(d) {
  const eta = d.speed > 0 && d.total ? fmtEta((d.total - d.received) / d.speed) : '';
  return `${fmtSize(d.received)} / ${d.total ? fmtSize(d.total) : '?'}` + (d.speed > 0 ? ` · ${fmtSize(d.speed)}/s` : '') + (eta ? ` · ${eta} left` : '');
}

function renderPanel() {
  const p = $('dlPanel'); p.innerHTML = ''; rowRefs.clear();
  p.hidden = !dls.size;
  for (const d of dls.values()) {
    const row = el('div', 'dl-row ' + d.state);
    const name = d.file.split('/').pop().replace(/\.gguf$/i, '');
    const top = el('div', 'dl-top'); top.innerHTML = `<span class="dl-name" title="${esc(d.repo + '/' + d.file)}">${esc(name)}</span>`;
    const btns = el('span', 'dl-btns');
    const mk = (label, fn, cls = 'small') => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; btns.appendChild(b); };
    const bar = el('div', 'bar thin'); const fill = el('div', 'bar-fill'); bar.appendChild(fill);
    const stat = el('div', 'dl-stat');
    if (d.state === 'downloading') {
      mk('Pause', () => api.dlStop({ key: d.key, discard: false })); mk('Cancel', () => api.dlStop({ key: d.key, discard: true }), 'small danger');
    } else if (d.state === 'paused') {
      mk('Resume', () => startDownload(d.repo, { path: d.file, size: d.size, partial: d.received }), 'small primary');
      mk('Discard', () => { api.dlStop({ key: d.key, discard: true }); dls.delete(d.key); markFile(d.repo, d.file, { partial: 0 }); renderPanel(); renderResults(); updateChip(); });
    } else if (d.state === 'error') {
      mk('Retry', () => startDownload(d.repo, { path: d.file, size: d.size, partial: d.received }), 'small primary');
      mk('Dismiss', () => { dls.delete(d.key); renderPanel(); updateChip(); });
    } else if (d.state === 'done') {
      if (d.id) mk('Load model', () => { closeBrowser(); showTab('models'); selectModel(d.id); }, 'small primary');
      mk('Dismiss', () => { dls.delete(d.key); renderPanel(); updateChip(); });
    }
    top.appendChild(btns);
    row.append(top, bar, stat); p.appendChild(row);
    rowRefs.set(d.key, { fill, stat });
    updateRow(d.key);
  }
}

function updateRow(key) {
  const d = dls.get(key), r = rowRefs.get(key); if (!d || !r) return;
  const pct = d.total ? Math.min(100, (d.received / d.total) * 100) : 0;
  r.fill.style.width = (d.state === 'done' ? 100 : pct) + '%';
  r.stat.className = 'dl-stat' + (d.state === 'error' ? ' err' : '');
  r.stat.textContent = d.state === 'downloading' ? progressText(d)
    : d.state === 'paused' ? `Paused at ${Math.round(pct)}% (${fmtSize(d.received)})`
    : d.state === 'error' ? d.message : 'Downloaded and added to your models';
}

function updateChip() {
  const active = [...dls.values()].filter((d) => d.state === 'downloading');
  const chip = $('dlChip');
  chip.hidden = !active.length;
  if (active.length) {
    const rec = active.reduce((a, d) => a + d.received, 0), tot = active.reduce((a, d) => a + (d.total || 0), 0);
    chip.textContent = `${active.length} downloading` + (tot ? ` · ${Math.round((rec / tot) * 100)}%` : '');
  }
}

api.onDlProgress((p) => {
  const d = dls.get(p.key); if (!d) return;
  Object.assign(d, { received: p.received, total: p.total || d.total, speed: p.speed, state: 'downloading' });
  updateRow(p.key); updateChip();
});

api.onDlState((ev) => {
  const d = dls.get(ev.key); if (!d) return;
  d.state = ev.state; d.message = ev.message; d.speed = 0;
  if (ev.state === 'done') {
    d.id = ev.id; d.received = d.total = d.total || d.received;
    if (ev.models) { models = ev.models; renderModels(); renderChat(); } // speech models etc. are not chat models
    markFile(d.repo, d.file, { installed: true, partial: 0 });
    toast(`Downloaded ${d.file.split('/').pop().replace(/\.gguf$/i, '')}`);
  } else if (ev.state === 'cancelled') { dls.delete(ev.key); markFile(d.repo, d.file, { partial: 0 }); }
  else if (ev.state === 'paused') markFile(d.repo, d.file, { partial: d.received });
  renderPanel(); renderResults(); updateChip();
});

/* ---------------- Wiring ---------------- */
$('getModels').onclick = openBrowser;
$('dlChip').onclick = openBrowser;
$('closeBrowser').onclick = closeBrowser;
$('browser').addEventListener('mousedown', (e) => { if (e.target === $('browser')) closeBrowser(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('browser').hidden) closeBrowser(); });
$('hfForm').onsubmit = (e) => { e.preventDefault(); runSearch($('hfQuery').value); };
$('hfOnlyFits').onchange = () => { hf.onlyFits = $('hfOnlyFits').checked; store.set('mull.onlyFits', hf.onlyFits); renderResults(); };
$('dirChange').onclick = async () => { $('dirText').textContent = await api.chooseModelsDir(); };
