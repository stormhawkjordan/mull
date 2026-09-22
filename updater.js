/* Notify-only update check. Works with a JSON file ({version, url, notes}) or a GitHub repo ("owner/repo" or a releases URL). */
const cmp = (a, b) => {
  const pa = String(a).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/i, '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) { const d = (pa[i] || 0) - (pb[i] || 0); if (d) return d; }
  return 0;
};

function feedUrl(input) {
  const s = String(input || '').trim();
  if (!s) return null;
  if (/^[\w.-]+\/[\w.-]+$/.test(s)) return `https://api.github.com/repos/${s}/releases/latest`;
  const m = s.match(/github\.com\/([\w.-]+\/[\w.-]+)/i);
  if (m) return `https://api.github.com/repos/${m[1].replace(/\.git$/, '')}/releases/latest`;
  return /^https?:\/\//i.test(s) ? s : null;
}

async function check(input, current) {
  const url = feedUrl(input);
  if (!url) throw new Error('No update source set. Add one in Settings → General → Updates.');
  let r;
  try { r = await fetch(url, { headers: { 'User-Agent': 'Mull', Accept: 'application/json' }, signal: AbortSignal.timeout(15000) }); }
  catch { throw new Error("Couldn't reach the update server."); }
  if (!r.ok) throw new Error(`Update server returned ${r.status}.`);
  const j = await r.json();
  const version = String(j.version || j.tag_name || '').replace(/^v/i, '');
  if (!version) throw new Error('The update source did not include a version.');
  const link = j.url || j.html_url || j.download_url || '';
  return { current, version, available: cmp(version, current) > 0, url: /^https?:\/\//i.test(link) ? link : '', notes: String(j.notes || j.body || '').slice(0, 1500) };
}

module.exports = { check, cmp, feedUrl };
