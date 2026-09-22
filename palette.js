'use strict';
/* Command palette (Ctrl+K): jump to a chat or a specific message, switch models/personas, or run any action
   without hunting through menus. Rebuilt fresh from live state every time it opens. */

let pal = null; // { items, i, q }

function paletteActions() {
  const c = cur();
  const acts = [
    { icon: 'plus', title: 'New chat', sub: 'Start a fresh conversation', fn: newChat },
    { icon: 'sliders', title: 'Open Settings', fn: () => openSettings() },
    { icon: 'book', title: 'Open Library: Personas', fn: () => openLibrary('personas') },
    { icon: 'book', title: 'Open Library: Saved prompts', fn: () => openLibrary('prompts') },
    { icon: 'download', title: 'Get models', sub: 'Search and download GGUF models', fn: () => openBrowser() },
    { icon: 'plus', title: 'Import models…', fn: () => $('importBtn').click() },
    { icon: 'columns', title: 'Compare two models', fn: () => openCompare() },
    { icon: 'monitor', title: 'Run the setup guide again', sub: 'PC check and model recommendations', fn: () => openWizard() },
    { icon: settings.theme === 'dark' ? 'zap' : 'zap', title: 'Toggle theme', sub: `Currently ${settings.theme}`, fn: () => { settings.theme = settings.theme === 'dark' ? 'light' : settings.theme === 'light' ? 'system' : 'dark'; saveSettings(); applySettings(); toast('Theme: ' + settings.theme); } },
  ];
  if (activeId) acts.push({ icon: 'x', title: 'Eject the loaded model', fn: ejectModel });
  if (c) {
    acts.push({ icon: 'wrench', title: c.tools ? 'Turn tools off for this chat' : 'Turn tools on for this chat', fn: () => $('toolsToggle').click() });
    if (c.messages.length) {
      acts.push({ icon: 'download', title: 'Export this chat as Markdown', fn: () => exportChat(c, 'md') });
      acts.push({ icon: 'download', title: 'Export this chat as JSON', fn: () => exportChat(c, 'json') });
      const last = [...c.messages].reverse().find((m) => m.role === 'assistant' && m.content);
      if (last) acts.push({ icon: 'copy', title: 'Copy last reply', fn: () => { navigator.clipboard.writeText(last.content); toast('Copied'); } });
    }
  }
  return acts;
}

function paletteEntries(q) {
  const out = [];
  const push = (kind, items) => out.push(...items.map((it) => ({ kind, ...it })));

  push('action', paletteActions());
  push('model', models.map((m) => ({ icon: 'monitor', title: (m.id === activeId ? 'Loaded: ' : 'Load: ') + m.name, sub: fmtSize(m.size), fn: () => { if (m.id !== activeId) selectModel(m.id); showTab('models'); } })));
  const c = cur();
  if (c) push('persona', allPersonas().map((p) => ({ icon: iconOf(p), title: 'Persona: ' + p.name, sub: p.id === (c.personaId || 'default') ? 'in use' : '', fn: () => { c.personaId = p.id; saveChats(); updateChatChrome(); toast('Persona: ' + p.name); } })));
  push('chat', [...chats].sort(chatSort).map((ch) => ({ icon: 'book', title: ch.title, sub: new Date(ch.updated || ch.created).toLocaleDateString(), fn: () => { curId = ch.id; renderChatList(); renderChat(); } })));

  // message search across every chat (only once the query is a bit specific, to avoid a huge unfiltered dump)
  if (q.trim().length >= 3) {
    const needle = q.trim().toLowerCase();
    let hits = 0;
    for (const ch of [...chats].sort(chatSort)) {
      for (let i = 0; i < ch.messages.length && hits < 40; i++) {
        const m = ch.messages[i];
        const idx = m.content?.toLowerCase().indexOf(needle);
        if (idx == null || idx < 0) continue;
        hits++;
        const from = Math.max(0, idx - 24);
        const snip = (from ? '…' : '') + m.content.slice(from, from + 70).replace(/\s+/g, ' ');
        out.push({ kind: 'message', icon: m.role === 'user' ? 'user' : 'mark', title: `In "${ch.title}"`, sub: snip, fn: () => jumpToMessage(ch.id, i) });
      }
    }
  }
  return out;
}

function paletteScore(item, q) {
  if (!q) return 0;
  const t = item.title.toLowerCase();
  if (t === q) return 100;
  if (t.startsWith(q)) return 80;
  if (t.includes(q)) return 60;
  if (item.sub && item.sub.toLowerCase().includes(q)) return 20;
  return -1;
}

function paletteFilter(q) {
  const needle = q.trim().toLowerCase();
  const all = paletteEntries(q);
  if (!needle) return all.filter((it) => it.kind === 'action').slice(0, 9);
  return all.map((it) => ({ it, s: paletteScore(it, needle) })).filter((x) => x.s >= 0 || x.kind === 'message')
    .sort((a, b) => b.s - a.s).map((x) => x.it).slice(0, 24);
}

function paletteRender() {
  const list = $('paletteList'); list.innerHTML = '';
  if (!pal.items.length) { list.appendChild(el('div', 'empty', 'Nothing matches that.')); return; }
  pal.items.forEach((it, i) => {
    const row = el('div', 'palette-row' + (i === pal.i ? ' on' : ''));
    row.innerHTML = `<span class="pr-i">${ic(it.icon || 'search', 16)}</span><span class="pr-t"><b>${esc(it.title)}</b>${it.sub ? `<span>${esc(it.sub)}</span>` : ''}</span>`;
    row.onmousedown = (e) => { e.preventDefault(); paletteRun(i); };
    row.onmouseenter = () => { pal.i = i; paletteRender(); };
    list.appendChild(row);
  });
  list.children[pal.i]?.scrollIntoView({ block: 'nearest' });
}

function paletteRun(i) {
  const it = pal.items[i]; if (!it) return;
  closePalette();
  it.fn();
}

function openPalette() {
  pal = { items: paletteFilter(''), i: 0, q: '' };
  $('palette').hidden = false;
  const inp = $('paletteInput'); inp.value = ''; inp.focus();
  paletteRender();
}
function closePalette() { $('palette').hidden = true; pal = null; }

$('openPalette').onclick = openPalette;
$('paletteInput').addEventListener('input', (e) => {
  pal.items = paletteFilter(e.target.value); pal.i = 0; paletteRender();
});
$('paletteInput').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); pal.i = Math.min(pal.i + 1, pal.items.length - 1); paletteRender(); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); pal.i = Math.max(pal.i - 1, 0); paletteRender(); }
  else if (e.key === 'Enter') { e.preventDefault(); paletteRun(pal.i); }
  else if (e.key === 'Escape') { e.preventDefault(); closePalette(); }
});
$('palette').addEventListener('mousedown', (e) => { if (e.target === $('palette')) closePalette(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('palette').hidden) closePalette(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    if ($('palette').hidden) openPalette(); else closePalette();
  }
});
