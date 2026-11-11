// Strips a saved Amazon page down to markup the corpus can keep: no scripts,
// no frames, no inline handlers, and no session or tracking tokens. A meta
// refresh is kept (with its token scrubbed) because it marks a bot interstitial.

const TOKEN_PARAMS = [
  'dib', 'dib_tag', 'qid', 'crid', 'sprefix', 'bm-verify', 'session-id',
  'pf_rd_r', 'pf_rd_p', 'pf_rd_s', 'pf_rd_t', 'pf_rd_i', 'pf_rd_m',
  'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'content-id', 'aref', 'sp_csd', 'spc',
];

export function sanitizeHtml(html) {
  let out = html;
  out = out.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '');
  out = out.replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript\s*>/gi, '');
  out = out.replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe\s*>/gi, '');
  out = out.replace(/<iframe\b[^>]*\/?>/gi, '');
  out = out.replace(/<link\b[^>]*rel\s*=\s*["']?(?:preconnect|dns-prefetch|prefetch|preload)[^>]*>/gi, '');
  out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*')/gi, '');
  out = out.replace(/(["'\s])javascript:[^"']*/gi, '$1#');

  // Query-string tokens, in plain and entity-encoded URLs.
  for (const p of TOKEN_PARAMS) {
    const re = new RegExp(`([?&;]|&amp;)${p.replace(/[-]/g, '\\-')}=[^&"'\\s<>#]*`, 'gi');
    out = out.replace(re, `$1${p}=x`);
  }
  // Tokens in attributes and inline JSON.
  out = out.replace(/(name\s*=\s*["'][^"']*(?:csrf|token|session)[^"']*["'][^>]*?value\s*=\s*)("[^"]*"|'[^']*')/gi, '$1""');
  out = out.replace(/(value\s*=\s*)("[^"]*"|'[^']*')([^>]*?name\s*=\s*["'][^"']*(?:csrf|token|session)[^"']*["'])/gi, '$1""$3');
  out = out.replace(/(<meta\b[^>]*name\s*=\s*["'][^"']*(?:csrf|token|session)[^"']*["'][^>]*?content\s*=\s*)("[^"]*"|'[^']*')/gi, '$1""');
  out = out.replace(/(csrf[a-z]*\s*=\s*)("[^"]*"|'[^']*')/gi, '$1""');
  out = out.replace(/((?:csrf|session|token)[a-z0-9-]*&quot;\s*:\s*&quot;)[^&]*(&quot;)/gi, '$1x$2');
  out = out.replace(/((?:csrf|session|token)[a-z0-9-]*"\s*:\s*")[^"]*(")/gi, '$1x$2');
  out = out.replace(/\b\d{3}-\d{7}-\d{7}\b/g, '000-0000000-0000000'); // session and order ids
  return out;
}

/** Returns a short list of things that still look like tokens, for review. */
export function leftoverTokens(html) {
  const found = [];
  if (/<script\b/i.test(html)) found.push('script tag');
  if (/bm-verify=(?!x\b)/i.test(html)) found.push('bm-verify');
  if (/[?&;]session-id=(?!x\b)/i.test(html)) found.push('session-id');
  if (/\b\d{3}-\d{7}-\d{7}\b/.test(html.replace(/000-0000000-0000000/g, ''))) found.push('session-like id');
  return found;
}
