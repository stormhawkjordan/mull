/* Tools the model may call. Safe ones run automatically; anything that touches files asks the user first
   and can only see inside the workspace folder the user chose. */
const fs = require('fs');
const path = require('path');

/* ---- calculator: a small recursive-descent parser, no eval ---- */
const FUNCS = {
  sqrt: Math.sqrt, abs: Math.abs, sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan,
  log: Math.log10, ln: Math.log, exp: Math.exp, floor: Math.floor, ceil: Math.ceil, round: Math.round, min: Math.min, max: Math.max, pow: Math.pow,
};
const CONSTS = { pi: Math.PI, e: Math.E };

function calculate(src) {
  const s = String(src).replace(/×/g, '*').replace(/÷/g, '/').replace(/\s+/g, '').toLowerCase();
  if (!s || s.length > 200) throw new Error('Expression is empty or too long');
  const toks = s.match(/\d+\.?\d*(?:e[+-]?\d+)?|\.\d+|[a-z]+|[-+*/^%(),]/g);
  if (!toks || toks.join('') !== s) throw new Error('Unsupported characters in expression');
  let i = 0;
  const peek = () => toks[i];
  const eat = (t) => { if (toks[i] !== t) throw new Error(`Expected "${t}"`); i++; };
  const expr = () => { let v = term(); while (peek() === '+' || peek() === '-') v = toks[i++] === '+' ? v + term() : v - term(); return v; };
  const term = () => { let v = unary(); while (['*', '/', '%'].includes(peek())) { const o = toks[i++]; const r = unary(); v = o === '*' ? v * r : o === '/' ? v / r : v % r; } return v; };
  const unary = () => (peek() === '-' ? (i++, -unary()) : peek() === '+' ? (i++, unary()) : power());
  const power = () => { const b = primary(); if (peek() === '^') { i++; return Math.pow(b, unary()); } return b; };
  const primary = () => {
    const t = toks[i++];
    if (t === undefined) throw new Error('Unexpected end of expression');
    if (/^[\d.]/.test(t)) return parseFloat(t);
    if (t === '(') { const v = expr(); eat(')'); return v; }
    if (/^[a-z]+$/.test(t)) {
      if (peek() === '(') {
        if (!FUNCS[t]) throw new Error(`Unknown function ${t}`);
        i++; const args = [];
        if (peek() !== ')') { args.push(expr()); while (peek() === ',') { i++; args.push(expr()); } }
        eat(')'); return FUNCS[t](...args);
      }
      if (t in CONSTS) return CONSTS[t];
      throw new Error(`Unknown name ${t}`);
    }
    throw new Error(`Unexpected "${t}"`);
  };
  const v = expr();
  if (i !== toks.length) throw new Error(`Unexpected "${toks[i]}"`);
  if (!Number.isFinite(v)) throw new Error('Result is not a finite number');
  return v;
}

/* ---- workspace-confined file access ---- */
function safePath(root, rel) {
  if (!root) throw new Error('No workspace folder is set. Choose one in Settings → Tools & documents.');
  const base = fs.realpathSync(root);
  let target;
  try { target = fs.realpathSync(path.resolve(base, rel || '.')); } catch { throw new Error('File or folder not found'); }
  const r = path.relative(base, target);
  if (r.startsWith('..') || path.isAbsolute(r)) throw new Error('That path is outside the workspace folder');
  return target;
}

const MAX_READ = 200 * 1024;
function listFiles(root, rel) {
  const dir = safePath(root, rel);
  if (!fs.statSync(dir).isDirectory()) throw new Error('Not a folder');
  return fs.readdirSync(dir, { withFileTypes: true }).slice(0, 200)
    .map((e) => (e.isDirectory() ? e.name + '/' : `${e.name} (${fs.statSync(path.join(dir, e.name)).size} bytes)`)).join('\n') || '(empty)';
}
function readFile(root, rel) {
  const file = safePath(root, rel);
  const st = fs.statSync(file);
  if (!st.isFile()) throw new Error('Not a file');
  const buf = fs.readFileSync(file).subarray(0, MAX_READ);
  if (buf.includes(0)) throw new Error('This looks like a binary file, not text');
  return buf.toString('utf8') + (st.size > MAX_READ ? '\n…[truncated]' : '');
}

const short = (s, n = 400) => { s = String(s); return s.length > n ? s.slice(0, n) + '…' : s; };

/* Build the functions object for LlamaChatSession. `ctx` supplies: define, workspace(), ask(req) -> Promise<boolean>, emit(evt). */
function buildTools(ctx) {
  let seq = 0;
  const wrap = (name, needsApproval, fn) => async (args) => {
    const id = `${Date.now()}-${++seq}`;
    ctx.emit({ type: 'tool', id, name, args, status: 'running' });
    try {
      if (needsApproval && !(await ctx.ask({ id, name, args }))) {
        ctx.emit({ type: 'tool', id, name, args, status: 'denied' });
        return 'The user denied this request. Do not retry; explain that you could not access it.';
      }
      const result = await fn(args || {});
      ctx.emit({ type: 'tool', id, name, args, status: 'done', result: short(result) });
      return typeof result === 'string' ? result : JSON.stringify(result);
    } catch (e) {
      ctx.emit({ type: 'tool', id, name, args, status: 'error', result: e.message });
      return `Error: ${e.message}`;
    }
  };
  const str = (description) => ({ type: 'string', description });
  const f = {
    calculator: ctx.define({
      description: 'Evaluate a math expression exactly. Supports + - * / % ^, parentheses, sqrt, sin, cos, tan, log, ln, exp, abs, round, floor, ceil, min, max, pow, pi, e. Use this for any arithmetic instead of calculating yourself.',
      params: { type: 'object', properties: { expression: str('The expression, e.g. "17 * 23 + sqrt(144)"') } },
      handler: wrap('calculator', false, ({ expression }) => String(calculate(expression))),
    }),
    get_datetime: ctx.define({
      description: 'Get the current local date, time and time zone.',
      handler: wrap('get_datetime', false, () => new Date().toString()),
    }),
  };
  if (ctx.workspace()) {
    f.list_files = ctx.define({
      description: 'List files and folders inside the user\'s workspace folder. Ask before use; the user must approve.',
      params: { type: 'object', properties: { path: str('Folder path relative to the workspace, or "." for the top level') } },
      handler: wrap('list_files', true, ({ path: p }) => listFiles(ctx.workspace(), p)),
    });
    f.read_file = ctx.define({
      description: 'Read a text file inside the user\'s workspace folder. The user must approve each read.',
      params: { type: 'object', properties: { path: str('File path relative to the workspace') } },
      handler: wrap('read_file', true, ({ path: p }) => readFile(ctx.workspace(), p)),
    });
  }
  return f;
}

module.exports = { calculate, safePath, listFiles, readFile, buildTools };
