'use strict';
/* Voice: read replies aloud (Windows voices) and dictate with an offline speech model (whisper). */

/* ---------------- Read aloud ---------------- */
let speakingMsg = null;
const synth = window.speechSynthesis;

function speechText(content) {
  const d = document.createElement('div'); d.innerHTML = md(content);
  d.querySelectorAll('.code, .katex').forEach((n) => n.replaceWith(document.createTextNode(' ')));
  return d.textContent.replace(/\s+/g, ' ').trim();
}
function speechChunks(text) {
  const parts = text.match(/[^.!?\n]+[.!?]*\s*/g) || [text];
  const out = []; let cur = '';
  for (const p of parts) { if ((cur + p).length > 220 && cur) { out.push(cur); cur = ''; } cur += p; }
  if (cur.trim()) out.push(cur);
  return out;
}
function stopSpeaking() { if (synth) synth.cancel(); speakingMsg = null; refreshSpeakButtons(); }
function speak(content, m) {
  if (!synth) return;
  synth.cancel();
  const text = speechText(content); if (!text) return;
  const voice = synth.getVoices().find((v) => v.name === settings.speakVoice);
  const chunks = speechChunks(text);
  speakingMsg = m || null;
  chunks.forEach((c, i) => {
    const u = new SpeechSynthesisUtterance(c);
    if (voice) u.voice = voice;
    u.rate = +settings.speakRate || 1;
    if (i === chunks.length - 1) { u.onend = u.onerror = () => { speakingMsg = null; refreshSpeakButtons(); }; }
    synth.speak(u);
  });
  refreshSpeakButtons();
}
function speakButton(m) {
  const b = el('button', 'speak-btn'); b.type = 'button';
  b.dataset.mid = String(m.thought?.length || 0) + ':' + m.content.length;
  b._m = m;
  const upd = () => { b.innerHTML = speakingMsg === m ? ic('square', 12) + ' Stop reading' : ic('volume', 13) + ' Read aloud'; };
  b._upd = upd; upd();
  b.onclick = () => { if (speakingMsg === m) stopSpeaking(); else speak(m.content, m); };
  return b;
}
function refreshSpeakButtons() { document.querySelectorAll('.speak-btn').forEach((b) => b._upd?.()); }

/* ---------------- Dictation ---------------- */
const speech = { ready: false, model: '', progress: '', busyDl: false };
const SPEECH_SIZES = { 'ggml-tiny.en.bin': 77704715, 'ggml-base.en.bin': 147964211, 'ggml-small.en.bin': 487614201, 'ggml-base.bin': 147951465 };
const speechKey = () => `ggerganov/whisper.cpp/${prefs.speechModel}`;

async function refreshSpeech() {
  try { const s = await api.voiceStatus(); speech.ready = s.ready; speech.model = s.model; } catch { /* ignore */ }
  if (!$('settings').hidden && sTab === 'voice') renderSettings();
}
function speechStatusText() {
  if (speech.busyDl) return `Downloading speech model… ${speech.progress}`;
  return speech.ready ? `✓ Speech model ready (${prefs.speechModel}). Dictation runs entirely on this PC.` : `Speech model not downloaded yet (${prefs.speechModel}). Dictation needs it once.`;
}
async function downloadSpeechModel() {
  if (speech.busyDl) return;
  speech.busyDl = true; speech.progress = ''; if (!$('settings').hidden) renderSettings();
  const name = prefs.speechModel;
  await startDownload('ggerganov/whisper.cpp', { path: name, size: SPEECH_SIZES[name], partial: 0 });
}
api.onDlProgress((p) => {
  if (!speech.busyDl || p.key !== speechKey()) return;
  speech.progress = p.total ? `${Math.round((p.received / p.total) * 100)}% (${fmtSize(p.received)} of ${fmtSize(p.total)})` : fmtSize(p.received);
  if (!$('settings').hidden && sTab === 'voice') { const i = document.querySelector('#sBody .info'); if (i) i.textContent = speechStatusText(); }
});
api.onDlState((ev) => {
  if (ev.key !== speechKey() || !speech.busyDl) return;
  if (ev.state === 'done' || ev.state === 'error' || ev.state === 'paused' || ev.state === 'cancelled') {
    speech.busyDl = false;
    if (ev.state === 'done') { toast('Speech model ready. Click the microphone button to dictate'); dls.delete(ev.key); renderPanel(); }
    else if (ev.state === 'error') toast('Speech model download failed: ' + ev.message);
    refreshSpeech();
  }
});

const rec = { on: false, stream: null, ctx: null, node: null, chunks: [], rate: 16000 };

/* float samples at any rate -> 16 kHz mono 16-bit PCM */
function toPcm16k(float, rate) {
  const n = Math.floor(float.length * 16000 / rate), out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    const pos = i * rate / 16000, i0 = Math.floor(pos), i1 = Math.min(i0 + 1, float.length - 1), f = pos - i0;
    const v = float[i0] * (1 - f) + float[i1] * f;
    out[i] = Math.max(-1, Math.min(1, v)) * 32767;
  }
  return out;
}
async function transcribePcm(int16) {
  const text = await api.transcribe(int16.buffer.slice(int16.byteOffset, int16.byteOffset + int16.byteLength));
  return text;
}
function insertDictation(text) {
  if (!text) return toast("Didn't catch anything. Try again a little closer to the mic");
  const inp = $('input'); inp.value = (inp.value && !/\s$/.test(inp.value) ? inp.value + ' ' : inp.value) + text;
  inp.dispatchEvent(new Event('input')); inp.focus();
}

async function toggleMic() {
  const btn = $('mic');
  if (rec.on) {
    rec.on = false; btn.classList.remove('rec');
    rec.node.disconnect(); rec.stream.getTracks().forEach((t) => t.stop()); await rec.ctx.close();
    const total = rec.chunks.reduce((a, c) => a + c.length, 0);
    if (total < rec.rate * 0.4) { toast('Too short. Hold on a bit longer'); return; }
    const all = new Float32Array(total); let o = 0; for (const c of rec.chunks) { all.set(c, o); o += c.length; }
    btn.classList.add('busy'); btn.title = 'Transcribing…'; setActivity('Transcribing…');
    try { insertDictation(await transcribePcm(toPcm16k(all, rec.rate))); }
    catch (e) { toast(/SPEECH_MODEL_MISSING/.test(e.message) ? 'Download the speech model first (Settings → Voice)' : 'Dictation failed: ' + cleanErr(e)); }
    btn.classList.remove('busy'); btn.title = 'Dictate (works offline)'; setActivity(activeId ? 'Ready' : 'Load a model to begin.');
    return;
  }
  if (!speech.ready) {
    if (confirm(`Dictation needs a small speech model (about ${prefs.speechModel === 'ggml-tiny.en.bin' ? '75' : '140+'} MB), downloaded once. Download it now?`)) { downloadSpeechModel(); toast('Downloading speech model…'); }
    return;
  }
  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch { return toast('Microphone access was blocked or no microphone was found'); }
  rec.ctx = new AudioContext(); rec.rate = rec.ctx.sampleRate; rec.chunks = [];
  const src = rec.ctx.createMediaStreamSource(rec.stream);
  rec.node = rec.ctx.createScriptProcessor(4096, 1, 1);
  rec.node.onaudioprocess = (e) => { rec.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0))); };
  src.connect(rec.node); rec.node.connect(rec.ctx.destination);
  rec.on = true; btn.classList.add('rec'); btn.title = 'Stop and transcribe';
  setActivity('Listening… click the microphone again when you are done');
}

$('mic').onclick = toggleMic;
