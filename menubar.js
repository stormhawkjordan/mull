'use strict';
/* The top menu bar (File / Edit / View / Models / Preferences / Help). Built the same way as every other
   dropdown in the app (showMenu), so it matches the rest of the UI instead of looking like a native menu. */

let openMenuBtn = null;
function closeMenubar() { hideMenu(); openMenuBtn?.classList.remove('on'); openMenuBtn = null; }

function checklabel(on, label) { return (on ? '✓  ' : '　　') + label; }

function fileMenu() {
  const c = cur();
  const items = [
    { icon: 'plus', label: 'New chat', fn: newChat },
    { icon: 'plus', label: 'Import models…', fn: () => $('importBtn').click() },
  ];
  if (c?.messages.length) {
    items.push('-',
      { icon: 'download', label: 'Export this chat as Markdown…', fn: () => exportChat(c, 'md') },
      { icon: 'download', label: 'Export this chat as JSON…', fn: () => exportChat(c, 'json') });
  }
  items.push('-', { icon: 'x', label: 'Quit Mull', fn: () => api.quitApp() });
  return items;
}

function editMenu() {
  const c = cur();
  const last = c ? [...c.messages].reverse().find((m) => m.role === 'assistant' && m.content) : null;
  const items = [];
  if (last) items.push({ icon: 'copy', label: 'Copy last reply', fn: () => { navigator.clipboard.writeText(last.content); toast('Copied'); } });
  if (last && !generating && activeId) items.push({ icon: 'refresh', label: 'Regenerate last reply', fn: () => { c.messages.pop(); saveChats(); generate(); } });
  if (items.length) items.push('-');
  items.push({ icon: 'search', label: 'Find in chats & messages…', fn: openPalette });
  if (c?.messages.length && !generating) items.push('-', { icon: 'trash', label: 'Clear this chat', danger: true, fn: () => { if (!confirm('Remove every message in this chat? The chat itself is kept.')) return; c.messages = []; touch(c); saveChats(); renderChatList(); renderChat(); } });
  if (c && !generating) items.push({ icon: 'trash', label: 'Delete this chat', danger: true, fn: () => deleteChat(c) });
  return items;
}

function viewMenu() {
  const toggle = (k, extra) => () => { settings[k] = !settings[k]; saveSettings(); applySettings(); renderChat(); extra?.(); };
  const items = [
    { label: checklabel(settings.theme === 'dark', 'Dark theme'), fn: () => { settings.theme = 'dark'; saveSettings(); applySettings(); } },
    { label: checklabel(settings.theme === 'light', 'Light theme'), fn: () => { settings.theme = 'light'; saveSettings(); applySettings(); } },
    { label: checklabel(settings.theme === 'system', 'Match system'), fn: () => { settings.theme = 'system'; saveSettings(); applySettings(); } },
    '-',
    { label: checklabel(settings.showThinking, 'Show model thinking'), fn: toggle('showThinking') },
    { label: checklabel(settings.liveThinking, 'Live thinking (stream reasoning as it happens)'), fn: toggle('liveThinking') },
    { label: checklabel(settings.showStats, 'Show token stats under replies'), fn: toggle('showStats') },
    { label: checklabel(settings.statusDetail, 'Detailed status line (live timers, tok/s)'), fn: toggle('statusDetail') },
    '-',
    { label: checklabel(settings.animations === 'on', 'Animations: on'), fn: () => { settings.animations = 'on'; saveSettings(); applySettings(); } },
    { label: checklabel(settings.animations === 'off', 'Animations: off'), fn: () => { settings.animations = 'off'; saveSettings(); applySettings(); } },
    '-',
    { icon: 'search', label: 'Command palette…', sub: 'Ctrl+K', fn: openPalette },
    { icon: 'terminal', label: settings.verboseLog ? 'Hide verbose log' : 'Show verbose log', fn: () => $('toggleLog').click() },
    '-',
    { icon: 'plus', label: 'Increase text size', fn: () => { settings.fontSize = Math.min(20, settings.fontSize + 1); saveSettings(); applySettings(); } },
    { icon: 'x', label: 'Decrease text size', fn: () => { settings.fontSize = Math.max(12, settings.fontSize - 1); saveSettings(); applySettings(); } },
  ];
  return items;
}

function modelsMenu() {
  const items = [
    { icon: 'download', label: 'Get models…', fn: () => openBrowser() },
    { icon: 'plus', label: 'Import models…', fn: () => $('importBtn').click() },
    { icon: 'columns', label: 'Compare two models…', fn: () => openCompare() },
  ];
  if (activeId) {
    const m = models.find((x) => x.id === activeId);
    items.push('-', { icon: 'info', label: 'Details for the loaded model', fn: () => showModelInfo(m) }, { icon: 'x', label: 'Eject the loaded model', fn: ejectModel });
  }
  if (models.length) {
    items.push('-');
    for (const m of models.slice(0, 10)) items.push({ icon: 'monitor', label: checklabel(m.id === activeId, m.name), fn: () => { if (m.id !== activeId) selectModel(m.id); showTab('models'); } });
  }
  return items;
}

function prefsMenu() {
  const tabs = SCHEMA.map((g) => ({ label: 'Settings: ' + g.title, fn: () => openSettings(g.id) }));
  return [
    { icon: 'sliders', label: 'Settings…', fn: () => openSettings() },
    '-', ...tabs, '-',
    { icon: 'book', label: 'Library: Personas', fn: () => openLibrary('personas') },
    { icon: 'book', label: 'Library: Saved prompts', fn: () => openLibrary('prompts') },
    '-',
    { icon: 'monitor', label: 'Run the setup guide again', fn: openWizard },
  ];
}

/* A small on-demand dialog for About / Shortcuts, so we don't need to declare two more modals in index.html. */
function showInfoDialog(title, html) {
  let m = $('infoDlg');
  if (!m) {
    m = el('div', 'modal'); m.id = 'infoDlg'; m.hidden = true;
    m.innerHTML = `<div class="dialog info-dialog"><div class="d-head"><strong id="infoDlgTitle"></strong><span class="spacer"></span><button id="infoDlgClose" class="ghost">${ic('x')}</button></div><div class="d-body" id="infoDlgBody"></div></div>`;
    document.body.appendChild(m);
    m.addEventListener('mousedown', (e) => { if (e.target === m) m.hidden = true; });
    m.querySelector('#infoDlgClose').onclick = () => { m.hidden = true; };
  }
  m.querySelector('#infoDlgTitle').textContent = title;
  m.querySelector('#infoDlgBody').innerHTML = html;
  m.hidden = false;
}

function helpMenu() {
  return [
    { icon: 'info', label: 'About Mull', fn: () => showInfoDialog('About Mull', `
      <p>Mull ${esc(sysInfo?.version || '')}</p>
      <p class="note-inline">AI models that run entirely on this PC. Nothing you type is sent anywhere, except to Hugging Face when you choose to search for or download a model.</p>
      <p class="note-inline">${esc(sysInfo?.cores || '?')} CPU threads · ${esc(sysInfo?.ramGB ?? '?')} GB RAM detected.</p>`) },
    { icon: 'terminal', label: 'Keyboard shortcuts', fn: () => showInfoDialog('Keyboard shortcuts', `
      <table class="kv">
        <tr><td>Ctrl+K</td><td>Command palette</td></tr>
        <tr><td>Enter</td><td>Send message (Shift+Enter for a new line)</td></tr>
        <tr><td>Esc</td><td>Close the open dialog or menu</td></tr>
        <tr><td>/ in the message box</td><td>Insert a saved prompt</td></tr>
      </table>`) },
    '-',
    { icon: 'monitor', label: 'Run the setup guide again', fn: openWizard },
  ];
}

const MENUS = { file: fileMenu, edit: editMenu, view: viewMenu, models: modelsMenu, prefs: prefsMenu, help: helpMenu };

document.querySelectorAll('#menubar button[data-menu]').forEach((btn) => {
  btn.onclick = () => {
    if (openMenuBtn === btn) { closeMenubar(); return; }
    closeMenubar();
    openMenuBtn = btn; btn.classList.add('on');
    const r = btn.getBoundingClientRect();
    // wrap each action so picking anything also clears this button's highlighted state
    const items = MENUS[btn.dataset.menu]().map((it) => (it === '-' ? it : { ...it, fn: () => { closeMenubar(); it.fn(); } }));
    showMenu(r.left, r.bottom + 1, items);
  };
  btn.onmouseenter = () => { if (openMenuBtn && openMenuBtn !== btn) btn.onclick(); };
});
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menubar') && !e.target.closest('#menu')) closeMenubar(); });
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const info = $('infoDlg'); if (info && !info.hidden) { info.hidden = true; return; }
  if (openMenuBtn) closeMenubar();
});
