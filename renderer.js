'use strict';
const $ = (id) => document.getElementById(id);
const replay = (node, cls) => { node.classList.remove(cls); void node.offsetWidth; node.classList.add(cls); }; // restart a CSS animation
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(1) + ' GB' : (b / 1e6).toFixed(0) + ' MB');
function relTimeShort(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.round(s / 60) + 'm';
  if (s < 86400) return Math.round(s / 3600) + 'h';
  if (s < 604800) return Math.round(s / 86400) + 'd';
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
const cleanErr = (e) => String(e?.message || e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');

const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

/* ---------------- Settings ---------------- */
const DEFAULTS = {
  theme: 'dark', fontSize: 14, enterToSend: true, autoScroll: true,
  system: 'You are a helpful assistant.', temperature: 0.7, topP: 0.95, topK: 40, minP: 0, repeatPenalty: 1.1, maxTokens: 0, seed: '',
  contextSize: '8192', gpuLayers: 'auto', flashAttention: 'auto', threads: 0, mmap: true,
  showThinking: true, liveThinking: true, randomThinking: true, expandThinking: true, thinkingMode: 'default', thinkingBudget: 2048,
  statusDetail: true, showStats: true, verboseLog: false, logTimestamps: true,
  animations: 'on', speakVoice: '', speakRate: 1, autoRead: false, docsK: 5, personaId: 'default',
};
const PRESETS = {
  Precise: { temperature: 0.2, topP: 0.9, topK: 20, minP: 0.05, repeatPenalty: 1.1 },
  Balanced: { temperature: 0.7, topP: 0.95, topK: 40, minP: 0, repeatPenalty: 1.1 },
  Creative: { temperature: 1.1, topP: 0.98, topK: 80, minP: 0.02, repeatPenalty: 1.05 },
};
let settings = { ...DEFAULTS, ...store.get('lac.settings', {}) };
if (settings.animations === true) settings.animations = 'on'; else if (settings.animations === false) settings.animations = 'off'; // older versions stored a boolean
const saveSettings = () => store.set('lac.settings', settings);

const sysDark = window.matchMedia('(prefers-color-scheme: dark)');
function applySettings() {
  const theme = settings.theme === 'system' ? (sysDark.matches ? 'dark' : 'light') : settings.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.motion = ['on', 'system', 'off'].includes(settings.animations) ? settings.animations : 'on';
  $('hl-dark').disabled = theme !== 'dark'; $('hl-light').disabled = theme === 'dark'; // code highlighting theme
  document.documentElement.style.setProperty('--fs', settings.fontSize + 'px');
  $('logPanel').hidden = !settings.verboseLog;
  $('toggleLog').classList.toggle('on', settings.verboseLog);
  $('toggleLog').style.color = settings.verboseLog ? 'var(--accent)' : '';
}
sysDark.addEventListener('change', applySettings);

const loadOpts = (id = activeId) => ({
  contextSize: S('contextSize', id) === 'auto' ? 'auto' : +S('contextSize', id),
  gpuLayers: S('gpuLayers', id) === 'auto' || S('gpuLayers', id) === 'max' ? S('gpuLayers', id) : +S('gpuLayers', id),
  flashAttention: S('flashAttention', id),
  threads: +S('threads', id) || 0,
  mmap: !!S('mmap', id),
});

/* ---------------- State ---------------- */
let models = [];
let activeId = null, activeMeta = null, loadedSnapshot = '';
let busy = false;       // loading a model or generating
let generating = false;
let run = null;         // live generation timing
let chats = [];
let curId = null;
let sysInfo = null;

const cur = () => chats.find((c) => c.id === curId);
let saveTimer = null;
const saveChats = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flushChats, 250); };
const flushChats = () => { clearTimeout(saveTimer); return api.saveChats(chats).catch(() => {}); };
window.addEventListener('beforeunload', flushChats);
/* ---------------- Online / Offline ----------------
   Offline (the default) is enforced in the main process; this just asks first and remembers to turn
   it back off. Call sites: await the result — null means the person said no (abort), otherwise it's a
   release() to call once whatever needed the network is done ("done" being: the request that actually
   opens the connection has fired, since flipping the pref back doesn't interrupt anything already
   in flight). A shared counter means an already-online session (or one already open elsewhere) is a
   no-op release, so nested/concurrent callers compose correctly. */
let netTempCount = 0;
function turnNetworkOn() {
  netTempCount++;
  // deliberately NOT api.setPrefs({networkMode:'online'}) — this is a temporary, in-memory-only session
  // (see the comment by tempNetworkOn in main.js), so an unclean shutdown mid-session can't leave the
  // next launch silently online.
  return api.netTempOn().then(async () => { prefs = await api.getPrefs(); updateNetIndicator();
    return () => {
      if (netTempCount <= 0) return;
      if (--netTempCount === 0) api.netTempOff().then(async () => { prefs = await api.getPrefs(); updateNetIndicator(); });
    };
  });
}
async function ensureNetwork(reason) {
  prefs = await api.getPrefs();
  if (prefs.networkMode === 'online') return () => {};
  if (!confirm(`${reason}\n\nMull is offline. Turn on network access temporarily? It switches back to offline automatically once this is done.`)) return null;
  return turnNetworkOn();
}
/* Same as ensureNetwork, but never asks — for the first-run wizard, where running it at all already
   implies wanting to see and download recommended models. */
async function silentNetworkOn() {
  prefs = await api.getPrefs();
  if (prefs.networkMode === 'online') return () => {};
  return turnNetworkOn();
}
function updateNetIndicator() {
  const b = $('netMode'); if (!b || !prefs) return;
  const on = prefs.networkMode === 'online' || prefs.netTemp;
  b.innerHTML = ic(on ? 'globe' : 'globe-off', 14) + '<span>' + (on ? 'Online' : 'Offline') + '</span>';
  b.classList.toggle('on', on);
  b.title = on ? 'Network access is on — click to go offline' : 'Mull is offline — click to allow network access';
}
$('netMode').onclick = async () => {
  // this is the explicit, standing choice, so (unlike a temporary session) it's fine for this one to persist
  prefs = await api.setPrefs({ networkMode: prefs.networkMode === 'online' ? 'offline' : 'online' });
  netTempCount = 0; updateNetIndicator();
  toast(prefs.networkMode === 'online' ? 'Network access is on' : 'Mull is offline');
};

function toast(msg, ms = 2600) {
  const t = $('toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => { t.hidden = true; }, ms);
}

/* ---------------- Status pill / activity ---------------- */
const DOT = { idle: 'var(--dim)', loading: 'var(--warn)', ready: 'var(--ok)', prompt: 'var(--accent)', thinking: 'var(--think)', generating: 'var(--accent)', error: 'var(--danger)' };
function setState(state, label) {
  const p = $('pill'); p.dataset.state = state; p.textContent = label;
  $('dot').style.background = DOT[state] || DOT.idle;
}
function setActivity(left, right = '') { $('actText').textContent = left; $('actRight').textContent = right; }

/* ---------------- Verbose log ---------------- */
const logBuf = [];
const pad = (n, w = 2) => String(n).padStart(w, '0');
function fmtTime(t) { const d = new Date(t); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; }
function addLog(e) {
  logBuf.push(e); if (logBuf.length > 500) logBuf.shift();
  const body = $('logBody');
  const stick = body.scrollTop + body.clientHeight >= body.scrollHeight - 20;
  body.appendChild(logLine(e));
  while (body.childElementCount > 500) body.firstChild.remove();
  if (stick) body.scrollTop = body.scrollHeight;
}
function logLine(e) {
  const d = el('div', 'll ' + e.level);
  d.textContent = (settings.logTimestamps ? '' : '') + e.msg;
  if (settings.logTimestamps) { const t = el('span', 't'); t.textContent = fmtTime(e.t); d.prepend(t); }
  return d;
}
const rlog = (level, msg) => addLog({ t: Date.now(), level, msg });
function rebuildLog() { const b = $('logBody'); b.innerHTML = ''; logBuf.forEach((e) => b.appendChild(logLine(e))); b.scrollTop = b.scrollHeight; }
api.onLog(addLog);

/* ---------------- Sidebar: models ---------------- */
let favModelIds = new Set(store.get('mull.favModels', []));
const saveFavs = () => store.set('mull.favModels', [...favModelIds]);
const isFav = (id) => favModelIds.has(id);
function toggleFav(id) {
  if (favModelIds.has(id)) favModelIds.delete(id); else favModelIds.add(id);
  saveFavs(); renderModels(); renderFavorites();
}
function buildModelItem(m) {
  const on = m.id === activeId, fav = isFav(m.id);
  const it = el('div', 'item model' + (on ? ' active' : ''));
  const sub = on && activeMeta ? `${activeMeta.backend} · ${activeMeta.contextSize} ctx · loaded in ${activeMeta.loadSeconds.toFixed(1)}s` : 'Click to load';
  it.innerHTML = `<div class="row"><span class="n">${esc(m.name)}</span>${on ? '<span class="badge">LOADED</span>' : ''}` +
    `<button class="fav${fav ? ' on' : ''}" title="${fav ? 'Remove from favorites' : 'Add to favorites'}" type="button">${ic('star', 14)}</button>` +
    `<button class="ib" title="Model details" type="button">${ic('info', 14)}</button><button class="x" title="Remove from list" type="button">${ic('x', 14)}</button></div>` +
    `<div class="s">${fmtSize(m.size)}${m.source ? ' · from ' + esc(m.source === 'lmstudio' ? 'LM Studio' : m.source) : ''} · ${esc(sub)}</div>`;
  it.onclick = () => selectModel(m.id);
  it.querySelector('.fav').onclick = (e) => { e.stopPropagation(); toggleFav(m.id); };
  it.querySelector('.ib').onclick = (e) => { e.stopPropagation(); showModelInfo(m); };
  it.querySelector('.x').onclick = async (e) => {
    e.stopPropagation();
    if (busy) return;
    if (on) ejectModel();
    models = await api.removeModel(m.id); renderModels(); renderFavorites();
  };
  return it;
}
function renderModels() {
  const box = $('models'); box.innerHTML = '';
  if (!models.length) { box.innerHTML = '<div class="empty">No models yet.<br>Import or drop a .gguf file here.</div>'; return; }
  for (const m of models) box.appendChild(buildModelItem(m));
  if (!$('tab-favorites').hidden) renderFavorites();
}
function renderFavorites() {
  const box = $('favModels'); if (!box) return; box.innerHTML = '';
  const favs = models.filter((m) => isFav(m.id));
  if (!favs.length) { box.innerHTML = '<div class="empty">No favorites yet.<br>Click the star on a model in My Models to add it here.</div>'; return; }
  for (const m of favs) box.appendChild(buildModelItem(m));
}

/* ---------------- Model loading + progress ---------------- */
const STEPS = ['engine', 'model', 'context', 'ready'];
let loadT0 = 0, loadTimer = null, loadingActive = false;
function overall(s) {
  if (s.phase === 'engine') return 0.03;
  if (s.phase === 'model') return 0.05 + (s.progress || 0) * 0.85;
  if (s.phase === 'context') return 0.93;
  if (s.phase === 'ready') return 1;
  return 0;
}
function showLoader(name) {
  loadingActive = true; loadT0 = performance.now();
  $('lTitle').textContent = 'Loading ' + name; $('lMsg').textContent = 'Starting…'; $('lMsg').className = 'l-msg';
  $('lFill').style.width = '0%'; $('lPct').textContent = '0%';
  document.querySelectorAll('#lSteps li').forEach((li) => { li.className = ''; });
  $('lClose')?.remove();
  $('loader').hidden = false;
  clearInterval(loadTimer);
  loadTimer = setInterval(() => { $('lElapsed').textContent = ((performance.now() - loadT0) / 1000).toFixed(1) + 's'; }, 100);
  setState('loading', 'Loading model');
  setActivity('Loading model…');
}
function hideLoader() { loadingActive = false; clearInterval(loadTimer); $('loader').hidden = true; }
api.onModelStatus((s) => {
  if (!loadingActive) return;
  const pct = overall(s);
  const fill = $('lFill');
  fill.classList.toggle('indet', s.phase === 'engine' || s.phase === 'context');
  fill.style.width = Math.round(pct * 100) + '%';
  $('lPct').textContent = Math.round(pct * 100) + '%';
  if (s.phase === 'error') {
    document.querySelector('#lSteps li.now')?.classList.replace('now', 'err');
    $('lMsg').textContent = s.message; $('lMsg').className = 'l-msg err';
    return;
  }
  $('lMsg').textContent = s.message || '';
  const idx = STEPS.indexOf(s.phase);
  document.querySelectorAll('#lSteps li').forEach((li, i) => {
    li.className = i < idx ? 'done' : i === idx ? (s.phase === 'ready' ? 'done' : 'now') : '';
  });
  if (s.phase === 'model') setActivity(`Loading weights… ${Math.round((s.progress || 0) * 100)}%`);
  else if (s.message) setActivity(s.message);
});

// Errors that usually mean "not enough memory for these settings", where a smaller context / CPU-only load might succeed.
const OOM_RE = /out of memory|insufficient|not enough|alloc|vram|cuda error|failed to allocate|std::bad_alloc/i;
const SAFE_FALLBACK = { contextSize: 4096, gpuLayers: 0, flashAttention: 'off', threads: 0, mmap: true };

async function selectModel(id, forcedOpts) {
  if ((busy || id === activeId) && !forcedOpts) return;
  const m = models.find((x) => x.id === id); if (!m) return;
  busy = true; setActive(null); showLoader(m.name);
  const opts = forcedOpts || loadOpts(id);
  try {
    activeMeta = await api.loadModel(id, opts);
    loadedSnapshot = forcedOpts ? '' : JSON.stringify(opts); // a fallback load doesn't match any saved settings; keep the "reload to apply" hint available
    setActive(id, activeMeta);
    setTimeout(hideLoader, 450);
    toast(forcedOpts ? `${m.name} ready with reduced settings · ${activeMeta.backend}` : `${m.name} ready · ${activeMeta.backend}`);
  } catch (e) {
    setState('error', 'Load failed'); setActivity('Model failed to load');
    const msg = cleanErr(e);
    $('lMsg').textContent = msg; $('lMsg').className = 'l-msg err';
    const row = el('div'); row.style.marginTop = '12px'; row.style.display = 'flex'; row.style.gap = '8px'; row.style.justifyContent = 'center';
    row.id = 'lClose';
    if (!forcedOpts && OOM_RE.test(msg) && (opts.gpuLayers !== 0 || opts.contextSize > 4096)) {
      const retry = el('button', 'primary small', 'Try with reduced memory use'); retry.type = 'button';
      retry.title = 'CPU only, 4,096 token context — just for this attempt';
      retry.onclick = () => { hideLoader(); selectModel(id, SAFE_FALLBACK); };
      row.appendChild(retry);
    }
    const b = el('button', 'small', 'Close'); b.type = 'button';
    b.onclick = hideLoader; row.appendChild(b);
    document.querySelector('#loader .card').appendChild(row);
    clearInterval(loadTimer);
  } finally { busy = false; syncSettingsFoot(); }
}
async function ejectModel() {
  if (generating) return;
  await api.unloadModel(); setActive(null); toast('Model ejected');
}
function setActive(id, meta) {
  activeId = id; activeMeta = id ? meta : null;
  const on = !!id;
  $('input').disabled = !on; $('go').disabled = !on;
  $('input').placeholder = on ? 'Message… ' + (settings.enterToSend ? '(Enter to send, Shift+Enter for a new line)' : '(Ctrl+Enter to send)') : 'Load a model to start chatting…';
  const m = models.find((x) => x.id === id);
  $('chipText').textContent = on ? `${m?.name} · ${meta.backend}` : 'No model loaded';
  $('eject').hidden = !on; $('ctxMeter').hidden = !on;
  if (on) { updateCtx(0, meta.contextSize); setState('ready', 'Ready'); setActivity(`Ready · ${meta.contextSize.toLocaleString()} token context`); $('input').focus(); }
  else { setState('idle', 'Idle'); setActivity('Load a model to begin.'); }
  renderModels(); renderChat();
}
function updateCtx(used, size) {
  const p = size ? used / size : 0;
  const f = $('ctxFill'); f.style.width = Math.min(100, p * 100) + '%';
  f.classList.toggle('hot', p > 0.75); f.classList.toggle('full', p > 0.92);
  $('ctxText').textContent = `${used.toLocaleString()} / ${size.toLocaleString()}`;
}

/* ---------------- Chats ---------------- */
let chatFilter = '';
const chatSort = (a, b) => (+!!b.pinned - +!!a.pinned) || ((b.updated || b.created) - (a.updated || a.created));
const touch = (c) => { c.updated = Date.now(); };

function newChat() {
  if (generating) return;
  const c = cur();
  if (c && !c.messages.length) { $('input').focus(); return; }
  const n = { id: 'c' + Date.now(), title: 'New chat', created: Date.now(), updated: Date.now(), pinned: false, messages: [] };
  chats.unshift(n); curId = n.id; chatFilter = ''; $('chatSearch').value = '';
  saveChats(); renderChatList(); renderChat();
  $('input').focus();
}

function chatSnippet(c, q) {
  const m = c.messages.find((x) => x.content.toLowerCase().includes(q));
  if (!m) return '';
  const i = m.content.toLowerCase().indexOf(q);
  const from = Math.max(0, i - 18);
  return (from ? '…' : '') + m.content.slice(from, from + 60).replace(/\s+/g, ' ');
}

function renderChatList() {
  const box = $('chatList'); box.innerHTML = '';
  const q = chatFilter.trim().toLowerCase();
  const shown = chats.filter((c) => !q || c.title.toLowerCase().includes(q) || c.messages.some((m) => m.content.toLowerCase().includes(q))).sort(chatSort);
  if (!shown.length) { box.appendChild(el('div', 'empty', q ? 'No chats match your search.' : 'No chats yet.')); return; }
  for (const c of shown) {
    const it = el('div', 'item chat' + (c.id === curId ? ' active' : ''));
    const snip = q && !c.title.toLowerCase().includes(q) ? chatSnippet(c, q) : '';
    it.innerHTML = `<div class="col"><div class="row">${c.pinned ? '<span class="pin" title="Pinned">' + ic('pin', 12) + '</span>' : ''}<span class="n">${esc(c.title)}</span></div>${snip ? `<div class="s">${esc(snip)}</div>` : ''}</div><span class="ts">${relTimeShort(c.updated || c.created)}</span><button class="more" title="More" type="button">${ic('more', 16)}</button>`;
    it.onclick = () => { if (generating) return; curId = c.id; renderChatList(); renderChat(); };
    it.ondblclick = () => { if (!generating) renameChat(c, it); };
    it.oncontextmenu = (e) => { e.preventDefault(); chatMenu(c, it, e.clientX, e.clientY); };
    it.querySelector('.more').onclick = (e) => { e.stopPropagation(); const r = e.currentTarget.getBoundingClientRect(); chatMenu(c, it, r.left, r.bottom + 2); };
    box.appendChild(it);
  }
}

function chatMenu(c, it, x, y) {
  showMenu(x, y, [
    { icon: 'pencil', label: 'Rename', fn: () => renameChat(c, it) },
    { icon: 'pin', label: c.pinned ? 'Unpin' : 'Pin to top', fn: () => { c.pinned = !c.pinned; saveChats(); renderChatList(); } },
    '-',
    { icon: 'download', label: 'Export as Markdown…', fn: () => exportChat(c, 'md') },
    { icon: 'download', label: 'Export as JSON…', fn: () => exportChat(c, 'json') },
    '-',
    { icon: 'trash', label: 'Delete chat', danger: true, fn: () => deleteChat(c) },
  ]);
}

function renameChat(c, it) {
  const n = it.querySelector('.n'); if (!n) return;
  const inp = el('input', 'rename'); inp.value = c.title; n.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const commit = (save) => {
    if (done) return; done = true;
    if (save && inp.value.trim() && inp.value.trim() !== c.title) { c.title = inp.value.trim().slice(0, 80); saveChats(); }
    renderChatList();
  };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') commit(true); else if (e.key === 'Escape') commit(false); };
  inp.onblur = () => commit(true);
  inp.onclick = (e) => e.stopPropagation();
  inp.ondblclick = (e) => e.stopPropagation();
}

function deleteChat(c) {
  if (generating) return;
  if (c.messages.length && !confirm(`Delete "${c.title}"?`)) return;
  c.docs?.forEach((d) => api.removeDoc(d.id));
  chats = chats.filter((x) => x.id !== c.id);
  if (!chats.length) { curId = null; saveChats(); newChat(); return; }
  if (curId === c.id) curId = [...chats].sort(chatSort)[0].id;
  saveChats(); renderChatList(); renderChat();
}

function chatToMarkdown(c) {
  let out = `# ${c.title}\n\n_Exported from Mull · started ${new Date(c.created).toLocaleString()}_\n\n`;
  for (const m of c.messages) {
    if (m.role === 'user') { out += `## You\n\n${m.content}\n\n`; continue; }
    out += '## Assistant\n\n';
    if (m.thought) out += `<details><summary>${thinkLabel(m)}</summary>\n\n${m.thought.trim()}\n\n</details>\n\n`;
    out += `${m.content}\n\n`;
  }
  return out.trimEnd() + '\n';
}
const chatToJson = (c) => JSON.stringify({ app: 'Mull', version: 1, chat: c }, null, 2);

async function exportChat(c, ext) {
  const safe = c.title.replace(/[^\w\- ]+/g, '').trim().slice(0, 50) || 'chat';
  const path = await api.saveFile({ name: `${safe}.${ext}`, ext, content: ext === 'md' ? chatToMarkdown(c) : chatToJson(c) });
  if (path) toast('Exported ' + path.split(/[\\/]/).pop());
}

/* Switch to a chat and scroll to (and briefly highlight) one of its messages. Used by search / the command palette. */
function jumpToMessage(chatId, idx) {
  if (generating) { toast('Wait for the current reply to finish'); return; }
  if (chatId !== curId) { curId = chatId; renderChatList(); renderChat(); }
  const wrap = chatEl.querySelectorAll('.msg')[idx];
  if (!wrap) return;
  wrap.scrollIntoView({ block: 'center' });
  wrap.classList.add('flash'); setTimeout(() => wrap.classList.remove('flash'), 1400);
}

/* Context menu (used by the chat list) */
function showMenu(x, y, items) {
  const m = $('menu'); m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.appendChild(el('div', 'sep')); continue; }
    const b = el('button', it.danger ? 'danger-i' : ''); b.type = 'button'; b.innerHTML = it.icon ? ic(it.icon, 15) : '<span class="ic-sp"></span>'; const lab = el('span'); lab.textContent = it.label; b.appendChild(lab);
    b.onclick = () => { hideMenu(); it.fn(); };
    m.appendChild(b);
  }
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = Math.max(4, Math.min(x, innerWidth - r.width - 8)) + 'px';
  m.style.top = Math.max(4, Math.min(y, innerHeight - r.height - 8)) + 'px';
}
const hideMenu = () => { $('menu').hidden = true; };
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) hideMenu(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideMenu(); });
window.addEventListener('blur', hideMenu);

/* Edit an earlier message and resend from that point */
function startEdit(i) {
  if (generating || !activeId) return;
  const c = cur(); const m = c.messages[i];
  const wrap = chatEl.querySelectorAll('.msg')[i]; if (!m || !wrap) return;
  const later = c.messages.length - 1 - i;
  wrap.innerHTML = ''; wrap.classList.add('editing');
  const ta = el('textarea', 'edit-ta'); ta.value = m.content;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(320, ta.scrollHeight) + 'px'; };
  ta.oninput = grow;
  const row = el('div', 'edit-row');
  const save = el('button', 'primary small', 'Save & resend'); save.type = 'button';
  const cancel = el('button', 'small', 'Cancel'); cancel.type = 'button';
  row.append(save, cancel);
  if (later > 0) row.appendChild(el('span', 'note-inline', `Replaces the ${later} message${later > 1 ? 's' : ''} after it.`));
  wrap.append(ta, row); grow(); ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
  cancel.onclick = () => renderChat();
  save.onclick = () => {
    const text = ta.value.trim(); if (!text) return;
    c.messages.length = i; c.messages.push({ role: 'user', content: text }); touch(c);
    saveChats(); renderChat(); generate();
  };
  ta.onkeydown = (e) => {
    if (e.key === 'Escape') renderChat();
    else if (e.key === 'Enter' && (e.ctrlKey || !e.shiftKey)) { e.preventDefault(); save.click(); }
  };
}

/* ---------------- Message rendering ---------------- */
const chatEl = $('chat');
const nearBottom = () => chatEl.scrollTop + chatEl.clientHeight >= chatEl.scrollHeight - 90;
const scrollDown = () => { chatEl.scrollTop = chatEl.scrollHeight; };

function withCursor(html, live) {
  if (!live) return html;
  const cur = '<span class="cur">▋</span>';
  return /<\/(p|li|h\d)>$/.test(html) ? html.replace(/(<\/(p|li|h\d)>)$/, cur + '$1') : html + cur;
}
function thinkLabel(m) { return `Thought for ${(m.thoughtSecs ?? 0).toFixed(1)}s`; }
// Thinking animation pool. One is picked at random per message (never the same twice in a row),
// with a random colour pair and speed, and it swaps to a new one every few seconds while the model thinks.
const ANIMS = { bars: 5, orbit: 3, ripple: 3, morph: 1, wave: 5, sparks: 9 };
const VERBS = ['Thinking', 'Pondering', 'Reasoning', 'Mulling it over', 'Connecting the dots', 'Working it out', 'Weighing options', 'Chasing an idea', 'Turning it over'];
const PALETTES = [['#4ade80', '#a3e635'], ['#2dd4bf', '#4ade80'], ['#a3e635', '#d9f99d'], ['#34d399', '#86efac'], ['#22c55e', '#bef264'], ['#5eead4', '#34d572']];
const pick = (arr, not) => { const a = arr.filter((x) => x !== not); return a[Math.floor(Math.random() * a.length)]; };
let lastAnim = null;
const animHTML = (name = 'bars') => `<span class="anim a-${name}">${'<i></i>'.repeat(ANIMS[name])}</span>`;
function nextAnim() { return (lastAnim = settings.randomThinking ? pick(Object.keys(ANIMS), lastAnim) : 'bars'); }
function makeThink(open, anim) {
  const d = el('details', 'think');
  d.open = open;
  d.innerHTML = `<summary><span class="ind">${animHTML(anim)}</span><span class="lbl">Thinking</span><span class="meta"></span></summary><div class="tbody"></div>`;
  if (anim && settings.randomThinking) {
    const [c1, c2] = pick(PALETTES);
    d.style.setProperty('--c1', c1); d.style.setProperty('--c2', c2);
    d.style.setProperty('--spd', (0.8 + Math.random() * 0.5).toFixed(2));
  }
  return d;
}
// While a block is live: rotate the label verb, and every other tick swap the animation for another one.
function startThinkFlair(r) {
  let n = 0;
  r.flair = setInterval(() => {
    const d = r.think; if (!d || !d.classList.contains('live')) return;
    const lbl = d.querySelector('.lbl');
    if (settings.randomThinking) {
      lbl.textContent = pick(VERBS, lbl.textContent);
      if (++n % 2 === 0) d.querySelector('.ind').innerHTML = animHTML(nextAnim());
    }
  }, 2600);
}
// Swap the wave animation for a check mark. Animated when a live block finishes, instant for saved messages.
function finishThink(d, animate) {
  const ind = d.querySelector('.ind');
  const done = () => { ind.classList.remove('out'); ind.innerHTML = '<span class="ok">✓</span>'; };
  if (!animate) return done();
  ind.classList.add('out'); setTimeout(done, 300);
}
// Waiting spinner (before the model answers): one of several animations, picked at random per message,
// with its own colours, speed and wording. Thinking has its own pool (see ANIMS).
const WAIT_KINDS = { orb: '<i></i>', atom: '<u></u><u></u><u></u><i></i>', pulse: '<u></u><u></u><u></u><i></i>', radar: '<u></u><i></i>',
  bounce: '<u></u><u></u><u></u>', helix: '<u></u><u></u><u></u><u></u><u></u><u></u><u></u>', blocks: '<u></u><u></u><u></u><u></u>' };
const WAIT_LABELS = ['Reading your message', 'Taking that in', 'Getting my thoughts together', 'Warming up', 'Looking at that', 'Tuning in', 'Loading the context', 'Listening closely'];
let lastWait = null;
function makeWait(label, kind) {
  const w = el('div', 'wait');
  w.innerHTML = '<span class="wk ' + kind + '">' + WAIT_KINDS[kind] + '</span><span><span class="wl"></span><span class="dots"><b></b><b></b><b></b></span><br><span class="wm"></span></span>';
  w.querySelector('.wl').textContent = label;
  // the helix animation staggers each dot by a per-dot --i custom property; set it via the CSSOM
  // (not an inline style="" attribute) so the page's CSP doesn't need to allow inline styles.
  if (kind === 'helix') w.querySelectorAll('.wk u').forEach((u, i) => u.style.setProperty('--i', i));
  return w;
}
function setWait(r, label) {
  if (label === 'Reading your message') label = (r.waitLabel ||= pick(WAIT_LABELS));
  if (!r.wait) {
    if (!r.waitKind) { r.waitKind = settings.randomThinking === false ? 'orb' : (lastWait = pick(Object.keys(WAIT_KINDS), lastWait)); r.waitPal = pick(PALETTES); r.waitSpd = (0.85 + Math.random() * 0.4).toFixed(2); }
    r.wait = makeWait(label, r.waitKind);
    r.wait.style.setProperty('--c1', r.waitPal[0]); r.wait.style.setProperty('--c2', r.waitPal[1]); r.wait.style.setProperty('--spd', r.waitSpd);
    r.bubble.insertBefore(r.wait, r.abody);
  } else r.wait.querySelector('.wl').textContent = label;
}
function dropWait(r) {
  const w = r.wait; if (!w) return;
  r.wait = null; w.classList.add('leaving'); setTimeout(() => w.remove(), 340);
}
function buildFoot(m, i, last) {
  const f = el('div', 'mfoot');
  if (m.role === 'assistant') {
    const s = m.stats;
    if (settings.showStats && s) {
      const bits = [`${s.tokens} tokens`, `${s.tps.toFixed(1)} tok/s`];
      if (s.ttft != null) bits.push(`first token ${s.ttft.toFixed(2)}s`);
      if (s.thoughtTokens) bits.push(`thinking ${s.thoughtSecs.toFixed(1)}s (${s.thoughtTokens} tok)`);
      if (s.stopped) bits.push('stopped');
      f.appendChild(el('span', '', esc(bits.join(' · '))));
    }
    const copy = el('button', '', 'Copy'); copy.type = 'button';
    copy.onclick = () => { navigator.clipboard.writeText(m.content); toast('Copied'); };
    f.appendChild(copy);
    if (window.speechSynthesis && m.content) f.appendChild(speakButton(m));
    if (last && !generating) {
      const r = el('button', '', ic('refresh', 13) + ' Regenerate'); r.type = 'button'; r.disabled = !activeId;
      r.onclick = () => { const c = cur(); c.messages.pop(); saveChats(); generate(); };
      f.appendChild(r);
    }
  } else {
    const copy = el('button', '', 'Copy'); copy.type = 'button';
    copy.onclick = () => { navigator.clipboard.writeText(m.content); toast('Copied'); };
    const edit = el('button', '', ic('pencil', 13) + ' Edit'); edit.type = 'button';
    edit.disabled = generating || !activeId; edit.title = activeId ? 'Edit this message and resend' : 'Load a model to edit and resend';
    edit.onclick = () => startEdit(i);
    f.append(copy, edit);
  }
  return f;
}
function buildMsg(m, i, last, live) {
  const wrap = el('div', 'msg ' + m.role);
  const bubble = el('div', 'bubble');
  const refs = { wrap, bubble };
  if (m.role === 'user') { bubble.textContent = m.content; }
  else {
    if (m.thought && settings.showThinking && !live) {
      const t = makeThink(false); t.querySelector('.lbl').textContent = thinkLabel(m);
      t.querySelector('.meta').textContent = m.stats?.thoughtTokens ? `· ${m.stats.thoughtTokens} tokens` : '';
      t.querySelector('.tbody').textContent = m.thought; finishThink(t, false); bubble.appendChild(t);
    }
    refs.abody = el('div', 'abody'); refs.abody.innerHTML = live ? '' : md(m.content);
    if (!live && m.tools?.length) for (const t of m.tools) bubble.appendChild(toolCard(t));
    bubble.appendChild(refs.abody);
    if (!live && m.sources?.length) bubble.appendChild(buildSources(m.sources));
    if (live) setWait(refs, 'Reading your message');
  }
  wrap.appendChild(bubble);
  if (!live) wrap.appendChild(buildFoot(m, i, last));
  wrap._r = refs;
  return wrap;
}
function renderChat() {
  chatEl.innerHTML = '';
  updateChatChrome();
  const c = cur();
  if (!c || !c.messages.length) {
    const h = el('div', 'hint');
    if (!models.length) h.innerHTML = '<h2>Welcome to Mull</h2><p>Chat with AI models that run entirely on your PC. Start by downloading a model, or import a <b>.gguf</b> file you already have.</p>';
    else if (!activeId) h.innerHTML = '<h2>Pick a model</h2><p>Open the <b>Models</b> tab and click a model to load it.</p>';
    else h.innerHTML = '<h2>Ready</h2><p>Ask anything. Everything stays on this computer.</p>';
    if (!activeId) {
      const b = el('button', 'primary', models.length ? 'Choose a model' : 'Get a model'); b.type = 'button'; b.style.marginTop = '10px';
      b.onclick = () => (models.length ? showTab('models') : openBrowser());
      h.appendChild(b);
    }
    chatEl.appendChild(h); return;
  }
  c.messages.forEach((m, i) => chatEl.appendChild(buildMsg(m, i, i === c.messages.length - 1, false)));
  scrollDown();
}
function notice(text) { const n = el('div', 'notice'); n.textContent = text; chatEl.appendChild(n); scrollDown(); }

chatEl.addEventListener('click', (e) => {
  const b = e.target.closest('.copy'); if (!b) return;
  navigator.clipboard.writeText(b.closest('.code').querySelector('code').textContent);
  b.textContent = 'Copied'; setTimeout(() => { b.textContent = 'Copy'; }, 1200);
});

/* ---------------- Generation ---------------- */
function tick() {
  if (!run) return;
  const now = performance.now();
  const detail = settings.statusDetail;
  const wm = run.r?.wait?.querySelector('.wm');
  if (wm) wm.textContent = ((now - (run.tWait || run.t0)) / 1000).toFixed(1) + 's';
  if (run.phase === 'prompt') {
    setActivity(detail ? `Reading prompt… ${((now - run.t0) / 1000).toFixed(1)}s` : 'Reading prompt…');
  } else if (run.phase === 'thinking') {
    setActivity(detail ? `Thinking… ${((now - run.tThink0) / 1000).toFixed(1)}s` : 'Thinking…',
      detail ? `${run.nThought} tokens` : '');
  } else {
    const secs = (now - run.tFirst) / 1000;
    const n = run.nText + run.nThought;
    setActivity(detail ? `Writing reply… ${((now - run.t0) / 1000).toFixed(1)}s` : 'Writing reply…',
      detail && secs > 0.2 ? `${run.nText} tokens · ${(n / secs).toFixed(1)} tok/s` : '');
    if (secs > 0.2) { const badge = $('tpsBadge'); badge.textContent = (n / secs).toFixed(1) + ' tok/s'; badge.hidden = false; }
  }
}

async function generate() {
  const c = cur();
  if (!c || generating || !activeId) return;
  const history = c.messages.filter((m) => m.role === 'user' || m.content).map(({ role, content }) => ({ role, content }));
  const m = { role: 'assistant', content: '', thought: '' };
  c.messages.push(m);
  const node = buildMsg(m, c.messages.length - 1, false, true); node.classList.add('enter');
  chatEl.querySelector('.hint')?.remove();
  chatEl.querySelectorAll('.mfoot button').forEach((b) => { if (b.textContent.includes('Regenerate')) b.remove(); });
  chatEl.appendChild(node); scrollDown();
  const r = node._r;

  generating = true; busy = true;
  $('go').hidden = true; $('stop').hidden = false; $('input').disabled = false;
  run = { t0: performance.now(), tFirst: null, tThink0: null, tThink1: null, phase: 'prompt', nText: 0, nThought: 0, stopped: false, r, tWait: 0 };
  setState('prompt', 'Reading prompt'); tick();
  const timer = setInterval(tick, 150);

  let pending = false;
  const paint = () => {
    if (pending) return; pending = true;
    requestAnimationFrame(() => {
      pending = false;
      const stick = settings.autoScroll && nearBottom();
      r.abody.innerHTML = m.content ? withCursor(md(m.content), true) : '';
      if (r.think && settings.liveThinking) { const tb = r.think.querySelector('.tbody'); tb.textContent = m.thought; tb.scrollTop = tb.scrollHeight; }
      if (stick) scrollDown();
    });
  };
  const endThought = () => {
    if (run.tThink0 && !run.tThink1) {
      clearInterval(r.flair);
      run.tThink1 = performance.now();
      m.thoughtSecs = (run.tThink1 - run.tThink0) / 1000;
      if (r.think) {
        r.think.classList.remove('live'); r.think.querySelector('.lbl').textContent = thinkLabel(m);
        r.think.querySelector('.meta').textContent = `· ${run.nThought} tokens`;
        r.think.querySelector('.tbody').textContent = m.thought; // filled in at the end when live thinking is off
        finishThink(r.think, true);
        if (settings.liveThinking && settings.expandThinking) r.think.open = false;
      }
      if (!m.content) { run.tWait = run.tThink1; setWait(r, 'Composing the answer'); }
    }
  };

  const off = api.onChatEvent((ev) => {
    if (ev.type === 'thought') {
      const now = performance.now();
      if (!run.tFirst) run.tFirst = now;
      if (!run.tThink0) {
        run.tThink0 = now; run.phase = 'thinking'; setState('thinking', 'Thinking'); tick();
        dropWait(r);
        if (settings.showThinking) {
          r.think = makeThink(settings.liveThinking && settings.expandThinking, nextAnim()); r.think.classList.add('live');
          startThinkFlair(r);
          r.bubble.insertBefore(r.think, r.abody);
        }
      }
      m.thought += ev.text; run.nThought += ev.n;
      if (ev.end) endThought();
      paint();
    } else if (ev.type === 'text') {
      if (!ev.text && !ev.n) return; // empty marker chunk before the first real token
      const now = performance.now();
      if (!run.tFirst) run.tFirst = now;
      endThought();
      if (m.content || ev.text) dropWait(r);
      if (run.phase !== 'generating') { run.phase = 'generating'; setState('generating', 'Writing'); tick(); }
      m.content += ev.text; run.nText += ev.n;
      paint();
    } else if (ev.type === 'tool') {
      dropWait(r); handleToolEvent(r, m, ev);
    }
  });

  let stopped = false;
  try {
    if (c.docs?.length) setWait(r, 'Searching your documents');
    const ctxInfo = await withDocContext(c, history); // library of attached documents -> excerpts added to the last question
    if (ctxInfo.sources) m.sources = ctxInfo.sources;
    if (run) run.tWait = performance.now();
    const persona = currentPersona(c);
    if (r.wait) setWait(r, 'Reading your message');
    const res = await api.send({
      messages: ctxInfo.messages, system: persona.system,
      gen: {
        temperature: persona.temperature ?? +S('temperature'), topP: +S('topP'), topK: +S('topK'), minP: +S('minP'),
        repeatPenalty: +S('repeatPenalty'), maxTokens: +S('maxTokens') || 0, seed: S('seed'),
      },
      thinking: { mode: S('thinkingMode'), budget: +S('thinkingBudget') || 2048 },
      tools: !!c.tools, autoAllow: [...(c.autoAllow || [])],
    });
    stopped = run.stopped;
    if (res.ctxSize) updateCtx(res.ctxUsed, res.ctxSize);
  } catch (e) {
    const msg = cleanErr(e);
    rlog('error', msg); notice('Error: ' + msg);
    if (!m.content && !m.thought) c.messages.pop();
    setState('error', 'Error');
  } finally {
    off(); clearInterval(timer);
    endThought();
    const now = performance.now();
    const n = run.nText + run.nThought;
    const genSecs = run.tFirst ? (now - run.tFirst) / 1000 : 0;
    if (c.messages.includes(m)) {
      if (!m.content && !m.thought) {
        c.messages.pop(); notice(stopped ? 'Stopped before the model replied.' : 'The model returned an empty response.');
      } else {
        m.stats = {
          tokens: n, tps: genSecs > 0 ? n / genSecs : 0, ttft: run.tFirst ? (run.tFirst - run.t0) / 1000 : null,
          thoughtTokens: run.nThought, thoughtSecs: m.thoughtSecs || 0, stopped,
        };
      }
    }
    if (c.title === 'New chat') { const u = c.messages.find((x) => x.role === 'user'); if (u) c.title = u.content.slice(0, 42).trim() || 'New chat'; }
    touch(c); saveChats(); renderChatList();
    const secs = (now - run.t0) / 1000;
    generating = false; busy = false; const last = run; run = null;
    $('go').hidden = false; $('stop').hidden = true; $('tpsBadge').hidden = true;
    if ($('pill').dataset.state !== 'error') setState('ready', 'Ready');
    setActivity(n ? `${stopped ? 'Stopped' : 'Done'} · ${n} tokens in ${secs.toFixed(1)}s` +
      (last.nThought ? ` · ${last.nThought} thinking` : '') : 'Ready', genSecs > 0 ? `${(n / genSecs).toFixed(1)} tok/s` : '');
    const keep = nearBottom();
    renderChat(); if (keep) scrollDown();
    $('input').focus();
    if (settings.autoRead && m.content && !stopped) speak(m.content, m);
  }
}

function send() {
  const text = $('input').value.trim();
  if (!text || generating || busy || !activeId) return;
  if (!cur()) newChat();
  $('input').value = ''; $('input').style.height = 'auto';
  const c = cur();
  c.messages.push({ role: 'user', content: text });
  chatEl.querySelector('.hint')?.remove();
  { const n = buildMsg(c.messages[c.messages.length - 1], c.messages.length - 1, false, false); n.classList.add('enter'); chatEl.appendChild(n); }
  if (c.title === 'New chat') { c.title = text.slice(0, 42); renderChatList(); }
  touch(c); saveChats(); scrollDown();
  generate();
}

/* ---------------- Settings dialog ---------------- */
let prefs = {};        // preferences owned by the main process (startup, API server, tools, speech, updates)
let sTab = 'general';
let scope = 'all';     // 'all' | 'model': whether generation/loading edits apply to every model or only the loaded one
const PER_MODEL = new Set(['temperature', 'topP', 'topK', 'minP', 'repeatPenalty', 'maxTokens', 'seed', 'system', 'contextSize', 'gpuLayers', 'flashAttention', 'threads', 'mmap', 'thinkingMode', 'thinkingBudget']);
let modelOv = store.get('mull.modelOv', {});
const saveOv = () => store.set('mull.modelOv', modelOv);
/* The effective value of a setting for a model: its own override if it has one, otherwise the global value. */
function S(k, id = activeId) { const o = id && modelOv[id]; return o && k in o ? o[k] : settings[k]; }

const SPEECH_MODELS = [['ggml-tiny.en.bin', 'Tiny · English · 75 MB (fast)'], ['ggml-base.en.bin', 'Base · English · 142 MB'], ['ggml-small.en.bin', 'Small · English · 466 MB (most accurate)'], ['ggml-base.bin', 'Base · multilingual · 142 MB']];
const voiceOptions = () => [['', 'System default'], ...((window.speechSynthesis?.getVoices?.() || []).map((v) => [v.name, `${v.name} (${v.lang})`]))];
const embedOptions = () => {
  const likely = models.filter((m) => /embed|bge|nomic|minilm|e5-|gte-|arctic/i.test(m.name) || m.id === prefs.embedModelId);
  return [['', 'Keyword search (works out of the box)'], ...likely.map((m) => [m.id, m.name])];
};
const apiStatusText = () => {
  const a = prefs.api || {};
  return a.error ? 'Error: ' + a.error : a.running ? `Running · base URL ${a.url}` : 'Off';
};

const SCHEMA = [
  { id: 'general', title: 'General', fields: [
    { k: 'theme', t: 'select', l: 'Theme', o: [['dark', 'Dark'], ['light', 'Light'], ['system', 'Match system']] },
    { k: 'fontSize', t: 'range', l: 'Text size', min: 12, max: 20, step: 1, u: 'px' },
    { k: 'enterToSend', t: 'toggle', l: 'Enter sends message', h: 'When off, Ctrl+Enter sends and Enter adds a new line.' },
    { k: 'autoScroll', t: 'toggle', l: 'Auto-scroll while generating' },
    { k: 'animations', t: 'select', l: 'Animations', o: [['on', 'On'], ['system', 'Follow the Windows setting'], ['off', 'Off (completely still)']], h: 'Entrance effects, smooth transitions and animated spinners. "Follow the Windows setting" turns them off if Windows has animation effects switched off.' },
    { t: 'action', l: 'Setup guide', label: 'Run the setup guide again', fn: () => { closeSettings(); openWizard(); } },
  ] },
  { id: 'gen', title: 'Generation', model: true, fields: [
    { t: 'presets' },
    { k: 'system', t: 'textarea', l: 'Default system prompt', h: 'Used by the "Default" persona. Pick another persona from the top bar to change it per chat.', wide: true },
    { k: 'temperature', t: 'range', l: 'Temperature', min: 0, max: 2, step: 0.05, h: 'Higher is more creative, lower is more focused.' },
    { k: 'topP', t: 'range', l: 'Top-p', min: 0.05, max: 1, step: 0.01, h: 'Only sample from the most likely tokens that add up to this probability.' },
    { k: 'topK', t: 'range', l: 'Top-k', min: 0, max: 200, step: 1, h: 'Only consider the K most likely tokens. 0 disables.' },
    { k: 'minP', t: 'range', l: 'Min-p', min: 0, max: 0.5, step: 0.01, h: 'Drop tokens far less likely than the best one. 0 disables.' },
    { k: 'repeatPenalty', t: 'range', l: 'Repeat penalty', min: 1, max: 1.5, step: 0.01, h: 'Discourages repeating recent tokens. 1.00 disables.' },
    { k: 'maxTokens', t: 'number', l: 'Max response tokens', min: 0, h: '0 means no limit (until the model stops or the context fills).' },
    { k: 'seed', t: 'text', l: 'Seed', ph: 'random', h: 'Set a number for repeatable output. Leave blank for random.' },
  ] },
  { id: 'load', title: 'Model loading', model: true, group: 'load', fields: [
    { t: 'sys' },
    { k: 'contextSize', t: 'select', l: 'Context size', o: [['auto', 'Auto (largest that fits, slow to load)'], ['2048', '2,048'], ['4096', '4,096'], ['8192', '8,192'], ['16384', '16,384'], ['32768', '32,768']], h: 'How much conversation the model can remember. Larger uses more memory and loads slower.' },
    { k: 'gpuLayers', t: 'select', l: 'GPU offload', o: [['auto', 'Auto'], ['max', 'All layers'], ['0', 'CPU only']], h: 'Only matters if a compatible GPU is available.' },
    { k: 'flashAttention', t: 'select', l: 'Flash attention', o: [['auto', 'Auto'], ['on', 'On'], ['off', 'Off']], h: 'Can reduce memory use and speed things up on supported setups.' },
    { k: 'threads', t: 'number', l: 'CPU threads', min: 0, h: '0 uses the default.' },
    { k: 'mmap', t: 'toggle', l: 'Memory-map model file', h: 'Loads faster and uses less RAM up front. Turn off if loading is unstable.' },
  ] },
  { id: 'think', title: 'Thinking & status', fields: [
    { k: 'showThinking', t: 'toggle', l: 'Show model thinking', h: 'Displays reasoning from models that think before answering (e.g. DeepSeek-R1, Qwen3).' },
    { k: 'liveThinking', t: 'toggle', l: 'Live thinking', h: 'Stream the reasoning text as the model thinks. When off, you see only the animation and can open the reasoning once it finishes.', showIf: (s) => s.showThinking },
    { k: 'randomThinking', t: 'toggle', l: 'Randomised thinking animation', h: 'Picks a different animation, colour and wording each time. Off uses a plain equalizer.', showIf: (s) => s.showThinking },
    { k: 'expandThinking', t: 'toggle', l: 'Expand thinking while it streams', showIf: (s) => s.showThinking && s.liveThinking },
    { k: 'thinkingMode', t: 'select', l: 'Thinking budget', model: true, o: [['default', 'Model default'], ['off', 'Skip thinking'], ['limited', 'Limit tokens'], ['unlimited', 'Unlimited']], h: 'Only affects models that support thinking.' },
    { k: 'thinkingBudget', t: 'number', l: 'Max thinking tokens', min: 16, model: true, showIf: (s) => S('thinkingMode') === 'limited' },
    { k: 'statusDetail', t: 'toggle', l: 'Detailed status line', h: 'Live timers, token counts and speed under the message box.' },
    { k: 'showStats', t: 'toggle', l: 'Show stats under replies', h: 'Tokens, speed, time to first token and thinking time.' },
    { k: 'verboseLog', t: 'toggle', l: 'Verbose log panel', h: 'A live timeline of model loading, prompts and generation.' },
    { k: 'logTimestamps', t: 'toggle', l: 'Timestamps in log', showIf: (s) => s.verboseLog },
  ] },
  { id: 'app', title: 'App & updates', fields: [
    { t: 'heading', l: 'Network' },
    { k: 'networkMode', pref: true, t: 'select', l: 'Network access', o: [['offline', 'Offline (default)'], ['online', 'Online']], h: 'Offline means Mull cannot reach the internet at all, for anything. Clicking "Get models", downloading the speech model, or checking for updates will ask to turn this on temporarily and switch back to Offline by itself afterward. Choose Online here instead if you\'d rather it just stayed on. There\'s also a quick toggle in the status bar.' },
    { k: 'autoLoadLast', pref: true, t: 'toggle', l: 'Load my last model on launch' },
    { k: 'closeToTray', pref: true, t: 'toggle', l: 'Keep Mull running in the tray when closed', h: 'Closing the window hides Mull. Use the tray icon to reopen or quit. Needed for the shortcut and API server to keep working.' },
    { k: 'hotkeyEnabled', pref: true, t: 'toggle', l: 'Global shortcut to show / hide Mull' },
    { k: 'hotkey', pref: true, t: 'text', l: 'Shortcut', ph: 'Ctrl+Alt+M', showIf: (s, p) => p.hotkeyEnabled, status: (p) => (p.hotkeyOk ? '✓ Shortcut is active' : p.hotkeyError || '') },
    { k: 'launchAtLogin', pref: true, t: 'toggle', l: 'Start Mull when I sign in to Windows' },
    { t: 'heading', l: 'Updates' },
    { k: 'updateUrl', pref: true, t: 'text', l: 'Update source', ph: 'owner/repo or a JSON URL', h: 'Mull only checks and tells you; it never installs anything by itself. Use a GitHub repo ("owner/repo") or a JSON file like {"version":"1.3.0","url":"https://…"}.' },
    { k: 'autoCheckUpdates', pref: true, t: 'toggle', l: 'Check for updates on launch', showIf: (s, p) => !!p.updateUrl },
    { t: 'action', l: 'Check now', label: 'Check for updates', fn: () => checkForUpdates(true) },
    { t: 'info', text: () => `Mull ${sysInfo?.version || ''}` },
  ] },
  { id: 'voice', title: 'Voice', fields: [
    { k: 'speakVoice', t: 'select', l: 'Read-aloud voice', o: voiceOptions, h: 'Uses the voices installed in Windows.' },
    { k: 'speakRate', t: 'range', l: 'Speaking speed', min: 0.6, max: 1.6, step: 0.05, u: '×' },
    { k: 'autoRead', t: 'toggle', l: 'Read replies aloud automatically' },
    { t: 'heading', l: 'Dictation (works offline)' },
    { k: 'speechModel', pref: true, t: 'select', l: 'Speech model', o: SPEECH_MODELS, h: 'Downloaded once, then dictation runs entirely on this PC. Use the mic button next to the message box.' },
    { k: 'speechLang', pref: true, t: 'select', l: 'Language', o: [['en', 'English'], ['auto', 'Auto-detect (multilingual models only)']] },
    { t: 'info', text: () => speechStatusText() },
    { t: 'action', l: 'Speech model', label: 'Download speech model', fn: () => downloadSpeechModel(), showIf: () => !speech.ready },
  ] },
  { id: 'tools', title: 'Tools & documents', fields: [
    { t: 'info', text: () => 'Tools let a model use a calculator and the clock on its own, and read files inside one folder you choose, asking you first every time. Turn tools on per chat with the Tools button in the message bar. Tools only work with models that support function calling (for example Qwen or Llama 3).' },
    { t: 'info', text: () => 'Workspace folder: ' + (prefs.workspace || 'not set (file tools are off)') },
    { t: 'action', l: 'Workspace', label: 'Choose folder…', fn: async () => { await api.chooseWorkspace(); prefs = await api.getPrefs(); renderSettings(); } },
    { t: 'action', l: '', label: 'Clear workspace', fn: async () => { prefs = await api.setPrefs({ workspace: '' }); renderSettings(); }, showIf: (s, p) => !!p.workspace },
    { t: 'heading', l: 'Documents' },
    { k: 'docsK', t: 'range', l: 'Passages per question', min: 2, max: 10, step: 1, h: 'How many excerpts from your documents are given to the model with each question.' },
    { k: 'embedModelId', pref: true, t: 'select', l: 'Search method', o: embedOptions, h: 'Keyword search works out of the box. An embedding model (such as bge-small or nomic-embed, from Get models) finds passages by meaning. Applies to documents you add afterwards.' },
  ] },
  { id: 'dev', title: 'Developer API', fields: [
    { t: 'info', text: () => 'Let other apps use your local models through an OpenAI-compatible API. It only listens on this PC (127.0.0.1) and is off by default.' },
    { k: 'apiEnabled', pref: true, t: 'toggle', l: 'Enable local API server' },
    { k: 'apiPort', pref: true, t: 'number', l: 'Port', min: 1024, showIf: (s, p) => p.apiEnabled },
    { k: 'apiKey', pref: true, t: 'text', l: 'API key (optional)', ph: 'none', h: 'If set, requests must send it as a Bearer token.', showIf: (s, p) => p.apiEnabled },
    { t: 'action', l: '', label: 'Generate a key', fn: async () => { prefs = await api.setPrefs({ apiKey: await api.newApiKey() }); renderSettings(); }, showIf: (s, p) => p.apiEnabled },
    { k: 'apiCors', pref: true, t: 'toggle', l: 'Allow web pages to call it (CORS)', h: 'Only turn on if a browser-based tool needs it. This also lets any other web page open in your browser reach the API, so Mull requires an API key whenever this is on and generates one for you if you have not set one.', showIf: (s, p) => p.apiEnabled },
    { t: 'info', text: () => apiStatusText(), showIf: (s, p) => p.apiEnabled },
    { t: 'action', l: '', label: 'Copy base URL', fn: () => { navigator.clipboard.writeText(prefs.api.url); toast('Copied ' + prefs.api.url); }, showIf: (s, p) => p.apiEnabled && p.api?.running },
    { t: 'info', text: () => `Use base URL ${prefs.api?.url || ''} with any model name (or one of your installed models). Example: curl.exe ${prefs.api?.url || ''}/models`, showIf: (s, p) => p.apiEnabled },
  ] },
];

const isLoadKey = (k) => SCHEMA.find((g) => g.group === 'load').fields.some((f) => f.k === k);
function syncSettingsFoot() {
  $('sFoot').hidden = !(activeId && loadedSnapshot && JSON.stringify(loadOpts()) !== loadedSnapshot);
}

const getV = (f) => {
  if (f.pref) return prefs[f.k];
  return scope === 'model' && PER_MODEL.has(f.k) && activeId ? S(f.k) : settings[f.k];
};
async function setV(f, v) {
  if (f.pref) { prefs = await api.setPrefs({ [f.k]: v }); return; }
  if (scope === 'model' && PER_MODEL.has(f.k) && activeId) { (modelOv[activeId] ||= {})[f.k] = v; saveOv(); }
  else settings[f.k] = v;
  saveSettings();
}
const showIfOk = (f) => !f.showIf || f.showIf(settings, prefs);

function renderSettings() {
  const group = SCHEMA.find((x) => x.id === sTab) || SCHEMA[0];
  // scope selector (per-model settings)
  const sel = $('scopeSel'), m = models.find((x) => x.id === activeId);
  const showScope = !!(group.model && m);
  sel.hidden = !showScope;
  if (!showScope) scope = 'all';
  else {
    sel.innerHTML = ''; sel.appendChild(new Option('Applies to: all models', 'all')); sel.appendChild(new Option(`Applies to: only ${m.name.length > 28 ? m.name.slice(0, 26) + '…' : m.name}`, 'model'));
    sel.value = scope;
  }
  const tabs = $('sTabs'); tabs.innerHTML = '';
  for (const g of SCHEMA) {
    const b = el('button', g.id === group.id ? 'on' : '', g.title); b.type = 'button';
    b.onclick = () => { sTab = g.id; renderSettings(); replay($('sBody'), 'swap'); if (g.id === 'voice') refreshSpeech(); };
    tabs.appendChild(b);
  }
  const body = $('sBody'); const keep = body.scrollTop; body.innerHTML = '';
  for (const f of group.fields) {
    if (!showIfOk(f)) continue;
    if (f.t === 'presets') {
      const row = el('div', 'presets'); row.appendChild(el('span', 'sys', 'Presets:'));
      for (const name of Object.keys(PRESETS)) {
        const b = el('button', 'small', name); b.type = 'button';
        b.onclick = async () => { for (const [k, v] of Object.entries(PRESETS[name])) await setV({ k }, v); renderSettings(); toast(name + ' preset applied'); };
        row.appendChild(b);
      }
      body.appendChild(row); continue;
    }
    if (f.t === 'sys') {
      body.appendChild(el('div', 'sys', sysInfo ? `This PC: ${sysInfo.cores} CPU threads · ${sysInfo.ramGB} GB RAM (${sysInfo.freeGB} GB free). Changes here apply the next time a model loads.` : 'Changes here apply the next time a model loads.'));
      continue;
    }
    if (f.t === 'heading') { body.appendChild(el('h3', 'sh', esc(f.l))); continue; }
    if (f.t === 'info') { body.appendChild(el('div', 'sys info', esc(f.text()))); continue; }
    if (f.t === 'action') {
      const row = el('div', 'f'); row.appendChild(el('span', 'lbl', esc(f.l || '')));
      const b = el('button', 'small', esc(f.label)); b.type = 'button'; b.onclick = f.fn; row.appendChild(b); body.appendChild(row); continue;
    }
    const row = el('div', 'f' + (f.wide ? ' wide' : ''));
    const lbl = el('label', 'lbl'); lbl.textContent = f.l;
    const val = getV(f);
    let input;
    if (f.t === 'range') {
      input = el('input'); input.type = 'range'; input.min = f.min; input.max = f.max; input.step = f.step; input.value = val;
      const v = el('span', 'val'); const show = () => { v.textContent = (+input.value).toFixed(f.step < 1 ? 2 : 0) + (f.u || ''); }; show(); lbl.appendChild(v);
      input.oninput = () => { show(); setV(f, +input.value); applySettings(); };
    } else if (f.t === 'select') {
      input = el('select'); for (const [ov, name] of (typeof f.o === 'function' ? f.o() : f.o)) { const o = el('option'); o.value = ov; o.textContent = name; input.appendChild(o); }
      input.value = String(val ?? '');
      input.onchange = async () => { await setV(f, input.value); afterChange(f.k, true); };
    } else if (f.t === 'toggle') {
      input = el('label', 'tog'); const cb = el('input'); cb.type = 'checkbox'; cb.checked = !!val;
      input.append(cb, el('span'));
      cb.onchange = async () => { await setV(f, cb.checked); afterChange(f.k, true); };
    } else if (f.t === 'textarea') {
      input = el('textarea'); input.value = val ?? '';
      input.oninput = () => setV(f, input.value);
    } else {
      input = el('input'); input.type = f.t === 'number' ? 'number' : 'text'; input.value = val ?? ''; if (f.min != null) input.min = f.min; if (f.ph) input.placeholder = f.ph;
      const commit = async () => { await setV(f, f.t === 'number' ? (input.value === '' ? 0 : +input.value) : input.value); afterChange(f.k, !!f.pref); };
      if (f.pref) input.onchange = commit; else input.oninput = () => { setV(f, f.t === 'number' ? (input.value === '' ? 0 : +input.value) : input.value); afterChange(f.k, false); };
    }
    row.append(lbl, input);
    const help = [];
    if (f.h) help.push(esc(f.h));
    if (f.status) { const s = f.status(prefs); if (s) help.push(`<b>${esc(s)}</b>`); }
    if (help.length) row.appendChild(el('div', 'help', help.join('<br>')));
    if (!f.pref && PER_MODEL.has(f.k) && activeId && modelOv[activeId] && f.k in modelOv[activeId]) {
      const ov = el('div', 'help ov');
      ov.innerHTML = scope === 'model' ? 'Custom for this model. ' : 'This model uses its own value. ';
      const rb = el('button', 'linkbtn', 'Use global'); rb.type = 'button';
      rb.onclick = () => { delete modelOv[activeId][f.k]; saveOv(); renderSettings(); syncSettingsFoot(); };
      ov.appendChild(rb); row.appendChild(ov);
    }
    body.appendChild(row);
  }
  body.scrollTop = keep;
  syncSettingsFoot();
}
function afterChange(k, rerender) {
  saveSettings(); applySettings();
  if (k === 'verboseLog' || k === 'logTimestamps') rebuildLog();
  if (['showThinking', 'showStats'].includes(k)) renderChat();
  if (k === 'speechModel') refreshSpeech();
  if (k === 'networkMode') updateNetIndicator();
  syncSettingsFoot();
  if (rerender) renderSettings();
}
function openSettings(tab) { if (tab) sTab = tab; $('settings').hidden = false; api.getPrefs().then((p) => { prefs = p; renderSettings(); }); renderSettings(); }
function closeSettings() { $('settings').hidden = true; }
$('openSettings').onclick = () => openSettings();
$('closeSettings').onclick = closeSettings;
$('scopeSel').onchange = (e) => { scope = e.target.value; renderSettings(); };
$('settings').addEventListener('mousedown', (e) => { if (e.target === $('settings')) closeSettings(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('settings').hidden) closeSettings(); });
$('resetSettings').onclick = () => { if (confirm('Reset all display and generation settings to defaults? (Per-model overrides are kept.)')) { settings = { ...DEFAULTS }; saveSettings(); applySettings(); rebuildLog(); renderSettings(); renderChat(); } };
$('reloadModel').onclick = async () => {
  const id = activeId; if (!id || busy) return;
  closeSettings(); await ejectModel(); selectModel(id);
};
window.speechSynthesis?.addEventListener?.('voiceschanged', () => { if (!$('settings').hidden && sTab === 'voice') renderSettings(); });

/* ---------------- Wiring ---------------- */
const TAB_IDS = ['chats', 'discover', 'models', 'favorites'];
function showTab(name) {
  document.querySelectorAll('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === name));
  for (const id of TAB_IDS) $('tab-' + id).hidden = id !== name;
  replay($('tab-' + name), 'swap');
  if (name === 'discover') renderDiscover();
  if (name === 'favorites') renderFavorites();
}
document.querySelectorAll('.tabs button').forEach((b) => { b.onclick = () => showTab(b.dataset.tab); });
$('modelChip').onclick = () => showTab('models');
$('newChat').onclick = newChat;
$('chatSearch').oninput = (e) => { chatFilter = e.target.value; renderChatList(); };
$('eject').onclick = ejectModel;
$('toggleLog').onclick = () => { settings.verboseLog = !settings.verboseLog; saveSettings(); applySettings(); if (settings.verboseLog) rebuildLog(); };
$('logClose').onclick = () => { settings.verboseLog = false; saveSettings(); applySettings(); };
$('logClear').onclick = () => { logBuf.length = 0; $('logBody').innerHTML = ''; };

$('composer').onsubmit = (e) => { e.preventDefault(); send(); };
$('stop').onclick = () => { if (run) run.stopped = true; api.stop(); setActivity('Stopping…'); };
$('input').onkeydown = (e) => {
  if (e.key !== 'Enter') return;
  const ctrl = e.ctrlKey || e.metaKey;
  if (settings.enterToSend ? !e.shiftKey : ctrl) { e.preventDefault(); send(); }
};
$('input').oninput = (e) => { e.target.style.height = 'auto'; e.target.style.height = Math.min(200, e.target.scrollHeight) + 'px'; };

document.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag'); });
document.addEventListener('dragleave', (e) => { if (!e.relatedTarget) document.body.classList.remove('drag'); });
document.addEventListener('drop', async (e) => {
  e.preventDefault(); document.body.classList.remove('drag');
  const all = [...e.dataTransfer.files];
  const ggufs = all.filter((f) => /\.gguf$/i.test(f.name)), others = all.filter((f) => !/\.gguf$/i.test(f.name));
  if (ggufs.length) {
    const before = models.length;
    models = await api.importPaths(ggufs);
    renderModels(); showTab('models'); renderChat();
    toast(models.length > before ? `Imported ${models.length - before} model(s)` : 'Already in your list');
  }
  if (others.length) attachPaths(api.droppedPaths(others)); // documents (docsui.js)
  if (!all.length) toast('Nothing to import');
});

/* Startup runs from the last script (extras.js) so every module is defined first. */
async function boot() {
  applySettings();
  let saved;
  [models, sysInfo, saved, prefs] = await Promise.all([api.listModels(), api.sysInfo(), api.loadChats(), api.getPrefs()]);
  $('verTag').textContent = sysInfo.version ? 'v' + sysInfo.version : '';
  updateNetIndicator();
  if (!saved) { saved = store.get('lac.chats', []); if (saved.length) api.saveChats(saved); } // one-time move from browser storage
  chats = Array.isArray(saved) ? saved : [];
  if (!chats.length) newChat(); else { curId = [...chats].sort(chatSort)[0].id; renderChatList(); renderChat(); }
  renderModels();
  if (!models.length) showTab('models');
  setActivity(models.length ? 'Choose a model to begin.' : 'Get or import a .gguf model to begin.');
  if (settings.verboseLog) rebuildLog();
  rlog('info', `Mull ${sysInfo.version} started · ${sysInfo.cores} threads · ${sysInfo.ramGB} GB RAM`);
  await bootExtras();
}
