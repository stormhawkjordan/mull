const { app, BrowserWindow, ipcMain, dialog, shell, Tray, Menu, globalShortcut, nativeImage, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');

const { Engine, fmtSize } = require('./engine');
const { createApiServer } = require('./server');
const importers = require('./importers');
const docsLib = require('./docs');
const { buildTools } = require('./tools');
const updater = require('./updater');
const hfModule = require('./hf');

app.setAppUserModelId('com.mull.app');

/* Portable build: electron-builder's "portable" target sets PORTABLE_EXECUTABLE_DIR to the folder the
   .exe itself lives in (e.g. a USB stick), so chats/settings/models stay next to the exe instead of
   %APPDATA% — genuinely no-install, no registry, nothing left behind on the PC it's run on. */
if (process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'Mull-Data'));
}

/* ---------------- Paths, storage, one-time migration from the old app name ---------------- */
const userFile = (name) => path.join(app.getPath('userData'), name);
const readJson = (file, fallback) => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } };
const writeJson = (file, data) => {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
};

function migrateOldData() {
  try {
    const dest = app.getPath('userData');
    fs.mkdirSync(dest, { recursive: true });
    if (fs.existsSync(path.join(dest, '.migrated')) || fs.existsSync(path.join(dest, 'models.json'))) return;
    for (const old of ['Local AI Chat', 'local-ai-chat']) {
      const src = path.join(process.env.MULL_TEST_APPDATA || app.getPath('appData'), old);
      if (src === dest || !fs.existsSync(src)) continue;
      for (const f of ['models.json', 'chats.json', 'config.json']) if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, f));
      const ls = path.join(src, 'Local Storage'); // settings live here
      if (fs.existsSync(ls) && !fs.existsSync(path.join(dest, 'Local Storage'))) fs.cpSync(ls, path.join(dest, 'Local Storage'), { recursive: true });
      fs.writeFileSync(path.join(dest, '.migrated'), old);
      return;
    }
  } catch { /* migration is best-effort */ }
}
migrateOldData();

let win = null, tray = null, quitting = false;
const send = (ch, payload) => { if (win && !win.isDestroyed()) win.webContents.send(ch, payload); };
const log = (level, msg) => send('log', { t: Date.now(), level, msg });
const status = (s) => send('model:status', s);

const readStore = () => readJson(userFile('models.json'), []);
const writeStore = (m) => writeJson(userFile('models.json'), m);
const idOf = (file) => Buffer.from(file).toString('base64url');
function describe(file, name, source) {
  const st = fs.statSync(file);
  return { id: idOf(file), path: file, name: name || path.basename(file).replace(/\.gguf$/i, ''), size: st.size, ...(source ? { source } : {}) };
}
/* Add models by path. Entries from importers carry their own friendly name (e.g. Ollama blobs have no .gguf extension). */
function addModels(files) {
  const store = readStore();
  for (const f of files) {
    const e = typeof f === 'string' ? { path: f } : f;
    if (!e.path || !fs.existsSync(e.path) || (typeof f === 'string' && !/\.gguf$/i.test(e.path))) continue;
    const m = describe(e.path, e.name, e.source);
    const at = store.findIndex((x) => x.id === m.id);
    if (at < 0) { store.push(m); log('info', `Imported ${m.name} (${fmtSize(m.size)})`); }
  }
  writeStore(store);
  return store;
}

/* ---------------- Preferences (config.json) ---------------- */
const PREF_DEFAULTS = {
  autoLoadLast: true, lastModelId: '', lastOpts: null, closeToTray: false, hotkeyEnabled: false, hotkey: 'Ctrl+Alt+M', launchAtLogin: false,
  apiEnabled: false, apiPort: 11500, apiKey: '', apiCors: false, workspace: '', embedModelId: '', speechModel: 'ggml-tiny.en.bin', speechLang: 'en',
  updateUrl: '', autoCheckUpdates: false, wizardDone: false, networkMode: 'offline',
};
const getPrefs = () => {
  const raw = readJson(userFile('config.json'), {});
  if (raw.networkMode === undefined && raw.networkLock !== undefined) { // migrate the older, single-session "network lock" toggle
    raw.networkMode = raw.networkLock === false ? 'online' : 'offline';
    delete raw.networkLock;
    writeJson(userFile('config.json'), raw);
  }
  return { ...PREF_DEFAULTS, ...raw };
};
const savePrefs = (patch) => { const next = { ...getPrefs(), ...patch }; writeJson(userFile('config.json'), next); return next; };
const runtime = { hotkeyOk: false, hotkeyError: '' };

/* ---------------- Network lock ----------------
   Offline (the default) means Mull makes no outgoing network request at all, enforced by overriding
   the one function every network call in this app actually goes through: the global fetch(). Getting
   models, downloading the speech model and checking for updates all ask first and switch access on
   just for that, then switch it back — see ensureNetwork() in renderer.js.

   That temporary "on" is deliberately kept in memory only (tempNetworkOn), never written to config.json.
   Only the status-bar toggle and the Settings dropdown — explicit, standing choices — persist networkMode.
   If a temporary session's "off" never gets to run (the app crashes, is force-closed, or the person just
   closes the Get Models window via task manager mid-download), an in-memory flag simply resets to false
   next launch; a persisted one would have silently left the next launch online with no confirmation at
   all, which is exactly what "offline by default" is supposed to rule out. */
const realFetch = globalThis.fetch.bind(globalThis);
let tempNetworkOn = false;
const networkIsOn = () => getPrefs().networkMode === 'online' || tempNetworkOn;
globalThis.fetch = (input, init) => {
  if (networkIsOn()) return realFetch(input, init);
  return Promise.reject(new Error('Mull is offline right now. Turn on network access (Settings → General → Network, or the status bar) to reach the internet.'));
};
ipcMain.handle('net:tempOn', () => { tempNetworkOn = true; });
ipcMain.handle('net:tempOff', () => { tempNetworkOn = false; });

const engine = new Engine({ log, status });
const DEFAULT_OPTS = { contextSize: 8192, gpuLayers: 'auto', flashAttention: 'auto', threads: 0, mmap: true };

async function loadById(id, opts) {
  const info = readStore().find((m) => m.id === id);
  if (!info) throw new Error('Model file not found. It may have been moved or deleted.');
  if (!fs.existsSync(info.path)) throw new Error('The model file is missing from disk.');
  const meta = await engine.load(info, opts);
  savePrefs({ lastModelId: id, lastOpts: opts });
  return meta;
}

const api = createApiServer({
  engine, log,
  listModels: () => readStore().filter((m) => fs.existsSync(m.path)),
  ensureModel: async (name) => {
    const q = String(name).toLowerCase();
    const all = readStore();
    const hit = all.find((m) => m.name.toLowerCase() === q || m.id === name) || all.find((m) => m.name.toLowerCase().includes(q));
    if (!hit) { if (engine.loaded) return; throw new Error(`Model "${name}" is not installed in Mull.`); }
    if (engine.loaded?.id === hit.id) return;
    log('info', `API request switched model to ${hit.name}`);
    const meta = await engine.lock(() => loadById(hit.id, getPrefs().lastOpts || DEFAULT_OPTS));
    send('model:external', meta);
  },
});

async function applyApi() {
  let p = getPrefs();
  // CORS without a key would let any web page open in the user's browser call the local API silently
  // (the browser's same-origin policy is exactly what CORS: * turns off). Never allow that combination.
  if (p.apiEnabled && p.apiCors && !p.apiKey) {
    p = savePrefs({ apiKey: 'mull-' + crypto.randomBytes(18).toString('base64url') });
    log('warn', 'CORS was on with no API key, which would let any web page reach the local API; generated one automatically.');
  }
  if (p.apiEnabled) await api.start(+p.apiPort || 11500, { key: p.apiKey, cors: p.apiCors });
  else await api.stop();
}

/* ---------------- Window, tray, hotkey ---------------- */
const iconPath = path.join(__dirname, 'build', 'icon.png');

function createWindow() {
  win = new BrowserWindow({
    width: 1240, height: 820, minWidth: 860, minHeight: 540,
    backgroundColor: '#0b0d0c', title: 'Mull', icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false,
      sandbox: true, webviewTag: false, spellcheck: false, nodeIntegrationInSubFrames: false, allowRunningInsecureContent: false,
    },
  });
  win.setMenuBarVisibility(false);
  // Links in chat open in the real browser, never inside the app window.
  const external = (url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); };
  win.webContents.setWindowOpenHandler(({ url }) => { external(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); external(url); } });
  win.on('close', (e) => { if (!quitting && getPrefs().closeToTray) { e.preventDefault(); win.hide(); } });
  win.on('closed', () => { win = null; });
  win.loadFile('index.html');
}

function showWindow() {
  if (!win) createWindow();
  else { if (win.isMinimized()) win.restore(); win.show(); win.focus(); }
  send('app:focus');
}

function applyTray() {
  const want = getPrefs().closeToTray;
  if (!want && tray) { tray.destroy(); tray = null; }
  if (want && !tray) {
    tray = new Tray(nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 }));
    tray.setToolTip('Mull');
    tray.setContextMenu(Menu.buildFromTemplate([
      { label: 'Open Mull', click: showWindow },
      { label: 'New chat', click: () => { showWindow(); send('app:new-chat'); } },
      { type: 'separator' },
      { label: 'Quit', click: () => { quitting = true; app.quit(); } },
    ]));
    tray.on('click', showWindow);
  }
}

function applyHotkey() {
  globalShortcut.unregisterAll();
  const p = getPrefs();
  runtime.hotkeyOk = false; runtime.hotkeyError = '';
  if (!p.hotkeyEnabled) return;
  try {
    runtime.hotkeyOk = globalShortcut.register(p.hotkey, () => {
      if (win && win.isVisible() && win.isFocused()) win.hide(); else showWindow();
    });
    if (!runtime.hotkeyOk) runtime.hotkeyError = 'That shortcut is already used by another app.';
  } catch { runtime.hotkeyError = 'That is not a valid shortcut. Example: Ctrl+Alt+M'; }
}

function applyLogin() {
  try { app.setLoginItemSettings({ openAtLogin: !!getPrefs().launchAtLogin, args: ['--hidden'] }); } catch { /* not supported here */ }
}

const prefsView = () => ({ ...getPrefs(), lastOpts: undefined, hotkeyOk: runtime.hotkeyOk, hotkeyError: runtime.hotkeyError, netTemp: tempNetworkOn, api: { ...api.state, url: `http://127.0.0.1:${getPrefs().apiPort}/v1` } });

ipcMain.handle('prefs:get', () => prefsView());
ipcMain.handle('prefs:set', async (_e, patch) => {
  const before = getPrefs();
  const clean = {};
  for (const k of Object.keys(PREF_DEFAULTS)) if (k in patch && k !== 'lastOpts') clean[k] = patch[k];
  if ('apiPort' in clean) clean.apiPort = Math.min(65535, Math.max(1024, Math.round(+clean.apiPort) || 11500));
  if ('hotkey' in clean) clean.hotkey = String(clean.hotkey).trim() || 'Ctrl+Alt+M';
  savePrefs(clean);
  const after = getPrefs();
  if (after.closeToTray !== before.closeToTray) applyTray();
  if (after.hotkeyEnabled !== before.hotkeyEnabled || after.hotkey !== before.hotkey) applyHotkey();
  if (after.launchAtLogin !== before.launchAtLogin) applyLogin();
  if (['apiEnabled', 'apiPort', 'apiKey', 'apiCors'].some((k) => after[k] !== before[k])) await applyApi();
  if (after.embedModelId !== before.embedModelId) await engine.disposeEmbedder();
  return prefsView();
});
ipcMain.handle('prefs:newKey', () => 'mull-' + crypto.randomBytes(18).toString('base64url'));
ipcMain.handle('prefs:chooseWorkspace', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose the folder the model may read from', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return getPrefs().workspace;
  savePrefs({ workspace: r.filePaths[0] });
  return r.filePaths[0];
});

/* ---------------- System / misc ---------------- */
ipcMain.handle('sys:info', () => ({
  cores: os.cpus().length, ramGB: +(os.totalmem() / 1073741824).toFixed(1), freeGB: +(os.freemem() / 1073741824).toFixed(1),
  version: app.getVersion(), packaged: app.isPackaged,
}));
let gpuInfo = null;
ipcMain.handle('sys:gpu', async () => {
  if (gpuInfo) return gpuInfo;
  try {
    const llama = await engine.instance();
    const v = llama.gpu ? await llama.getVramState() : null;
    gpuInfo = { backend: engine.backend(), vramGB: v ? +(v.total / 1073741824).toFixed(1) : 0 };
  } catch { gpuInfo = { backend: 'CPU', vramGB: 0 }; }
  return gpuInfo;
});
/* Everything the setup wizard needs to judge which models this PC can run. */
ipcMain.handle('sys:specs', async () => {
  const cpus = os.cpus();
  const names = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', 'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name'], { timeout: 9000, windowsHide: true },
      (err, out) => resolve(err ? [] : String(out).split(/\r?\n/).map((l) => l.trim()).filter((n) => n && !/basic render|remote|virtual|meta virtual|vivi|indirect display/i.test(n))));
  });
  let gpu = { backend: 'CPU', vramGB: 0 };
  try { const llama = await engine.instance(); const v = llama.gpu ? await llama.getVramState() : null; gpu = { backend: engine.backend(), vramGB: v ? +(v.total / 1073741824).toFixed(1) : 0 }; } catch { /* CPU only */ }
  let disk = { freeGB: 0, totalGB: 0 };
  try { const st = fs.statfsSync(hfCtl.modelsDir()); disk = { freeGB: +((st.bavail * st.bsize) / 1073741824).toFixed(0), totalGB: +((st.blocks * st.bsize) / 1073741824).toFixed(0) }; } catch { /* unknown */ }
  return {
    cpu: (cpus[0]?.model || 'Unknown processor').replace(/\s+/g, ' ').trim(), threads: cpus.length,
    ramGB: +(os.totalmem() / 1073741824).toFixed(1), freeRamGB: +(os.freemem() / 1073741824).toFixed(1),
    gpus: names, backend: gpu.backend, vramGB: gpu.vramGB, diskFreeGB: disk.freeGB, diskTotalGB: disk.totalGB, modelsDir: hfCtl.modelsDir(),
  };
});
ipcMain.handle('open:external', (_e, url) => { if (/^https?:\/\//i.test(url)) shell.openExternal(url); });
ipcMain.handle('app:quit', () => { quitting = true; app.quit(); });
ipcMain.handle('update:check', async () => updater.check(getPrefs().updateUrl, app.getVersion()));

/* ---------------- Chats + export ---------------- */
ipcMain.handle('chats:load', () => readJson(userFile('chats.json'), null));
ipcMain.handle('chats:save', (_e, chats) => { writeJson(userFile('chats.json'), chats); return true; });
ipcMain.handle('file:save', async (_e, { name, content, ext }) => {
  const r = await dialog.showSaveDialog(win, { defaultPath: name, filters: [{ name: ext.toUpperCase(), extensions: [ext] }] });
  if (r.canceled || !r.filePath) return false;
  fs.writeFileSync(r.filePath, content, 'utf8');
  return r.filePath;
});

/* ---------------- Models: list, import, info ---------------- */
ipcMain.handle('models:list', () => readStore().filter((m) => fs.existsSync(m.path)));
ipcMain.handle('models:import', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Import GGUF model(s)', properties: ['openFile', 'multiSelections'], filters: [{ name: 'GGUF models', extensions: ['gguf'] }] });
  return r.canceled ? readStore() : addModels(r.filePaths);
});
ipcMain.handle('models:importPaths', (_e, files) => addModels(files));
ipcMain.handle('models:remove', async (_e, id) => {
  if (engine.loaded?.id === id) await engine.unload();
  const store = readStore().filter((m) => m.id !== id);
  writeStore(store);
  return store;
});
ipcMain.handle('import:detect', () => {
  const count = (fn) => { try { return fn().length; } catch { return 0; } };
  return { ollama: count(() => importers.findOllama()), lmstudio: count(() => importers.findLmStudio()) };
});
ipcMain.handle('import:run', (_e, source) => {
  const found = source === 'ollama' ? importers.findOllama() : importers.findLmStudio();
  const before = readStore().length;
  const store = addModels(found);
  return { models: store, added: store.length - before, found: found.length };
});
ipcMain.handle('import:folder', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Choose a folder to scan for .gguf models', properties: ['openDirectory'] });
  if (r.canceled || !r.filePaths[0]) return { models: readStore(), added: 0, found: 0, canceled: true };
  const found = importers.scanFolder(r.filePaths[0]);
  const before = readStore().length;
  const store = addModels(found);
  return { models: store, added: store.length - before, found: found.length };
});
ipcMain.handle('models:info', async (_e, id) => {
  const m = readStore().find((x) => x.id === id);
  if (!m) throw new Error('Model not found');
  return { ...(await engine.info(m.path, m.size)), path: m.path, source: m.source || '' };
});

const hfCtl = hfModule.register({ app, ipcMain, dialog, send, log, userFile, readJson, writeJson, addModels, describe, fmtSize, getWin: () => win });

/* ---------------- Loading ---------------- */
ipcMain.handle('model:load', (_e, { id, opts }) => engine.lock(() => loadById(id, opts)));
ipcMain.handle('model:unload', () => engine.lock(() => engine.unload()));

/* ---------------- Chat (with optional tools + documents context prepared by the window) ---------------- */
let abortCtl = null;
const pendingAsks = new Map();
ipcMain.handle('tool:answer', (_e, { id, allow }) => { pendingAsks.get(id)?.(!!allow); pendingAsks.delete(id); });
const denyAllPending = () => { for (const r of pendingAsks.values()) r(false); pendingAsks.clear(); };

ipcMain.handle('chat:send', async (_e, p) => {
  const { defineChatSessionFunction } = await import('node-llama-cpp');
  const ac = new AbortController(); abortCtl = ac;
  const autoAllow = new Set(p.autoAllow || []);
  const functions = p.tools ? buildTools({
    define: defineChatSessionFunction,
    workspace: () => getPrefs().workspace,
    emit: (e) => send('chat:event', e),
    ask: ({ id, name, args }) => (autoAllow.has(name) ? Promise.resolve(true) : new Promise((resolve) => { pendingAsks.set(id, resolve); send('tool:ask', { id, name, args }); })),
  }) : undefined;
  const sys = (p.system || '').trim();
  log('info', `Prompt sent · ${p.messages.length} message(s) in history · temp ${p.gen.temperature}` +
    (sys ? ` · system: "${sys.slice(0, 40).replace(/\s+/g, ' ')}${sys.length > 40 ? '…' : ''}"` : ' · no system prompt') +
    (p.thinking?.mode !== 'default' ? ` · thinking ${p.thinking.mode}` : '') + (functions ? ` · tools: ${Object.keys(functions).join(', ')}` : ''));
  send('chat:event', { type: 'start' });
  try {
    const r = await engine.chat({
      messages: p.messages, system: p.system, gen: p.gen, thinking: p.thinking, functions, signal: ac.signal,
      onChunk: (c) => send('chat:event', c.kind === 'thought' ? { type: 'thought', text: c.text, n: c.n, end: c.end } : { type: 'text', text: c.text, n: c.n }),
    });
    log(r.aborted ? 'warn' : 'info', `${r.aborted ? 'Stopped' : 'Finished'} · ${r.tokens} tokens (${r.thoughtTokens} thinking) in ${r.seconds.toFixed(1)}s · context ${r.ctxUsed}/${r.ctxSize}`);
    return { ctxUsed: r.ctxUsed, ctxSize: r.ctxSize };
  } catch (e) {
    if (functions && /function|tool/i.test(e.message)) throw new Error("This model can't use tools. Turn tools off, or pick a model that supports them (for example Qwen or Llama 3).");
    throw e;
  } finally { abortCtl = null; denyAllPending(); }
});
ipcMain.handle('chat:stop', () => { abortCtl?.abort(); denyAllPending(); });

/* ---------------- Documents ---------------- */
const docsDir = () => { const d = userFile('docs'); fs.mkdirSync(d, { recursive: true }); return d; };
const embedInfo = () => { const id = getPrefs().embedModelId; return id ? readStore().find((m) => m.id === id) : null; };
const docPrefix = (m) => (/nomic/i.test(m?.name || '') ? { doc: 'search_document: ', query: 'search_query: ' } : { doc: '', query: '' });

async function ingest(file) {
  const name = path.basename(file);
  send('docs:progress', { name, stage: 'Reading' });
  const text = await docsLib.extractText(file);
  if (text.trim().length < 20) throw new Error(`No readable text found in ${name}. Scanned PDFs need OCR, which isn't supported.`);
  const chunks = docsLib.chunkText(text).map((t) => ({ t }));
  const em = embedInfo();
  let embedded = false;
  if (em && fs.existsSync(em.path)) {
    try {
      const pre = docPrefix(em).doc;
      for (let i = 0; i < chunks.length; i += 8) {
        send('docs:progress', { name, stage: 'Embedding', done: i, total: chunks.length });
        const vecs = await engine.embed(em.path, chunks.slice(i, i + 8).map((c) => pre + c.t));
        vecs.forEach((v, k) => { chunks[i + k].v = v; });
      }
      embedded = true;
    } catch (e) { log('warn', `Embedding failed, using keyword search only: ${e.message}`); chunks.forEach((c) => delete c.v); }
  }
  const id = crypto.randomBytes(6).toString('hex');
  writeJson(path.join(docsDir(), id + '.json'), { id, name, chunks });
  log('info', `Added document ${name} · ${chunks.length} passages${embedded ? ' · embedded' : ''}`);
  return { id, name, chars: text.length, chunks: chunks.length, embedded };
}
ipcMain.handle('docs:add', async (_e, files) => {
  const ok = [], failed = [];
  for (const f of files) { try { ok.push(await ingest(f)); } catch (e) { failed.push({ name: path.basename(f), error: e.message }); } }
  send('docs:progress', null);
  return { ok, failed };
});
ipcMain.handle('docs:pick', async () => {
  const r = await dialog.showOpenDialog(win, { title: 'Attach documents', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Documents', extensions: ['pdf', 'docx', 'txt', 'md', 'csv', 'json', 'log', 'html', 'xml', 'yml', 'yaml', 'js', 'ts', 'py', 'java', 'c', 'cpp', 'cs', 'go', 'rs', 'sql'] }] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('docs:remove', (_e, id) => { if (/^[a-f0-9]+$/.test(id)) fs.rmSync(path.join(docsDir(), id + '.json'), { force: true }); });
ipcMain.handle('docs:search', async (_e, { ids, query, k }) => {
  const docs = ids.filter((i) => /^[a-f0-9]+$/.test(i)).map((i) => readJson(path.join(docsDir(), i + '.json'), null)).filter(Boolean);
  let qvec = null;
  const em = embedInfo();
  if (em && fs.existsSync(em.path) && docs.some((d) => d.chunks.some((c) => c.v))) {
    try { qvec = (await engine.embed(em.path, [docPrefix(em).query + query]))[0]; } catch { /* keyword only */ }
  }
  return docsLib.search(docs, query, k || 5, qvec);
});

/* ---------------- Compare: one prompt, two models, one after the other ---------------- */
let cmpCtl = null;
ipcMain.handle('cmp:run', (_e, p) => engine.lock(async () => {
  const ac = new AbortController(); cmpCtl = ac;
  const store = readStore();
  if (p.ejectFirst && engine.loaded) { await engine.unload(); send('model:external', null); }
  try {
    for (const side of ['a', 'b']) {
      if (ac.signal.aborted) break;
      const info = store.find((m) => m.id === p[side]);
      const ev = (e) => send('cmp:event', { side, ...e });
      if (!info) { ev({ type: 'error', message: 'Model not found' }); continue; }
      ev({ type: 'status', text: 'Loading model…', progress: 0 });
      let tmp;
      try {
        tmp = await engine.loadTemp(info, p.opts?.[side] || DEFAULT_OPTS, (pr) => ev({ type: 'status', text: 'Loading model…', progress: pr }));
        ev({ type: 'status', text: 'Generating…' });
        const r = await engine.run({
          seq: tmp.sequence, messages: [{ role: 'user', content: p.prompt }], system: p.system, gen: p.gen, thinking: p.thinking, signal: ac.signal,
          onChunk: (c) => ev({ type: c.kind, text: c.text, n: c.n, end: c.end }),
        });
        ev({ type: 'done', tokens: r.tokens, thoughtTokens: r.thoughtTokens, seconds: r.seconds, ttft: r.ttft, aborted: r.aborted });
      } catch (e) { ev({ type: 'error', message: e.message }); }
      finally { await tmp?.dispose(); }
    }
  } finally { cmpCtl = null; }
  return true;
}));
ipcMain.handle('cmp:stop', () => cmpCtl?.abort());

/* ---------------- Voice: offline speech recognition (whisper) ---------------- */
let whisper = null;
const speechPath = () => hfCtl.destFor(hfCtl.WHISPER_REPO, getPrefs().speechModel);
ipcMain.handle('voice:status', () => ({ ready: fs.existsSync(speechPath()), model: getPrefs().speechModel }));
ipcMain.handle('voice:transcribe', async (_e, buf) => {
  const file = speechPath();
  if (!fs.existsSync(file)) throw new Error('SPEECH_MODEL_MISSING');
  if (!whisper || whisper.file !== file) {
    if (whisper) await whisper.ctx.release().catch(() => {});
    const { initWhisper } = await import('@fugood/whisper.node');
    whisper = { file, ctx: await initWhisper({ filePath: file, useGpu: false }) };
  }
  const u8 = buf instanceof ArrayBuffer ? new Uint8Array(buf) : new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  const ab = u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const lang = getPrefs().speechLang || 'en';
  const r = await whisper.ctx.transcribeData(ab, { language: lang }).promise;
  return String(r.result || '').replace(/\[[A-Z_ ]+\]|\*[A-Z ]+\*/g, '').trim();
});

/* ---------------- App lifecycle ---------------- */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) app.quit();
else {
  app.on('second-instance', showWindow);
  app.whenReady().then(async () => {
    // Microphone for dictation is the only permission the app asks for.
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'audioCapture'));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => permission === 'media' || permission === 'audioCapture');
    // Belt-and-braces: the window's own CSP already stops it reaching the network, but block at the
    // Chromium network-stack level too, in case anything in the page ever tries (an image, a stray link).
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      if (networkIsOn()) return callback({ cancel: false });
      try {
        const u = new URL(details.url);
        if (u.protocol === 'file:' || u.protocol === 'devtools:' || u.protocol === 'chrome-extension:' || u.protocol === 'data:') return callback({ cancel: false });
      } catch { /* fall through to blocked */ }
      callback({ cancel: true });
    });
    createWindow();
    applyTray(); applyHotkey();
    if (getPrefs().apiEnabled) applyApi();
    if (process.argv.includes('--hidden') && getPrefs().closeToTray) win.hide();
  });
  app.on('before-quit', () => { quitting = true; tempNetworkOn = false; });
  app.on('window-all-closed', async () => {
    if (!quitting && getPrefs().closeToTray) return;
    globalShortcut.unregisterAll();
    hfCtl.stopAll();
    await api.stop().catch(() => {});
    await engine.disposeEmbedder().catch(() => {});
    await engine.unload().catch(() => {});
    app.quit();
  });
  app.on('will-quit', () => globalShortcut.unregisterAll());
}
