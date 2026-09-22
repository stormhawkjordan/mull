/* Document ingestion + retrieval: parse PDF / DOCX / text, split into chunks, and rank chunks for a question
   (keyword BM25, blended with embedding similarity when an embedding model is configured). */
const fs = require('fs');
const path = require('path');

const TEXT_EXT = new Set(['.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.log', '.js', '.ts', '.py', '.java', '.c', '.cpp', '.h', '.cs', '.go', '.rs', '.html', '.css', '.xml', '.yml', '.yaml', '.ini', '.toml', '.sql', '.sh', '.ps1', '.rtf', '.tex']);
const MAX_BYTES = 30 * 1024 * 1024;

async function extractText(file) {
  const ext = path.extname(file).toLowerCase();
  const st = fs.statSync(file);
  if (st.size > MAX_BYTES) throw new Error('File is larger than 30 MB');
  if (ext === '.pdf') {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(fs.readFileSync(file)), useSystemFonts: true, isEvalSupported: false, disableFontFace: true, verbosity: 0 });
    try {
      const doc = await task.promise;
      const pages = [];
      for (let p = 1; p <= doc.numPages; p++) {
        const tc = await (await doc.getPage(p)).getTextContent();
        pages.push(tc.items.map((i) => i.str + (i.hasEOL ? '\n' : '')).join(' '));
      }
      return pages.join('\n\n');
    } finally { await task.destroy().catch(() => {}); }
  }
  if (ext === '.docx') return (await require('mammoth').extractRawText({ path: file })).value;
  if (!TEXT_EXT.has(ext) && ext !== '') throw new Error(`Unsupported file type ${ext}. Use PDF, DOCX or a text/code file.`);
  const buf = fs.readFileSync(file);
  if (buf.subarray(0, 4096).includes(0)) throw new Error('This looks like a binary file');
  return buf.toString('utf8');
}

/* ~900-character chunks that respect paragraph boundaries, with a little overlap so answers aren't cut in half. */
function chunkText(text, size = 900, overlap = 150) {
  const paras = text.replace(/\r\n?/g, '\n').split(/\n\s*\n/).map((p) => p.replace(/[ \t]+/g, ' ').replace(/\n/g, ' ').trim()).filter(Boolean);
  const pieces = [];
  for (const p of paras) {
    if (p.length <= size) { pieces.push(p); continue; }
    const sentences = p.match(/[^.!?]+[.!?]+\s*|[^.!?]+$/g) || [p];
    let cur = '';
    for (const s of sentences) {
      if (cur && (cur + s).length > size) { pieces.push(cur.trim()); cur = ''; }
      if (s.length > size) { for (let i = 0; i < s.length; i += size) pieces.push(s.slice(i, i + size)); } else cur += s;
    }
    if (cur.trim()) pieces.push(cur.trim());
  }
  const chunks = []; let cur = '';
  for (const p of pieces) {
    if (cur && (cur + ' ' + p).length > size) { chunks.push(cur); cur = (cur.slice(-overlap).replace(/^\S*\s/, '') + ' ' + p).trim(); }
    else cur = cur ? cur + ' ' + p : p;
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks;
}

const STOP = new Set('a an the and or but if of to in on at for from by with as is are was were be been it its this that these those i you he she we they what which who whom how why when where do does did not no so than then there their about into over can could would should will just also me my your our'.split(' '));
const tokenize = (s) => (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) || []).filter((t) => t.length > 1 && !STOP.has(t));

function bm25(chunks, query) {
  const q = [...new Set(tokenize(query))];
  const docs = chunks.map((c) => tokenize(c.t));
  const N = docs.length || 1, avg = docs.reduce((a, d) => a + d.length, 0) / N || 1;
  const df = new Map();
  for (const d of docs) for (const t of new Set(d)) df.set(t, (df.get(t) || 0) + 1);
  return docs.map((d) => {
    const tf = new Map(); for (const t of d) tf.set(t, (tf.get(t) || 0) + 1);
    let s = 0;
    for (const t of q) {
      const f = tf.get(t); if (!f) continue;
      const idf = Math.log(1 + (N - (df.get(t) || 0) + 0.5) / ((df.get(t) || 0) + 0.5));
      s += idf * (f * 2.5) / (f + 1.5 * (0.25 + 0.75 * d.length / avg));
    }
    return s;
  });
}

const cosine = (a, b) => { let d = 0, x = 0, y = 0; for (let i = 0; i < a.length; i++) { d += a[i] * b[i]; x += a[i] * a[i]; y += b[i] * b[i]; } return d / (Math.sqrt(x * y) || 1); };

/* Rank chunks across documents. `docs` = [{id,name,chunks:[{t,v?}]}], `qvec` optional query embedding. */
function search(docs, query, k = 5, qvec = null) {
  const all = [];
  for (const d of docs) d.chunks.forEach((c, i) => all.push({ docId: d.id, name: d.name, idx: i, text: c.t, v: c.v }));
  if (!all.length) return [];
  const kw = bm25(all.map((c) => ({ t: c.text })), query);
  const rank = (scores) => { const order = scores.map((s, i) => [s, i]).sort((a, b) => b[0] - a[0]); const r = new Array(scores.length); order.forEach(([, i], pos) => { r[i] = pos; }); return r; };
  let score = kw;
  if (qvec) {
    const sem = all.map((c) => (c.v ? cosine(qvec, c.v) : 0));
    const rk = rank(kw), rs = rank(sem);
    score = all.map((c, i) => (kw[i] > 0 ? 1 / (60 + rk[i]) : 0) + (c.v ? 1 / (60 + rs[i]) : 0)); // reciprocal-rank fusion
  }
  return all.map((c, i) => ({ docId: c.docId, name: c.name, idx: c.idx, text: c.text, score: score[i] }))
    .filter((c) => c.score > 0).sort((a, b) => b.score - a.score).slice(0, k);
}

module.exports = { extractText, chunkText, search, tokenize, cosine };
