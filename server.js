/* OpenAI-compatible local API. Listens on 127.0.0.1 only. Off unless the user turns it on. */
const http = require('http');
const crypto = require('crypto');

const MAX_BODY = 8 * 1024 * 1024;

function createApiServer({ engine, listModels, ensureModel, log }) {
  let server = null;
  let state = { running: false, port: 0, error: '' };
  let cfg = { key: '', cors: false };

  const send = (res, code, obj) => { res.writeHead(code, { 'content-type': 'application/json', 'x-content-type-options': 'nosniff' }); res.end(JSON.stringify(obj)); };
  const err = (res, code, message, type = 'invalid_request_error') => send(res, code, { error: { message, type, code } });
  const readBody = (req) => new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (c) => { n += c.length; if (n > MAX_BODY) { reject(new Error('Request body too large')); req.destroy(); } else parts.push(c); });
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')));
    req.on('error', reject);
  });
  const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => (typeof p === 'string' ? p : p?.type === 'text' ? p.text : '')).join('') : '');

  async function chatCompletions(req, res, body) {
    if (!Array.isArray(body.messages) || !body.messages.length) return err(res, 400, '"messages" must be a non-empty array.');
    const msgs = body.messages.map((m) => ({ role: m.role, content: textOf(m.content) }));
    const system = msgs.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    const convo = msgs.filter((m) => m.role === 'user' || m.role === 'assistant');
    if (!convo.length || convo[convo.length - 1].role !== 'user') return err(res, 400, 'The last message must have role "user".');

    try { if (body.model) await ensureModel(body.model); } catch (e) { return err(res, 404, e.message, 'model_not_found'); }
    if (!engine.loaded) return err(res, 503, 'No model is loaded in Mull. Load one in the app (or send a "model" that matches an installed model).', 'no_model');

    const ac = new AbortController();
    res.on('close', () => { if (!res.writableFinished) ac.abort(); });
    const id = 'chatcmpl-' + crypto.randomBytes(8).toString('hex');
    const created = Math.floor(Date.now() / 1000);
    const modelName = engine.loaded.name;
    const gen = { temperature: body.temperature ?? 0.7, topP: body.top_p, maxTokens: body.max_tokens || body.max_completion_tokens || 0, seed: body.seed, repeatPenalty: body.frequency_penalty > 0 ? 1 + Math.min(body.frequency_penalty, 1) * 0.3 : undefined };
    const promptChars = msgs.reduce((a, m) => a + m.content.length, 0);
    log('info', `API request · ${convo.length} message(s)${body.stream ? ' · streaming' : ''}`);

    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-content-type-options': 'nosniff' });
      const chunk = (delta, finish = null) => res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: modelName, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      try {
        const r = await engine.chat({ messages: convo, system, gen, signal: ac.signal, onChunk: (c) => { if (c.text) chunk(c.kind === 'thought' ? { reasoning_content: c.text } : { content: c.text }); } });
        chunk({}, r.hitLimit ? 'length' : 'stop');
      } catch (e) { res.write(`data: ${JSON.stringify({ error: { message: e.message } })}\n\n`); }
      res.write('data: [DONE]\n\n'); res.end();
      return;
    }
    try {
      let reasoning = '';
      const r = await engine.chat({ messages: convo, system, gen, signal: ac.signal, onChunk: (c) => { if (c.kind === 'thought') reasoning += c.text; } });
      const message = { role: 'assistant', content: r.text };
      if (reasoning) message.reasoning_content = reasoning;
      const prompt_tokens = Math.ceil(promptChars / 4);
      send(res, 200, { id, object: 'chat.completion', created, model: modelName, choices: [{ index: 0, message, finish_reason: r.hitLimit ? 'length' : 'stop' }], usage: { prompt_tokens, completion_tokens: r.tokens, total_tokens: prompt_tokens + r.tokens } });
    } catch (e) { if (!res.headersSent) err(res, 500, e.message, 'server_error'); }
  }

  async function handler(req, res) {
    if (cfg.cors) { res.setHeader('access-control-allow-origin', '*'); res.setHeader('access-control-allow-headers', 'authorization, content-type'); res.setHeader('access-control-allow-methods', 'GET, POST, OPTIONS'); }
    if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
    const url = (req.url || '/').split('?')[0].replace(/\/+$/, '') || '/';
    if (cfg.key) {
      const given = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
      const a = Buffer.from(given), b = Buffer.from(cfg.key);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return err(res, 401, 'Invalid or missing API key.', 'invalid_api_key');
    }
    try {
      if (req.method === 'GET' && (url === '/' || url === '/health')) return send(res, 200, { status: 'ok', app: 'Mull', model: engine.loaded?.name || null });
      if (req.method === 'GET' && (url === '/v1/models' || url === '/models')) {
        const loaded = engine.loaded?.id;
        return send(res, 200, { object: 'list', data: listModels().map((m) => ({ id: m.name, object: 'model', created: 0, owned_by: 'local', loaded: m.id === loaded })) });
      }
      if (req.method === 'POST' && (url === '/v1/chat/completions' || url === '/chat/completions')) {
        let body; try { body = JSON.parse(await readBody(req)); } catch (e) { return err(res, 400, e.message === 'Request body too large' ? e.message : 'Body must be valid JSON.'); }
        return await chatCompletions(req, res, body);
      }
      return err(res, 404, `Unknown route ${req.method} ${url}`, 'not_found');
    } catch (e) { if (!res.headersSent) err(res, 500, e.message, 'server_error'); else res.end(); }
  }

  return {
    get state() { return state; },
    async start(port, options = {}) {
      await this.stop();
      cfg = { key: options.key || '', cors: !!options.cors };
      return new Promise((resolve) => {
        const s = http.createServer(handler);
        s.on('error', (e) => { state = { running: false, port, error: e.code === 'EADDRINUSE' ? `Port ${port} is already in use.` : e.message }; server = null; resolve(state); });
        s.listen(port, '127.0.0.1', () => { server = s; state = { running: true, port, error: '' }; log('info', `API server listening on http://127.0.0.1:${port}/v1`); resolve(state); });
      });
    },
    async stop() {
      if (!server) { state = { running: false, port: state.port, error: '' }; return state; }
      await new Promise((r) => { server.close(() => r()); server.closeAllConnections?.(); });
      server = null; state = { running: false, port: state.port, error: '' }; log('info', 'API server stopped');
      return state;
    },
  };
}

module.exports = { createApiServer };
