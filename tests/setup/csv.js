/**
 * A strict RFC 4180 reader for export tests. Throws on a bare quote inside
 * an unquoted field or text after a closing quote, which lenient readers
 * would silently accept.
 */
function parseCSV(text) {
  const rows = [];
  let row = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    let field = '';
    if (text[i] === '"') {
      i++;
      for (;;) {
        if (i >= n) throw new Error('unterminated quoted field');
        if (text[i] === '"') {
          if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
          i++;
          break;
        }
        field += text[i++];
      }
      if (i < n && text[i] !== ',' && text[i] !== '\r') {
        throw new Error(`text after closing quote at ${i}`);
      }
    } else {
      while (i < n && text[i] !== ',' && text[i] !== '\r' && text[i] !== '\n') {
        if (text[i] === '"') throw new Error(`quote in unquoted field at ${i}`);
        field += text[i++];
      }
      if (text[i] === '\n') throw new Error(`bare LF at ${i}`);
    }
    row.push(field);
    if (text[i] === ',') { i++; continue; }
    if (text[i] === '\r') {
      if (text[i + 1] !== '\n') throw new Error(`bare CR at ${i}`);
      i += 2;
    }
    rows.push(row);
    row = [];
  }
  return rows;
}

module.exports = { parseCSV };
