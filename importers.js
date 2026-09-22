/* Find models other apps already downloaded (Ollama, LM Studio) or scan any folder for .gguf files. */
const fs = require('fs');
const path = require('path');
const os = require('os');

function walkGguf(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of ents) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkGguf(p, out, depth + 1);
    else if (/\.gguf$/i.test(e.name) && !/mmproj/i.test(e.name)) out.push(p);
  }
  return out;
}

const entry = (file, name, source) => ({ path: file, name: name || path.basename(file).replace(/\.gguf$/i, ''), size: fs.statSync(file).size, source });

const ollamaRoot = () => process.env.OLLAMA_MODELS || path.join(os.homedir(), '.ollama', 'models');

/* Ollama stores models as manifests that point at content-addressed blobs. The model blob is a plain GGUF file. */
function findOllama(root = ollamaRoot()) {
  const out = [];
  const walk = (dir, rel) => {
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, [...rel, e.name]); continue; }
      try {
        const manifest = JSON.parse(fs.readFileSync(p, 'utf8'));
        const layer = (manifest.layers || []).find((l) => l.mediaType === 'application/vnd.ollama.image.model');
        if (!layer?.digest) continue;
        const blob = path.join(root, 'blobs', layer.digest.replace(':', '-'));
        if (!fs.existsSync(blob)) continue;
        const parts = rel.slice(1); // drop the registry host
        const model = parts[0] === 'library' ? parts.slice(1).join('/') : parts.join('/');
        out.push(entry(blob, `${model}:${e.name}`, 'ollama'));
      } catch { /* not a manifest */ }
    }
  };
  walk(path.join(root, 'manifests'), []);
  return out;
}

const lmStudioRoots = () => [path.join(os.homedir(), '.lmstudio', 'models'), path.join(os.homedir(), '.cache', 'lm-studio', 'models')];

function findLmStudio(roots = lmStudioRoots()) {
  const out = [];
  for (const root of roots) {
    for (const f of walkGguf(root)) out.push(entry(f, path.relative(root, f).replace(/\\/g, '/').replace(/\.gguf$/i, ''), 'lmstudio'));
  }
  return out;
}

const scanFolder = (dir) => walkGguf(dir).map((f) => entry(f, null, 'folder'));

module.exports = { findOllama, findLmStudio, scanFolder, walkGguf, ollamaRoot, lmStudioRoots };
