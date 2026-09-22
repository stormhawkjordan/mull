/* Inference engine: owns the llama.cpp instance and the loaded model, and runs chats.
   Shared by the chat window, the local API server and compare mode. Only one generation touches the GPU at a time. */
const os = require('os');

const fmtSize = (b) => (b >= 1e9 ? (b / 1e9).toFixed(2) + ' GB' : (b / 1e6).toFixed(0) + ' MB');

class Engine {
  constructor(hooks) {
    this.hooks = hooks; // { log(level,msg), status(s) }
    this.llama = null;
    this.loaded = null; // { id, name, model, context, sequence }
    this.embedder = null; // { path, model, ctx }
    this._lock = Promise.resolve();
  }

  async instance() {
    if (!this.llama) {
      const { getLlama } = await import('node-llama-cpp');
      this.llama = await getLlama();
      this.hooks.log('info', `Engine ready · backend: ${this.backend()}`);
    }
    return this.llama;
  }
  backend() { return this.llama?.gpu ? String(this.llama.gpu).toUpperCase() : 'CPU'; }

  /* Run fn when no other generation is running. */
  lock(fn) {
    const run = this._lock.then(fn, fn);
    this._lock = run.catch(() => {});
    return run;
  }

  async _open(info, opts, onProgress) {
    const llama = await this.instance();
    const model = await llama.loadModel({ modelPath: info.path, gpuLayers: opts.gpuLayers, useMmap: opts.mmap, onLoadProgress: onProgress });
    const ctxOpts = { contextSize: opts.contextSize };
    if (opts.flashAttention && opts.flashAttention !== 'auto') ctxOpts.flashAttention = opts.flashAttention === 'on';
    if (opts.threads > 0) ctxOpts.threads = opts.threads;
    let context;
    try { context = await model.createContext(ctxOpts); } catch (e) { await model.dispose(); throw e; }
    return { model, context, sequence: context.getSequence() };
  }

  async load(info, opts) {
    const t0 = Date.now(), { log, status } = this.hooks;
    await this.unload();
    log('info', `Loading ${info.name} (${fmtSize(info.size)})`);
    try {
      status({ phase: 'engine', progress: 0, message: 'Starting inference engine…' });
      await this.instance();
      status({ phase: 'model', progress: 0, message: 'Reading model file…' });
      log('info', `Loading weights · GPU layers: ${opts.gpuLayers} · mmap: ${opts.mmap ? 'on' : 'off'}`);
      let lastPct = -1;
      const h = await this._open(info, opts, (p) => {
        status({ phase: 'model', progress: p, message: 'Loading weights into memory…' });
        const pct = Math.floor(p * 10) * 10;
        if (pct !== lastPct) { lastPct = pct; log('debug', `Weights ${pct}%`); }
      });
      status({ phase: 'context', progress: 1, message: 'Creating context…' });
      this.loaded = { id: info.id, name: info.name, ...h };
      const meta = {
        id: info.id, backend: this.backend(), gpuLayers: h.model.gpuLayers, contextSize: h.context.contextSize,
        trainContext: h.model.trainContextSize, arch: h.model.fileInfo?.metadata?.general?.architecture || '',
        loadSeconds: (Date.now() - t0) / 1000,
      };
      log('info', `Ready · context ${meta.contextSize} tokens (model trained on ${meta.trainContext}) · ${meta.loadSeconds.toFixed(1)}s total`);
      status({ phase: 'ready', progress: 1, message: 'Ready' });
      return meta;
    } catch (e) {
      log('error', `Load failed: ${e.message}`);
      status({ phase: 'error', message: e.message });
      throw e;
    }
  }

  async unload() {
    const l = this.loaded; if (!l) return;
    this.loaded = null;
    try { await l.context.dispose(); await l.model.dispose(); this.hooks.log('info', 'Model unloaded'); } catch { /* already gone */ }
  }

  /* A model that lives only for one job (compare mode). */
  async loadTemp(info, opts, onProgress) {
    const h = await this._open(info, opts, onProgress);
    return { ...h, dispose: async () => { try { await h.context.dispose(); await h.model.dispose(); } catch {} } };
  }

  /* One generation on a sequence. onChunk({kind:'text'|'thought', text, n, end}). Returns timing + token counts. */
  async run({ seq, messages, system, gen = {}, thinking, functions, signal, onChunk }) {
    const { LlamaChatSession } = await import('node-llama-cpp');
    const last = messages[messages.length - 1];
    const history = [];
    if (system?.trim()) history.push({ type: 'system', text: system.trim() });
    for (const m of messages.slice(0, -1)) {
      if (m.role === 'user') history.push({ type: 'user', text: m.content });
      else history.push({ type: 'model', response: [m.content] });
    }
    const session = new LlamaChatSession({ contextSequence: seq });
    session.setChatHistory(history);
    const opts = {
      temperature: gen.temperature ?? 0.7, topP: gen.topP, topK: gen.topK, minP: gen.minP,
      repeatPenalty: gen.repeatPenalty > 1 ? { penalty: gen.repeatPenalty } : false,
      maxTokens: gen.maxTokens || undefined,
      seed: gen.seed === '' || gen.seed == null ? undefined : Number(gen.seed),
      signal, stopOnAbortSignal: true,
    };
    if (functions && Object.keys(functions).length) opts.functions = functions;
    if (thinking && thinking.mode !== 'default') {
      opts.budgets = { thoughtTokens: thinking.mode === 'off' ? 0 : thinking.mode === 'limited' ? thinking.budget : Infinity };
    }
    const t0 = Date.now();
    const res = { text: '', tokens: 0, thoughtTokens: 0, ttft: null, seconds: 0, aborted: false, hitLimit: false, budget: opts.budgets?.thoughtTokens, temp: opts.temperature };
    try {
      await session.prompt(last.content, {
        ...opts,
        onResponseChunk: (c) => {
          const n = c.tokens?.length || 0;
          res.tokens += n;
          if (res.ttft == null && (n > 0 || c.text)) res.ttft = (Date.now() - t0) / 1000;
          if (c.type === 'segment' && c.segmentType === 'thought') {
            res.thoughtTokens += n;
            onChunk?.({ kind: 'thought', text: c.text, n, end: !!c.segmentEndTime, start: !!c.segmentStartTime });
          } else {
            res.text += c.text;
            onChunk?.({ kind: 'text', text: c.text, n });
          }
        },
      });
    } finally {
      res.aborted = !!signal?.aborted;
      res.seconds = (Date.now() - t0) / 1000;
      res.hitLimit = !!gen.maxTokens && res.tokens - res.thoughtTokens >= gen.maxTokens;
      res.ctxUsed = seq.nextTokenIndex;
      res.ctxSize = seq.context?.contextSize;
      session.dispose({ disposeSequence: false });
    }
    return res;
  }

  /* Chat on the loaded model (serialised). */
  chat(args) {
    return this.lock(async () => {
      if (!this.loaded) throw new Error('No model loaded');
      const res = await this.run({ ...args, seq: this.loaded.sequence });
      res.ctxSize = this.loaded?.context.contextSize;
      return res;
    });
  }

  /* Embeddings use their own small model, loaded on demand. */
  async embed(modelPath, texts) {
    if (!this.embedder || this.embedder.path !== modelPath) {
      await this.disposeEmbedder();
      const llama = await this.instance();
      const model = await llama.loadModel({ modelPath, gpuLayers: 'auto' });
      this.embedder = { path: modelPath, model, ctx: await model.createEmbeddingContext() };
      this.hooks.log('info', 'Embedding model loaded');
    }
    const out = [];
    for (const t of texts) out.push(Array.from((await this.embedder.ctx.getEmbeddingFor(t)).vector, (x) => +x.toFixed(5)));
    return out;
  }
  async disposeEmbedder() {
    const e = this.embedder; this.embedder = null;
    if (e) { try { await e.ctx.dispose(); await e.model.dispose(); } catch {} }
  }

  /* Read a model's metadata without loading it. */
  async info(file, size) {
    const { readGgufFileInfo } = await import('node-llama-cpp');
    const fi = await readGgufFileInfo(file);
    const g = fi.metadata?.general || {};
    const arch = g.architecture || '';
    const a = fi.metadata?.[arch] || {};
    const tmpl = fi.metadata?.tokenizer?.chat_template || '';
    const out = {
      name: g.name || '', author: g.author || '', license: g.license || '', arch,
      params: g.size_label || '', quant: '', trainContext: a.context_length || 0, layers: a.block_count || 0,
      embedding: a.embedding_length || 0, heads: a.attention?.head_count || 0, vocab: fi.metadata?.tokenizer?.ggml?.tokens?.length || 0,
      hasTemplate: !!tmpl, reasoning: /<think>|enable_thinking/.test(tmpl), tools: /tools|tool_call/.test(tmpl),
      embeddingOnly: /bert|embed/i.test(arch) || (a.pooling_type != null && !tmpl),
      totalParams: 0, sizeBytes: size || 0, estimate: null,
    };
    try { const { GgufFileType } = await import('node-llama-cpp'); out.quant = String(GgufFileType[g.file_type] || '').replace(/^MOSTLY_/, ''); } catch {}
    try {
      const tensors = fi.fullTensorInfo || fi.tensorInfo || [];
      out.totalParams = tensors.reduce((s, t) => s + Number(t.dimensions.reduce((p, d) => p * Number(d), 1)), 0);
    } catch {}
    try {
      const { GgufInsights } = await import('node-llama-cpp');
      const llama = await this.instance();
      const ins = await GgufInsights.from(fi, llama);
      const m = ins.estimateModelResourceRequirements({ gpuLayers: ins.totalLayers });
      const c = ins.estimateContextResourceRequirements({ contextSize: Math.min(8192, out.trainContext || 8192), modelGpuLayers: ins.totalLayers });
      out.estimate = { vram: m.gpuVram + c.gpuVram, ram: m.cpuRam + c.cpuRam };
    } catch { /* estimate is optional */ }
    return out;
  }
}

module.exports = { Engine, fmtSize };
