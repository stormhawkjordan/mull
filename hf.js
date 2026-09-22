/* Hugging Face search + resumable downloads. */
const path = require('path');
const fs = require('fs');
const { once } = require('events');

const HF = 'https://huggingface.co';
const UA = { 'User-Agent': 'Mull/1.2' };
const REPO_RE = /^[\w.-]+\/[\w.-]+$/;
const WHISPER_REPO = 'ggerganov/whisper.cpp';
const okFile = (repo, file) => /\.gguf$/i.test(file) || (repo === WHISPER_REPO && /^ggml-[\w.-]+\.bin$/.test(file));

function register(ctx) {
  const { app, ipcMain, dialog, send, log, userFile, readJson, writeJson, addModels, describe, fmtSize, getWin } = ctx;

  const modelsDir = () => {
    const dir = readJson(userFile('config.json'), {}).modelsDir || path.join(app.getPath('userData'), 'models');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };
  const destFor = (repo, file) => path.join(modelsDir(), ...repo.split('/'), path.basename(file));

  async function hfJson(url) {
    let r;
    try { r = await fetch(url, { headers: UA, signal: AbortSignal.timeout(20000) }); }
    catch { throw new Error("Can't reach Hugging Face. Check your internet connection."); }
    // Hugging Face answers 401 for repos that don't exist as well as for private/gated ones.
    if (r.status === 401 || r.status === 403 || r.status === 404) throw new Error('Repository not found, or it is private / gated (needs a Hugging Face login).');
    if (!r.ok) throw new Error(`Hugging Face returned an error (${r.status}).`);
    return r.json();
  }

  ipcMain.handle('dl:dir', () => modelsDir());
  ipcMain.handle('dl:chooseDir', async () => {
    const r = await dialog.showOpenDialog(getWin(), { title: 'Choose where downloaded models are stored', properties: ['openDirectory', 'createDirectory'] });
    if (r.canceled || !r.filePaths[0]) return modelsDir();
    writeJson(userFile('config.json'), { ...readJson(userFile('config.json'), {}), modelsDir: r.filePaths[0] });
    return modelsDir();
  });

  ipcMain.handle('hf:search', async (_e, q) => {
    const p = new URLSearchParams({ filter: 'gguf', sort: 'downloads', direction: '-1', limit: '30' });
    if (q?.trim()) p.set('search', q.trim());
    const list = await hfJson(`${HF}/api/models?${p}`);
    return list.map((m) => ({ id: m.id || m.modelId, downloads: m.downloads || 0, likes: m.likes || 0, updated: m.lastModified || m.createdAt || null }));
  });

  ipcMain.handle('hf:files', async (_e, repo) => {
    if (!REPO_RE.test(repo)) throw new Error('Invalid repository name.');
    const tree = await hfJson(`${HF}/api/models/${repo}/tree/main?recursive=true`);
    return tree.filter((f) => f.type === 'file' && /\.gguf$/i.test(f.path)).map((f) => {
      const size = f.lfs?.size ?? f.size ?? 0;
      const dest = destFor(repo, f.path);
      const installed = fs.existsSync(dest) && (!size || fs.statSync(dest).size === size);
      const part = dest + '.part';
      return {
        path: f.path, size,
        split: /-\d{5}-of-\d{5}\.gguf$/i.test(f.path),
        projector: /mmproj/i.test(f.path),
        installed, partial: !installed && fs.existsSync(part) ? fs.statSync(part).size : 0,
      };
    });
  });

  const downloads = new Map(); // key -> { ctl, keepPartial }

  ipcMain.handle('dl:start', (_e, { repo, file, size }) => {
    if (!REPO_RE.test(repo) || !okFile(repo, file) || file.split('/').includes('..')) throw new Error('Invalid download request.');
    const key = `${repo}/${file}`;
    if (downloads.has(key)) return key;
    const dest = destFor(repo, file);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const part = dest + '.part';
    const ctl = new AbortController();
    const entry = { ctl, keepPartial: true };
    downloads.set(key, entry);
    const name = path.basename(file);
    const isModel = /\.gguf$/i.test(file);

    (async () => {
      let out;
      const done = (received) => {
        const models = isModel ? addModels([dest]) : undefined;
        if (received) log('info', `Downloaded ${name} (${fmtSize(received)})`);
        send('dl:state', { key, state: 'done', id: isModel ? describe(dest).id : undefined, models, dest });
      };
      try {
        if (fs.existsSync(dest) && (!size || fs.statSync(dest).size === size)) return done(0);
        let start = fs.existsSync(part) ? fs.statSync(part).size : 0;
        try {
          const free = fs.statfsSync(path.dirname(dest)); const avail = free.bavail * free.bsize;
          if (size && avail < size - start + 50e6) throw new Error(`Not enough disk space. Need ${fmtSize(size - start)}, only ${fmtSize(avail)} free.`);
        } catch (e) { if (/disk space/.test(e.message)) throw e; }

        log('info', `Downloading ${name}${start ? ` (resuming from ${fmtSize(start)})` : ''}`);
        const url = `${HF}/${repo}/resolve/main/${file.split('/').map(encodeURIComponent).join('/')}?download=true`;
        const res = await fetch(url, { headers: { ...UA, ...(start ? { Range: `bytes=${start}-` } : {}) }, signal: ctl.signal, redirect: 'follow' });
        if (res.status === 401 || res.status === 403) throw new Error('This model is gated. Accept its license on huggingface.co and sign in, then download it manually.');
        if (res.status === 416) { fs.rmSync(part, { force: true }); throw new Error('The partial file was invalid and was removed. Try again.'); }
        if (res.status !== 200 && res.status !== 206) throw new Error(`Download failed (HTTP ${res.status}).`);
        if (res.status === 200) start = 0; // server ignored the range request
        const total = size || start + Number(res.headers.get('content-length') || 0);

        out = fs.createWriteStream(part, { flags: start ? 'a' : 'w' });
        let received = start, lastT = Date.now(), lastB = received, speed = 0;
        for await (const chunk of res.body) {
          if (!out.write(chunk)) await once(out, 'drain');
          received += chunk.length;
          const now = Date.now();
          if (now - lastT >= 400) {
            speed = (received - lastB) / ((now - lastT) / 1000); lastT = now; lastB = received;
            send('dl:progress', { key, received, total, speed });
          }
        }
        out.end(); await once(out, 'finish'); out = null;
        if (total && received !== total) throw new Error('Download ended early. Try again to resume.');
        fs.renameSync(part, dest);
        done(received);
      } catch (e) {
        if (out) { out.end(); await once(out, 'close').catch(() => {}); }
        if (ctl.signal.aborted) {
          if (!entry.keepPartial) fs.rmSync(part, { force: true });
          send('dl:state', { key, state: entry.keepPartial ? 'paused' : 'cancelled' });
        } else {
          log('error', `Download failed: ${e.message}`);
          send('dl:state', { key, state: 'error', message: e.message });
        }
      } finally { downloads.delete(key); }
    })();
    return key;
  });

  ipcMain.handle('dl:stop', (_e, { key, discard }) => {
    const d = downloads.get(key);
    if (d) { d.keepPartial = !discard; d.ctl.abort(); return true; }
    if (discard) { const m = key.match(/^([^/]+\/[^/]+)\/(.+)$/); if (m) fs.rmSync(destFor(m[1], m[2]) + '.part', { force: true }); }
    return false;
  });

  return { modelsDir, destFor, stopAll: () => { for (const d of downloads.values()) { d.keepPartial = true; d.ctl.abort(); } }, WHISPER_REPO };
}

module.exports = { register, WHISPER_REPO };
