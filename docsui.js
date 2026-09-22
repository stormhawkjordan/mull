'use strict';
/* Chat with documents: attach files to a chat, retrieve relevant passages for each question, show sources. */

let docStatus = '';
api.onDocsProgress((p) => {
  docStatus = p ? `${p.stage} ${p.name}${p.total ? ` · ${p.done}/${p.total}` : '…'}` : '';
  renderDocChips();
});

async function attachPaths(paths) {
  if (!paths?.length) return;
  if (!cur()) newChat();
  const c = cur();
  const known = new Set((c.docs || []).map((d) => d.name));
  const fresh = paths.filter((p) => !known.has(p.split(/[\\/]/).pop()));
  if (!fresh.length) return toast('Those documents are already attached');
  docStatus = 'Reading documents…'; renderDocChips();
  let res;
  try { res = await api.addDocs(fresh); } catch (e) { docStatus = ''; renderDocChips(); return toast(cleanErr(e)); }
  docStatus = '';
  if (res.ok.length) { (c.docs ||= []).push(...res.ok); saveChats(); toast(`Attached ${res.ok.map((d) => d.name).join(', ')}`); }
  for (const f of res.failed) { notice(`${f.name}: ${f.error}`); }
  renderDocChips();
}

function renderDocChips() {
  const box = $('docChips'), c = cur();
  const docs = c?.docs || [];
  box.hidden = !docs.length && !docStatus;
  box.innerHTML = '';
  if (docs.length) box.appendChild(el('span', 'dc-label', ic('paperclip', 13) + ' Answers use'));
  for (const d of docs) {
    const chip = el('span', 'doc-chip');
    chip.innerHTML = `<span class="dn" title="${esc(d.name)}">${esc(d.name)}</span><span class="dm">${d.chunks} passages${d.embedded ? ' · semantic' : ''}</span><button type="button" title="Remove" class="x">${ic('x', 12)}</button>`;
    chip.querySelector('.x').onclick = () => { api.removeDoc(d.id); c.docs = c.docs.filter((x) => x.id !== d.id); saveChats(); renderDocChips(); };
    box.appendChild(chip);
  }
  if (docStatus) box.appendChild(el('span', 'dc-status', esc(docStatus)));
}

/* Retrieve passages for the newest question and fold them into that message (the stored chat keeps the plain question). */
async function withDocContext(c, history) {
  if (!c.docs?.length) return { messages: history, sources: null };
  const q = history[history.length - 1].content;
  const budget = ((activeMeta?.contextSize) || 4096) * 3 * 0.4; // characters we can spend on excerpts
  const k = Math.max(2, Math.min(+settings.docsK || 5, Math.floor(budget / 950)));
  let hits = [];
  try { hits = await api.searchDocs({ ids: c.docs.map((d) => d.id), query: q, k }); } catch (e) { rlog('warn', 'Document search failed: ' + cleanErr(e)); }
  if (!hits.length) return { messages: history, sources: null };
  const excerpts = hits.map((h, i) => `[${i + 1}] (${h.name})\n${h.text}`).join('\n\n');
  const prompt = `Answer the question using the excerpts from the user's documents below. Cite the excerpt numbers like [1] where you use them. If the answer is not in the excerpts, say you could not find it in the documents.\n\n${excerpts}\n\nQuestion: ${q}`;
  return {
    messages: [...history.slice(0, -1), { role: 'user', content: prompt }],
    sources: hits.map((h) => ({ name: h.name, idx: h.idx, text: h.text.length > 420 ? h.text.slice(0, 420) + '…' : h.text })),
  };
}

function buildSources(sources) {
  const d = el('details', 'sources');
  d.innerHTML = `<summary>${ic('file', 13)} ${sources.length} source${sources.length > 1 ? 's' : ''} used</summary>`;
  sources.forEach((s, i) => {
    const row = el('div', 'src');
    row.innerHTML = `<div class="src-h"><b>[${i + 1}]</b> ${esc(s.name)}</div><div class="src-t"></div>`;
    row.querySelector('.src-t').textContent = s.text;
    d.appendChild(row);
  });
  return d;
}

$('attach').onclick = async () => { const p = await api.pickDocs(); if (p.length) attachPaths(p); };
