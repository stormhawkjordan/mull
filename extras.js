'use strict';
/* Everything that ties the newer features together: importing from other apps, model info card, tools + approvals,
   updates, tray/hotkey events and startup. Loaded last, and it starts the app. */

/* ---------------- Import menu ---------------- */
$('importBtn').onclick = async () => {
  const r = $('importBtn').getBoundingClientRect();
  let found = { ollama: 0, lmstudio: 0 };
  try { found = await api.detectImports(); } catch { /* ignore */ }
  const done = (res) => {
    if (res.canceled) return;
    models = res.models; renderModels(); renderChat();
    toast(res.added ? `Imported ${res.added} model${res.added > 1 ? 's' : ''}` : res.found ? 'Those models are already in your list' : 'No .gguf models found there');
  };
  const items = [
    { icon: 'plus', label: 'Import .gguf files…', fn: async () => { const before = models.length; models = await api.importModels(); renderModels(); renderChat(); if (models.length > before) toast(`Imported ${models.length - before} model(s)`); } },
    { icon: 'folder', label: 'Scan a folder for models…', fn: async () => done(await api.importFolder()) },
  ];
  if (found.ollama) items.push('-', { label: `Import from Ollama (${found.ollama} found)`, fn: async () => done(await api.runImport('ollama')) });
  if (found.lmstudio) items.push({ label: `Import from LM Studio (${found.lmstudio} found)`, fn: async () => done(await api.runImport('lmstudio')) });
  if (!found.ollama && !found.lmstudio) items.push('-', { label: 'No Ollama or LM Studio models found', fn: () => {} });
  showMenu(r.left, r.bottom + 4, items);
};

/* ---------------- Model info card ---------------- */
const fmtCount = (n) => (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(0) + 'M' : String(n));
async function showModelInfo(m) {
  $('minfo').hidden = false; $('miTitle').textContent = m.name;
  const body = $('miBody'); body.innerHTML = '<div class="sys">Reading model file…</div>';
  let i;
  try { i = await api.modelInfo(m.id); } catch (e) { body.innerHTML = `<div class="errline">${esc(cleanErr(e))}</div>`; return; }
  const gb = (b) => (b / 1073741824).toFixed(1) + ' GB';
  const rows = [
    ['Name', i.name || m.name], ['Architecture', i.arch], ['Parameters', i.params || (i.totalParams ? fmtCount(i.totalParams) : '')], ['Quantization', i.quant],
    ['File size', fmtSize(m.size)], ['Trained context', i.trainContext ? i.trainContext.toLocaleString() + ' tokens' : ''], ['Layers', i.layers], ['Embedding size', i.embedding],
    ['Vocabulary', i.vocab ? i.vocab.toLocaleString() : ''], ['Chat template', i.hasTemplate ? 'Yes' : 'No (generic)'], ['Thinks before answering', i.reasoning ? 'Yes' : 'No'],
    ['Supports tools', i.tools ? 'Yes' : 'Unclear'], ['License', i.license], ['Author', i.author], ['File', i.path],
  ].filter(([, v]) => v !== '' && v != null);
  let html = '';
  if (i.embeddingOnly) html += '<div class="callout warn">This is an <b>embedding model</b>, not a chat model. Use it for document search: Settings → Tools &amp; documents → Search method.</div>';
  html += '<table class="kv">' + rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(String(v))}</td></tr>`).join('') + '</table>';
  if (i.estimate) {
    const need = i.estimate.vram + i.estimate.ram, fit = fitOf(m.size);
    html += `<div class="callout">Estimated memory at 8K context: <b>${gb(need)}</b>${i.estimate.vram ? ` (${gb(i.estimate.vram)} on GPU, ${gb(i.estimate.ram)} in RAM)` : ''}.` +
      (fit ? ` <span class="fit ${fit.cls}">${esc(fit.text)}</span>` : '') + '</div>';
  }
  body.innerHTML = html;
  const row = el('div', 'edit-row');
  if (i.embeddingOnly) {
    const b = el('button', 'primary small', 'Use for document search'); b.type = 'button';
    b.onclick = async () => { prefs = await api.setPrefs({ embedModelId: m.id }); toast('Document search will use this model'); $('minfo').hidden = true; };
    row.appendChild(b);
  } else {
    const b = el('button', 'primary small', m.id === activeId ? 'Loaded' : 'Load this model'); b.type = 'button'; b.disabled = m.id === activeId || busy;
    b.onclick = () => { $('minfo').hidden = true; selectModel(m.id); };
    row.appendChild(b);
  }
  body.appendChild(row);
}
$('closeInfo').onclick = () => { $('minfo').hidden = true; };
$('minfo').addEventListener('mousedown', (e) => { if (e.target === $('minfo')) $('minfo').hidden = true; });

/* ---------------- Tools: cards + approvals ---------------- */
const TOOL_META = { calculator: ['calculator', 'Calculator'], get_datetime: ['clock', 'Clock'], list_files: ['folder', 'List files'], read_file: ['file', 'Read file'] };
function toolSummary(t) {
  const a = t.args || {};
  return t.name === 'calculator' ? a.expression : t.name === 'get_datetime' ? '' : a.path || '.';
}
function toolCard(t) {
  const [icon, label] = TOOL_META[t.name] || ['wrench', t.name];
  const card = el('div', 'tool ' + (t.status || 'running'));
  card.dataset.id = t.id;
  card.innerHTML = `<div class="tool-h"><span class="ti">${ic(icon, 15)}</span><b>${esc(label)}</b><span class="tsum"></span><span class="tstat"></span></div><div class="tool-r"></div>`;
  card.querySelector('.tsum').textContent = toolSummary(t) || '';
  updateToolCard(card, t);
  return card;
}
function updateToolCard(card, t) {
  card.className = 'tool ' + t.status;
  card.querySelector('.tstat').textContent = { running: 'working…', done: 'done', denied: 'denied', error: 'failed', waiting: 'needs your OK' }[t.status] || t.status;
  const r = card.querySelector('.tool-r');
  r.textContent = t.result ? (t.name === 'calculator' ? '= ' : '') + t.result : '';
  r.hidden = !t.result;
}
function handleToolEvent(r, m, ev) {
  r.tools ||= new Map(); m.tools ||= [];
  let rec = m.tools.find((x) => x.id === ev.id);
  if (!rec) { rec = { id: ev.id, name: ev.name, args: ev.args, status: ev.status }; m.tools.push(rec); }
  Object.assign(rec, { status: ev.status, result: ev.result });
  let card = r.tools.get(ev.id);
  if (!card) { card = toolCard(rec); r.tools.set(ev.id, card); r.bubble.insertBefore(card, r.abody); }
  else updateToolCard(card, rec);
  if (ev.status !== 'running') card.querySelector('.tool-ask')?.remove();
  if (nearBottom()) scrollDown();
}
api.onToolAsk(({ id, name, args }) => {
  const r = run?.r, card = r?.tools?.get(id); if (!card) return api.toolAnswer({ id, allow: false });
  const rec = r.wait ? null : null;
  card.classList.add('waiting'); card.querySelector('.tstat').textContent = 'needs your OK';
  const ask = el('div', 'tool-ask');
  ask.appendChild(el('span', '', esc(name === 'read_file' ? 'The model wants to read this file:' : 'The model wants to look inside this folder:')));
  const answer = (allow, always) => {
    if (always && allow) { const c = cur(); (c.autoAllow ||= []); if (!c.autoAllow.includes(name)) c.autoAllow.push(name); saveChats(); }
    ask.remove(); card.classList.remove('waiting'); api.toolAnswer({ id, allow });
  };
  for (const [label, allow, always, cls] of [['Allow once', true, false, 'small primary'], ['Always allow in this chat', true, true, 'small'], ['Deny', false, false, 'small danger']]) {
    const b = el('button', cls, label); b.type = 'button'; b.onclick = () => answer(allow, always); ask.appendChild(b);
  }
  card.appendChild(ask); scrollDown();
});
$('toolsToggle').onclick = () => {
  const c = cur(); if (!c) return;
  c.tools = !c.tools; saveChats(); updateChatChrome();
  toast(c.tools ? (prefs.workspace ? 'Tools on: calculator, clock and files in your workspace folder' : 'Tools on: calculator and clock. Set a workspace folder in Settings to allow file access') : 'Tools off');
};

/* ---------------- Chat chrome (persona chip, tools/attach state) ---------------- */
function updateChatChrome() {
  const c = cur();
  $('personaText').textContent = personaById(c?.personaId || 'default').name;
  $('toolsToggle').classList.toggle('on', !!c?.tools);
  $('toolsToggle').title = c?.tools ? 'Tools are on for this chat (click to turn off)' : 'Let the model use tools (calculator, clock, files you allow)';
  renderDocChips();
}

/* ---------------- Updates ---------------- */
let updateInfo = null;
async function checkForUpdates(manual) {
  let release = null;
  try {
    if (manual) { release = await ensureNetwork('Checking for updates needs network access.'); if (!release) return; }
    const r = await api.checkUpdate();
    updateInfo = r.available ? r : null;
    const b = $('updateBanner');
    b.hidden = !r.available;
    if (r.available) {
      b.innerHTML = `<b>Mull ${esc(r.version)} is available</b><span>You have ${esc(r.current)}</span>`;
      if (r.url) { const btn = el('button', 'small primary', 'Get the update'); btn.type = 'button'; btn.onclick = () => api.openExternal(r.url); b.appendChild(btn); }
    }
    if (manual) toast(r.available ? `Mull ${r.version} is available` : `You're up to date (${r.current})`);
  } catch (e) { if (manual) toast(cleanErr(e)); }
  finally { release?.(); }
}

/* ---------------- Startup + events from the main process ---------------- */
api.onModelExternal((meta) => {
  if (!meta) { setActive(null); return; }
  activeMeta = meta; loadedSnapshot = JSON.stringify(loadOpts(meta.id)); setActive(meta.id, meta);
  toast(`${models.find((m) => m.id === meta.id)?.name || 'Model'} loaded by the API`);
});
api.onFocus(() => { $('input').focus(); });
api.onNewChat(() => { newChat(); });

async function bootExtras() {
  updateChatChrome();
  // First run: guide the user. Re-checked right before it actually opens (not just when scheduled) so it
  // never stacks silently on top of a dialog the person has already opened in the meantime — two modals
  // sharing the same z-index would otherwise let the newer one swallow every click meant for the other.
  if (!prefs.wizardDone && !store.get('mull.wizardDone') && !models.length) {
    setTimeout(() => { if (![...document.querySelectorAll('.modal')].some((m) => !m.hidden)) openWizard(); }, 350);
  }
  refreshSpeech();
  if (prefs.autoCheckUpdates && prefs.updateUrl) checkForUpdates(false);
  if (prefs.autoLoadLast && prefs.lastModelId && models.some((m) => m.id === prefs.lastModelId)) selectModel(prefs.lastModelId);
}

boot();
