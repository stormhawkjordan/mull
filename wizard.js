'use strict';
/* First-run setup guide: check this PC, work out which models it can run, and offer to download one. */

const WIZ_MODELS = [
  { repo: 'unsloth/Qwen3-0.6B-GGUF', title: 'Qwen3 0.6B', blurb: 'Tiny and instant. Fine for quick questions.', tags: ['Fastest', 'Thinks'] },
  { repo: 'bartowski/Llama-3.2-1B-Instruct-GGUF', title: 'Llama 3.2 1B', blurb: 'Small and speedy everyday chat.', tags: ['Fast'] },
  { repo: 'unsloth/Qwen3-1.7B-GGUF', title: 'Qwen3 1.7B', blurb: 'Small model that can reason step by step.', tags: ['Fast', 'Thinks'] },
  { repo: 'bartowski/Llama-3.2-3B-Instruct-GGUF', title: 'Llama 3.2 3B', blurb: 'A solid all-round assistant for most PCs.', tags: ['Balanced'] },
  { repo: 'unsloth/Qwen3-4B-GGUF', title: 'Qwen3 4B', blurb: 'Strong reasoning for its size.', tags: ['Balanced', 'Thinks'] },
  { repo: 'unsloth/gemma-3-4b-it-GGUF', title: 'Gemma 3 4B', blurb: "Google's compact, friendly chat model.", tags: ['Balanced'] },
  { repo: 'bartowski/Phi-3.5-mini-instruct-GGUF', title: 'Phi 3.5 mini', blurb: "Microsoft's small model, good at logic and code.", tags: ['Balanced'] },
  { repo: 'unsloth/Qwen3-8B-GGUF', title: 'Qwen3 8B', blurb: 'Great quality if you have the memory for it.', tags: ['Quality', 'Thinks'] },
  { repo: 'bartowski/Meta-Llama-3.1-8B-Instruct-GGUF', title: 'Llama 3.1 8B', blurb: 'A well-rounded 8B assistant.', tags: ['Quality'] },
  { repo: 'unsloth/gemma-3-12b-it-GGUF', title: 'Gemma 3 12B', blurb: 'Noticeably smarter; needs a stronger PC.', tags: ['Powerful'] },
  { repo: 'unsloth/Qwen3-14B-GGUF', title: 'Qwen3 14B', blurb: 'High quality reasoning and writing.', tags: ['Powerful', 'Thinks'] },
  { repo: 'unsloth/Qwen3-30B-A3B-GGUF', title: 'Qwen3 30B-A3B', blurb: 'Very capable, and quick for its size.', tags: ['Powerful', 'Thinks'] },
];
const WIZ_STEPS = ['Welcome', 'Your PC', 'Models', 'Ready'];
const wiz = { step: 0, specs: null, cap: null, cards: null, loadingCards: false, pick: null, doneModelId: null };

/* How big a model file can this PC run? (weights + ~15% + 0.6 GB for the context.) */
function wizCapacity(sp) {
  const maxFile = (bytes, frac) => Math.max(0, (bytes * frac - 0.6e9) / 1.15);
  const gpu = sp.vramGB ? maxFile(sp.vramGB * 1073741824, 0.92) : 0;   // fits on the graphics card: fast
  const ram = maxFile(sp.ramGB * 1073741824, 0.7);                       // fits in memory: works, but slower
  const fastMax = gpu, slowMax = Math.max(ram, gpu);
  const comfort = gpu > 0 ? Math.max(gpu, Math.min(ram, 3.5e9)) : Math.min(ram, 5e9);   // what feels snappy day to day
  const pickCap = gpu > 0 ? gpu * 0.7 : Math.min(ram * 0.5, 3.5e9);                      // the size we recommend
  const bParams = (b) => Math.max(0, Math.round(b / 1e9 / 0.6)); // roughly 0.6 GB per billion parameters at Q4
  const tier = comfort < 1.5e9 ? ['Light', 'Small models will run well.'] : comfort < 4e9 ? ['Good', 'Small and medium models will run well.']
    : comfort < 8e9 ? ['Great', 'Most everyday models will run well.'] : ['Powerful', 'You can run large, high-quality models.'];
  return { fastMax, slowMax, comfort, pickCap, hasGpu: gpu > 0, fastB: bParams(fastMax), slowB: bParams(slowMax), tier: tier[0], tierText: tier[1] };
}

function openWizard() {
  Object.assign(wiz, { step: 0, specs: null, cap: null, cards: null, pick: null, doneModelId: null, netRelease: null });
  $('wizard').hidden = false; renderWizard();
}
/* The wizard's "Models" step needs Hugging Face to look up sizes and offer downloads. Running the
   wizard at all already implies wanting that, so it turns network access on without asking — then
   turns it back off the moment the person leaves that step (Continue, Back, Skip, or closing). */
function releaseWizNetwork() { wiz.netRelease?.(); wiz.netRelease = null; }
function closeWizard(markDone = true) {
  releaseWizNetwork();
  if (markDone) { store.set('mull.wizardDone', true); api.setPrefs({ wizardDone: true }).then((p) => { prefs = p; }); } // also saved to the config file so it survives a quick quit
  $('wizard').hidden = true;
}

function wizDots() {
  const d = $('wizDots'); d.innerHTML = '';
  WIZ_STEPS.forEach((s, i) => {
    d.appendChild(el('span', 'wd' + (i === wiz.step ? ' on' : i < wiz.step ? ' done' : ''), `<i>${i < wiz.step ? '✓' : i + 1}</i><b>${esc(s)}</b>`));
    if (i < WIZ_STEPS.length - 1) d.appendChild(el('span', 'wline' + (i < wiz.step ? ' done' : '')));
  });
}

function renderWizard() {
  wizDots();
  const body = $('wizBody'); body.innerHTML = '';
  replay(body, 'swap');
  const back = $('wizBack'), next = $('wizNext'), skip = $('wizSkip');
  back.hidden = wiz.step === 0 || wiz.step === 3; skip.hidden = wiz.step === 3;
  next.disabled = false; next.textContent = 'Next';
  if (wiz.step === 0) {
    body.innerHTML = `<div class="wiz-hero"><div class="hero-mark">${ic('mark', 60)}</div><h2>Welcome to Mull</h2>
      <p>Mull runs AI models <b>entirely on your PC</b>. Nothing you type leaves your computer, and it works offline once a model is downloaded.</p>
      <p>This quick guide checks your computer and suggests models that will run well on it. It takes about a minute.</p></div>`;
    next.textContent = 'Check my PC';
  } else if (wiz.step === 1) renderWizScan(body, next);
  else if (wiz.step === 2) renderWizModels(body, next);
  else renderWizDone(body, next);
}

/* ---------- step 1: scan ---------- */
async function renderWizScan(body, next) {
  const rows = [['cpu', 'cpu', 'Processor'], ['ram', 'memory', 'Memory'], ['gpu', 'monitor', 'Graphics'], ['disk', 'drive', 'Storage']];
  body.innerHTML = '<h2>Checking your PC…</h2><div class="scan" id="wizScan"></div><div id="wizVerdict"></div>';
  const box = $('wizScan');
  const els = {};
  for (const [k, icon, label] of rows) {
    const r = el('div', 'scan-row', `<span class="si">${ic(icon, 18)}</span><span class="sl">${label}</span><span class="sv"><span class="spin-s"></span> checking…</span>`);
    box.appendChild(r); els[k] = r.querySelector('.sv');
  }
  next.disabled = true;
  if (!wiz.specs) { try { wiz.specs = await api.specs(); } catch (e) { body.innerHTML = `<div class="errline">Couldn't read your system details: ${esc(cleanErr(e))}</div>`; next.disabled = false; return; } }
  const sp = wiz.specs; wiz.cap = wizCapacity(sp); hf.gpu = { backend: sp.backend, vramGB: sp.vramGB };
  const gpuText = sp.gpus.length ? sp.gpus.join(' · ') : 'No dedicated graphics card found';
  const values = {
    cpu: `${sp.cpu} · ${sp.threads} threads`, ram: `${sp.ramGB} GB installed · ${sp.freeRamGB} GB free`,
    gpu: `${gpuText}${sp.vramGB ? ` · ${sp.vramGB} GB video memory (${sp.backend})` : sp.backend === 'CPU' ? ' · using the processor' : ''}`,
    disk: `${sp.diskFreeGB} GB free where models are saved`,
  };
  for (const [k] of rows) {
    await new Promise((r) => setTimeout(r, settings.animations === false ? 0 : 420));
    if (!$('wizard') || $('wizard').hidden || wiz.step !== 1) return;
    els[k].innerHTML = `<span class="tick">✓</span> ${esc(values[k])}`; els[k].parentElement.classList.add('ok');
  }
  const c = wiz.cap, gbf = (b) => (b / 1e9).toFixed(1);
  const detail = c.hasGpu
    ? `Models up to about <b>${gbf(c.fastMax)} GB</b> (roughly <b>${c.fastB}B parameters</b>) run <b>fast on your graphics card</b>.` + (c.slowMax > c.fastMax * 1.15 ? ` Larger ones, up to about <b>${gbf(c.slowMax)} GB</b>, still work but run on the processor, so they're slower.` : '')
    : `Your PC can run models up to about <b>${gbf(c.slowMax)} GB</b> (roughly <b>${c.slowB}B parameters</b>). They run on your processor, which is slower than a graphics card but works well for chat.`;
  $('wizVerdict').innerHTML = `<div class="verdict ${c.tier.toLowerCase()}"><div class="vt">${esc(c.tier)}</div><div class="vb"><b>${esc(c.tierText)}</b><br>${detail}</div></div>`;
  next.disabled = false; next.textContent = 'See models for my PC';
}

/* ---------- step 2: models ---------- */
async function loadWizCards() {
  wiz.loadingCards = true;
  const results = await Promise.allSettled(WIZ_MODELS.map((m) => api.hfFiles(m.repo)));
  wiz.cards = [];
  results.forEach((r, i) => {
    if (r.status !== 'fulfilled') return;
    const list = r.value.filter((f) => !f.split && !f.projector && f.size);
    const file = list.find((f) => /Q4_K_M\.gguf$/i.test(f.path)) || list.sort((a, b) => a.size - b.size)[0];
    if (file) wiz.cards.push({ ...WIZ_MODELS[i], file, fit: fitOf(file.size) });
  });
  wiz.cards.sort((a, b) => a.file.size - b.file.size);
  const fits = wiz.cards.filter((c) => c.fit?.cls === 'ok' && c.file.size <= wiz.cap.pickCap);
  wiz.pick = fits.length ? fits[fits.length - 1].repo : (wiz.cards.find((c) => c.fit?.cls === 'warn')?.repo || null);
  wiz.loadingCards = false;
}

async function renderWizModels(body, next) {
  body.innerHTML = '<h2>Models that suit your PC</h2><div class="wiz-sub" id="wizSub">Looking up sizes…</div><div id="wizCards" class="wcards"></div>';
  next.textContent = 'Continue'; next.disabled = false;
  if (!wiz.netRelease) wiz.netRelease = await silentNetworkOn();
  if (wiz.step !== 2) return; // the person navigated away while that awaited
  if (!wiz.cards) {
    $('wizCards').innerHTML = '<div class="sys"><span class="spin-s"></span> Checking Hugging Face…</div>';
    await loadWizCards();
    if (wiz.step !== 2) return;
  }
  if (!wiz.cards.length) {
    $('wizSub').textContent = '';
    $('wizCards').innerHTML = '<div class="errline">Couldn\'t reach Hugging Face. Check your internet connection, or import a .gguf file you already have. You can also do this later from Models → Get models.</div>';
    return;
  }
  drawWizCards();
}

function drawWizCards() {
  const box = $('wizCards'); if (!box) return;
  box.innerHTML = '';
  const fitsList = wiz.cards.filter((c) => c.fit?.cls !== 'bad'), tooBig = wiz.cards.filter((c) => c.fit?.cls === 'bad');
  $('wizSub').textContent = wiz.pick ? 'The one marked Recommended is our pick for this PC. Download any of them; you can add more later.' : 'Downloads are optional. You can also import a file you already have.';
  const card = (c) => {
    const key = `${c.repo}/${c.file.path}`, d = dls.get(key);
    const row = el('div', 'wcard' + (c.repo === wiz.pick ? ' pick' : '') + (c.fit?.cls === 'bad' ? ' big' : ''));
    row.innerHTML = `<div class="wc-main"><div class="wc-t">${esc(c.title)}${c.repo === wiz.pick ? '<span class="star">Recommended</span>' : ''}</div>` +
      `<div class="wc-b">${esc(c.blurb)}</div><div class="wc-tags">${c.tags.map((t) => `<span class="tag">${esc(t)}</span>`).join('')}</div></div>` +
      `<div class="wc-side"><div class="wc-s">${fmtSize(c.file.size)}</div><div class="fit ${c.fit?.cls || ''}">${esc(c.fit?.text || '')}</div></div>`;
    const act = el('div', 'wc-act');
    if (c.file.installed || d?.state === 'done') {
      act.innerHTML = '<span class="okline">✓ Downloaded</span>';
      const id = d?.id;
      if (id) { const b = el('button', 'small primary', 'Use it'); b.type = 'button'; b.onclick = () => { wiz.doneModelId = id; wiz.step = 3; renderWizard(); }; act.appendChild(b); }
    } else if (d?.state === 'downloading') {
      const bar = el('div', 'bar thin'); const f = el('div', 'bar-fill'); bar.appendChild(f); bar.dataset.key = key;
      f.style.width = (d.total ? Math.min(100, (d.received / d.total) * 100) : 0) + '%';
      act.appendChild(bar); const t = el('div', 'wc-prog', esc(progressText(d))); t.dataset.key = key; act.appendChild(t);
    } else if (d?.state === 'error') {
      act.innerHTML = `<span class="errline">${esc(d.message || 'Failed')}</span>`;
      const b = el('button', 'small', 'Retry'); b.type = 'button'; b.onclick = () => wizDownload(c); act.appendChild(b);
    } else {
      const b = el('button', 'small' + (c.repo === wiz.pick ? ' primary' : ''), 'Download'); b.type = 'button'; b.onclick = () => wizDownload(c); act.appendChild(b);
    }
    row.appendChild(act); return row;
  };
  fitsList.forEach((c) => box.appendChild(card(c)));
  if (tooBig.length) {
    const det = el('details', 'wtoo'); det.innerHTML = `<summary>${tooBig.length} bigger model${tooBig.length > 1 ? 's' : ''} that won't fit this PC</summary>`;
    tooBig.forEach((c) => det.appendChild(card(c))); box.appendChild(det);
  }
  const more = el('button', 'ghost small', 'Browse all models…'); more.type = 'button';
  more.onclick = () => {
    if (wiz.netRelease) { adoptNetworkHold(wiz.netRelease); wiz.netRelease = null; } // hand the open session to the browser dialog instead of ending it
    closeWizard(); openBrowser();
  };
  box.appendChild(more);
}

async function wizDownload(c) {
  await startDownload(c.repo, { path: c.file.path, size: c.file.size, partial: 0 });
  drawWizCards();
}
api.onDlProgress((p) => {
  if ($('wizard').hidden || wiz.step !== 2) return;
  const bar = document.querySelector(`#wizCards .bar[data-key="${CSS.escape(p.key)}"] .bar-fill`);
  if (bar && p.total) bar.style.width = Math.min(100, (p.received / p.total) * 100) + '%';
  const t = document.querySelector(`#wizCards .wc-prog[data-key="${CSS.escape(p.key)}"]`);
  const d = dls.get(p.key); if (t && d) t.textContent = progressText(d);
});
api.onDlState((ev) => { if (!$('wizard').hidden && wiz.step === 2 && wiz.cards) { const c = wiz.cards.find((x) => `${x.repo}/${x.file.path}` === ev.key); if (c) { if (ev.state === 'done') c.file.installed = true; drawWizCards(); } } });

/* ---------- step 3: done ---------- */
function renderWizDone(body, next) {
  const m = models.find((x) => x.id === wiz.doneModelId) || null;
  const downloading = [...dls.values()].some((d) => d.state === 'downloading');
  body.innerHTML = `<div class="wiz-hero"><div class="bigcheck">${ic('check', 38)}</div><h2>${m ? 'You\'re all set' : 'Setup complete'}</h2>` +
    (m ? `<p><b>${esc(m.name)}</b> is downloaded and ready. Load it and say hello.</p>`
      : downloading ? '<p>Your download keeps going in the background. Find it under <b>Models</b> when it finishes.</p>'
      : '<p>Add a model any time from <b>Models → Get models</b>, or import one you already have.</p>') +
    '<p class="dim">Tip: press <b>Settings → General → Run the setup guide again</b> to see this again.</p></div>';
  next.textContent = m ? 'Start chatting' : 'Finish';
}

$('wizBack').onclick = () => { if (wiz.step > 0) { if (wiz.step === 2) releaseWizNetwork(); wiz.step--; renderWizard(); } };
$('wizNext').onclick = () => {
  if (wiz.step < 3) { if (wiz.step === 2) releaseWizNetwork(); wiz.step++; renderWizard(); return; }
  const id = wiz.doneModelId; closeWizard();
  if (id) { showTab('models'); selectModel(id); }
};
$('wizSkip').onclick = () => {
  closeWizard();
  toast('You can run the setup guide anytime from Settings → General.');
  const btn = $('openSettings'); btn.classList.add('hint-pulse');
  btn.addEventListener('click', () => btn.classList.remove('hint-pulse'), { once: true });
  setTimeout(() => btn.classList.remove('hint-pulse'), 6000);
};
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('wizard').hidden) closeWizard(); });
