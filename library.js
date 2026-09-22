'use strict';
/* Personas (system prompt + optional temperature) and a library of reusable prompts. */

const BUILTIN_PERSONAS = [
  { id: 'default', name: 'Default', icon: 'user', builtin: true, system: null, desc: 'Uses your default system prompt from Settings.' },
  { id: 'coder', name: 'Coder', icon: 'code', builtin: true, temperature: 0.3, system: 'You are an expert software engineer. Give correct, idiomatic, well-explained code. Prefer small complete examples, mention edge cases briefly, and ask a clarifying question if the request is ambiguous.' },
  { id: 'editor', name: 'Editor', icon: 'pencil', builtin: true, temperature: 0.4, system: "You are a careful editor. Improve clarity, grammar and flow while keeping the author's voice and meaning. Show the revised text first, then a short list of the main changes." },
  { id: 'eli12', name: 'Explain simply', icon: 'lightbulb', builtin: true, temperature: 0.6, system: 'Explain things simply, as if to a curious 12-year-old. Use short sentences, everyday words and a helpful analogy. Avoid jargon; if you must use a technical term, explain it.' },
  { id: 'tutor', name: 'Tutor', icon: 'book', builtin: true, temperature: 0.6, system: 'You are a patient tutor. Guide the student step by step and check understanding. Prefer a guiding question over the full answer straight away, but give the answer if they are stuck.' },
  { id: 'brief', name: 'Concise', icon: 'zap', builtin: true, temperature: 0.4, system: 'Answer as briefly as possible while staying correct. No preamble and no repeating the question.' },
  { id: 'translator', name: 'Translator', icon: 'globe', builtin: true, temperature: 0.2, system: "You are a translator. Translate the user's text into the language they ask for (default: English) and output only the translation unless asked otherwise." },
];
const DEFAULT_PROMPTS = [
  { id: 'p1', title: 'Summarise', text: 'Summarise the following in 5 short bullet points:\n\n' },
  { id: 'p2', title: 'Explain this code', text: 'Explain what this code does, step by step, and point out any bugs:\n\n' },
  { id: 'p3', title: 'Proofread', text: 'Proofread the following text. Fix spelling and grammar and keep my tone:\n\n' },
  { id: 'p4', title: 'Brainstorm ideas', text: 'Give me 10 creative ideas for: ' },
  { id: 'p5', title: 'Pros and cons', text: 'List the pros and cons of: ' },
];
let customPersonas = store.get('mull.personas', []);
let savedPrompts = store.get('mull.prompts', null) || DEFAULT_PROMPTS;
const savePersonas = () => store.set('mull.personas', customPersonas);
const savePrompts = () => store.set('mull.prompts', savedPrompts);

/* Persona edit history: the last few system prompts, so an edit can be undone. Keyed by persona id. */
let personaHistory = store.get('mull.personaHistory', {});
const savePersonaHistory = () => store.set('mull.personaHistory', personaHistory);
function recordPersonaHistory(id, prevSystem, prevTemperature) {
  const h = (personaHistory[id] ||= []);
  h.unshift({ system: prevSystem, temperature: prevTemperature, ts: Date.now() });
  if (h.length > 5) h.length = 5;
  savePersonaHistory();
}
function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return Math.round(s / 60) + ' min ago';
  if (s < 86400) return Math.round(s / 3600) + ' h ago';
  return Math.round(s / 86400) + ' d ago';
}
const iconOf = (p) => (ICON_PATHS[p?.icon] ? p.icon : 'user'); // older custom personas stored an emoji here
const allPersonas = () => [...BUILTIN_PERSONAS, ...customPersonas];
const personaById = (id) => allPersonas().find((p) => p.id === id) || BUILTIN_PERSONAS[0];

/* The persona in effect for a chat, resolved to what the model needs. */
function currentPersona(c) {
  const p = personaById(c?.personaId || 'default');
  return { id: p.id, name: p.name, system: p.system == null ? S('system') : p.system, temperature: p.temperature };
}

function pickPersona(c) {
  const rect = $('personaBtn').getBoundingClientRect();
  const items = allPersonas().map((p) => ({ icon: iconOf(p), label: `${p.id === (c.personaId || 'default') ? '✓  ' : ''}${p.name}`, fn: () => { c.personaId = p.id; saveChats(); updateChatChrome(); toast(`Persona: ${p.name}`); } }));
  items.push('-', { label: 'Manage personas…', fn: () => openLibrary('personas') });
  showMenu(rect.left, rect.bottom + 4, items);
}

/* ---------------- Library dialog ---------------- */
let libTab = 'personas', libEdit = null;
const uid = () => Math.random().toString(36).slice(2, 9);

function openLibrary(tab) { if (tab) libTab = tab; libEdit = null; $('library').hidden = false; renderLibrary(); }
function closeLibrary() { $('library').hidden = true; }

function renderLibrary() {
  const tabs = $('libTabs'); tabs.innerHTML = '';
  for (const [id, label] of [['personas', 'Personas'], ['prompts', 'Saved prompts']]) {
    const b = el('button', id === libTab ? 'on' : '', label); b.type = 'button';
    b.onclick = () => { libTab = id; libEdit = null; renderLibrary(); };
    tabs.appendChild(b);
  }
  const body = $('libBody'); body.innerHTML = '';
  if (libEdit) return renderLibForm(body);
  const add = el('button', 'primary small', libTab === 'personas' ? '+ New persona' : '+ New prompt'); add.type = 'button';
  add.onclick = () => { libEdit = libTab === 'personas' ? { kind: 'persona', id: uid(), name: '', icon: 'user', system: '', temperature: null, isNew: true } : { kind: 'prompt', id: uid(), title: '', text: '', isNew: true }; renderLibrary(); };
  body.appendChild(el('div', 'lib-bar')).appendChild(add);
  const list = libTab === 'personas' ? allPersonas() : savedPrompts;
  if (!list.length) body.appendChild(el('div', 'empty', 'Nothing here yet.'));
  for (const item of list) {
    const isP = libTab === 'personas';
    const card = el('div', 'lib-card');
    const c = cur();
    const active = isP && (c?.personaId || 'default') === item.id;
    card.innerHTML = `<div class="lc-h"><span class="lc-t">${isP ? '<span class="lc-i">' + ic(iconOf(item), 15) + '</span>' : ''}${esc(isP ? item.name : item.title)}</span>${active ? '<span class="badge">IN USE</span>' : ''}${item.builtin ? '<span class="tag">built-in</span>' : ''}</div>` +
      `<div class="lc-b">${esc(((isP ? (item.system ?? item.desc ?? '') : item.text) || '').slice(0, 220))}${isP && item.temperature != null ? `<div class="lc-m">temperature ${item.temperature}</div>` : ''}</div>`;
    const btns = el('div', 'lc-btns');
    const mk = (label, fn, cls = 'small') => { const b = el('button', cls, label); b.type = 'button'; b.onclick = fn; btns.appendChild(b); };
    if (isP) mk('Use in this chat', () => { const ch = cur(); if (ch) { ch.personaId = item.id; saveChats(); updateChatChrome(); toast(`Persona: ${item.name}`); renderLibrary(); } }, 'small primary');
    else mk('Insert', () => { insertPrompt(item); closeLibrary(); }, 'small primary');
    mk(item.builtin ? 'Duplicate' : 'Edit', () => {
      libEdit = isP ? { kind: 'persona', ...item, id: item.builtin ? uid() : item.id, name: item.builtin ? item.name + ' (copy)' : item.name, system: item.system || S('system'), isNew: !!item.builtin, builtin: false }
        : { kind: 'prompt', ...item }; renderLibrary();
    });
    if (isP && !item.builtin && personaHistory[item.id]?.length) mk('History', (e2) => {
      const r = e2.currentTarget.getBoundingClientRect();
      showMenu(r.left, r.bottom + 4, personaHistory[item.id].map((v, hi) => ({
        icon: 'history', label: `${relTime(v.ts)} — ${(v.system || '').replace(/\s+/g, ' ').slice(0, 40)}…`,
        fn: () => {
          if (!confirm('Restore this earlier version of the persona?')) return;
          const at = customPersonas.findIndex((x) => x.id === item.id); if (at < 0) return;
          recordPersonaHistory(item.id, customPersonas[at].system, customPersonas[at].temperature);
          customPersonas[at] = { ...customPersonas[at], system: v.system, temperature: v.temperature };
          savePersonas(); renderLibrary(); updateChatChrome(); toast('Restored an earlier version');
        },
      })));
    });
    if (!item.builtin) mk('Delete', () => {
      if (!confirm(`Delete "${isP ? item.name : item.title}"?`)) return;
      if (isP) { customPersonas = customPersonas.filter((x) => x.id !== item.id); savePersonas(); for (const ch of chats) if (ch.personaId === item.id) ch.personaId = 'default'; saveChats(); updateChatChrome(); }
      else { savedPrompts = savedPrompts.filter((x) => x.id !== item.id); savePrompts(); }
      renderLibrary();
    }, 'small danger');
    card.appendChild(btns); body.appendChild(card);
  }
}

function renderLibForm(body) {
  const e = libEdit, isP = e.kind === 'persona';
  const f = el('div', 'lib-form');
  f.innerHTML = `<label>${isP ? 'Name' : 'Title'}<input id="lfName" type="text" maxlength="60"></label>` +
    
    `<label>${isP ? 'System prompt: how the model should behave' : 'Prompt text'}<textarea id="lfText" rows="7"></textarea></label>` +
    (isP ? '<label class="lf-temp"><input id="lfTempOn" type="checkbox"> Use its own temperature <input id="lfTemp" type="range" min="0" max="1.5" step="0.05"><span id="lfTempV"></span></label>' : '');
  body.appendChild(f);
  $('lfName').value = isP ? e.name : e.title; $('lfText').value = isP ? e.system : e.text;
  if (isP) {
    $('lfTempOn').checked = e.temperature != null; $('lfTemp').value = e.temperature ?? 0.7; $('lfTempV').textContent = $('lfTemp').value; $('lfTemp').disabled = e.temperature == null;
    $('lfTempOn').onchange = () => { $('lfTemp').disabled = !$('lfTempOn').checked; };
    $('lfTemp').oninput = () => { $('lfTempV').textContent = $('lfTemp').value; };
  }
  const row = el('div', 'edit-row');
  const save = el('button', 'primary small', 'Save'); save.type = 'button';
  const cancel = el('button', 'small', 'Cancel'); cancel.type = 'button';
  row.append(save, cancel); f.appendChild(row);
  cancel.onclick = () => { libEdit = null; renderLibrary(); };
  save.onclick = () => {
    const name = $('lfName').value.trim(), text = $('lfText').value.trim();
    if (!name || !text) { toast(isP ? 'Give the persona a name and a system prompt' : 'Give the prompt a title and some text'); return; }
    if (isP) {
      const p = { id: e.id, name, icon: iconOf(e), system: text, temperature: $('lfTempOn').checked ? +$('lfTemp').value : undefined };
      const at = customPersonas.findIndex((x) => x.id === p.id);
      if (at >= 0) { if (customPersonas[at].system !== text) recordPersonaHistory(p.id, customPersonas[at].system, customPersonas[at].temperature); customPersonas[at] = p; }
      else customPersonas.push(p);
      savePersonas();
    } else {
      const p = { id: e.id, title: name, text: $('lfText').value };
      const at = savedPrompts.findIndex((x) => x.id === p.id); if (at >= 0) savedPrompts[at] = p; else savedPrompts.push(p); savePrompts();
    }
    libEdit = null; renderLibrary(); updateChatChrome();
  };
  $('lfName').focus();
}

function insertPrompt(p) {
  const inp = $('input');
  inp.value = p.text; inp.dispatchEvent(new Event('input')); inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length);
}

/* ---------------- "/" prompt picker in the message box ---------------- */
let slash = null; // { items, i }
const slashBox = el('div', 'slash'); slashBox.hidden = true; document.body.appendChild(slashBox);
function slashUpdate() {
  const v = $('input').value;
  if (!v.startsWith('/') || v.includes('\n') || !savedPrompts.length) { slashHide(); return; }
  const q = v.slice(1).toLowerCase();
  const items = savedPrompts.filter((p) => p.title.toLowerCase().includes(q)).slice(0, 8);
  if (!items.length) { slashHide(); return; }
  slash = { items, i: Math.min(slash?.i || 0, items.length - 1) };
  slashBox.innerHTML = '';
  items.forEach((p, i) => {
    const row = el('div', 'slash-row' + (i === slash.i ? ' on' : ''));
    row.innerHTML = `<b>${esc(p.title)}</b><span>${esc(p.text.replace(/\s+/g, ' ').slice(0, 70))}</span>`;
    row.onmousedown = (e) => { e.preventDefault(); slashPick(i); };
    slashBox.appendChild(row);
  });
  const r = $('input').getBoundingClientRect();
  slashBox.hidden = false; slashBox.style.left = r.left + 'px'; slashBox.style.width = Math.min(560, r.width) + 'px'; slashBox.style.bottom = (innerHeight - r.top + 6) + 'px';
}
const slashHide = () => { slash = null; slashBox.hidden = true; };
function slashPick(i) { const p = slash.items[i]; slashHide(); insertPrompt(p); }
$('input').addEventListener('input', slashUpdate);
$('input').addEventListener('blur', () => setTimeout(slashHide, 120));
$('input').addEventListener('keydown', (e) => {
  if (!slash) return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); slash.i = (slash.i + (e.key === 'ArrowDown' ? 1 : -1) + slash.items.length) % slash.items.length; slashUpdate(); }
  else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopImmediatePropagation(); slashPick(slash.i); }
  else if (e.key === 'Escape') { slashHide(); }
}, true);

$('openLibrary').onclick = () => openLibrary();
$('closeLibrary').onclick = closeLibrary;
$('library').addEventListener('mousedown', (e) => { if (e.target === $('library')) closeLibrary(); });
$('personaBtn').onclick = () => { const c = cur(); if (c) pickPersona(c); };
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('library').hidden) closeLibrary(); });
