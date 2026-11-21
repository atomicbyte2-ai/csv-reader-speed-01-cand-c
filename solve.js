// csv-reader-speed-01, candidate C — record-chunked hybrid.
//
// A faster drop-in for csv-reader 1.0.0: run(input) returns exactly its answer
// {columns, rows, errors} for every {text, header}. Written from the reference's
// documented policy (baselines/csv-reader/vendor/csv-reader/index.js), not copied
// from its code.
//
// Design:
//  1. Record fast path: take one physical line (up to the next LF) as a slice.
//     When no field in it OPENS with a quote (a quote mid-field is literal, so
//     split(',') stays valid) and it holds no stray CR (a trailing CR is only the
//     CRLF terminator), the record is one slice + split(',') — no per-field work.
//  2. Slow path (any field opens with a quote, or a stray CR, or a quoted field
//     spans lines): per-field scanning driven by indexOf, never per character.
//     An unquoted field is one slice once the nearest of ',' / LF is known; a
//     stray CR inside that slice is found by a bounded indexOf on the slice
//     itself (never an unbounded indexOf('\r') over the rest of the file). A
//     quoted field is one slice when it holds no "" and no CR/LF; otherwise it
//     is rebuilt once with split/join, counting its line breaks in the same pass.
//  3. Errors keep the reference's exact attribution: every error's line is the
//     record's start line and its row the record's index in rows (null for the
//     header); stray_cr inside quote junk comes before that field's quote_junk,
//     and unterminated_quote fires before any stray_cr from the re-read.
//
// No dependencies, no I/O, no network, deterministic. All paths resolve from
// this module only; run() keeps nothing from one call to the next.

/** How a field ended: 0 at a comma, 1 at a line break, 2 at the end of the text. */
const COMMA = 0;
const LINE_BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const n = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = text.charCodeAt(0) === 0xfeff ? 1 : 0; // a U+FEFF at the very start is dropped
  let line = 1; // the line the character at pos is on

  // The record being read: the line it starts on and the index in rows it takes.
  let recordLine = 1;
  let recordRow = null;

  // Slots the field readers write: value, how it ended, characters kept (not
  // counting an initial value passed in — that is what quote_junk looks at).
  let fVal = '';
  let fEnd = END;
  let fAdded = 0;

  function err(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // Reads an unquoted field from pos, starting from `init` ('' normally, the
  // quoted value on the junk path, '"' on the unterminated-quote re-read).
  // A CR inside the field is stray unless it is the CRLF terminator's CR.
  function unq(init) {
    const ci = text.indexOf(',', pos);
    const ni = text.indexOf('\n', pos);
    let m;
    let end;
    if (ci === -1) {
      if (ni === -1) { m = n; end = END; } else { m = ni; end = LINE_BREAK; }
    } else if (ni === -1) { m = ci; end = COMMA; }
    else if (ci < ni) { m = ci; end = COMMA; }
    else { m = ni; end = LINE_BREAK; }
    // A CR just before the line break is the CRLF terminator, not part of the field.
    let segEnd = m;
    if (end === LINE_BREAK && m > pos && text.charCodeAt(m - 1) === 13) segEnd = m - 1;
    const seg = text.slice(pos, segEnd);
    let v;
    let added;
    if (seg.indexOf('\r') === -1) {
      v = seg;
      added = segEnd - pos;
    } else {
      // Stray CRs: each is dropped and reported, in order, before anything else
      // this field reports. Any CR here is stray: a CRLF inside the segment
      // would have put its LF before m.
      const pieces = seg.split('\r');
      for (let i = 1; i < pieces.length; i++) err('stray_cr');
      v = pieces.join('');
      added = segEnd - pos - (pieces.length - 1);
    }
    fVal = init === '' ? v : init + v;
    fAdded = added;
    if (end === COMMA) pos = m + 1;
    else if (end === LINE_BREAK) { pos = m + 1; line += 1; }
    else pos = n;
    fEnd = end;
  }

  // Reads a quoted field whose opening quote is at pos.
  function quo() {
    const open = pos;
    const openLine = line;
    let segStart = open + 1;
    let parts = null; // slices + '"' chars from "" pairs seen so far
    let q = open + 1;
    let closed = -1;
    for (;;) {
      q = text.indexOf('"', q);
      if (q === -1) break;
      if (text.charCodeAt(q + 1) === 34) {
        if (parts === null) parts = [text.slice(segStart, q), '"'];
        else { parts.push(text.slice(segStart, q), '"'); }
        q += 2;
        segStart = q;
        continue;
      }
      closed = q;
      break;
    }
    if (closed === -1) {
      // The quote never closes: it is literal, and the text after it is read
      // again as unquoted. The error fires before any stray_cr from the re-read.
      err('unterminated_quote');
      pos = open + 1;
      line = openLine;
      unq('"');
      return;
    }
    const tail = text.slice(segStart, closed);
    let value = parts === null ? tail : parts.join('') + tail;
    if (value.indexOf('\r') !== -1 || value.indexOf('\n') !== -1) {
      // CRLF and lone CR inside quotes each read as one LF, and each counts a line.
      const cr = value.split('\r').length - 1;
      const lf = value.split('\n').length - 1;
      const crlf = cr !== 0 && lf !== 0 ? value.split('\r\n').length - 1 : 0;
      line += cr + lf - crlf;
      value = value.split('\r\n').join('\n').split('\r').join('\n');
    }
    pos = closed + 1;
    if (pos >= n) { fVal = value; fEnd = END; fAdded = 0; return; }
    const c = text.charCodeAt(pos);
    if (c === 44) { pos += 1; fVal = value; fEnd = COMMA; return; }
    if (c === 10) { pos += 1; line += 1; fVal = value; fEnd = LINE_BREAK; return; }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; fVal = value; fEnd = LINE_BREAK; return; }
    // What follows the closing quote is appended as it stands, up to the next
    // comma or line break; quote_junk only when junk characters were kept.
    unq(value);
    if (fAdded > 0) err('quote_junk');
  }

  for (;;) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) { pos += 1; line += 1; }
      else if (c === 13 && text.charCodeAt(pos + 1) === 10) { pos += 2; line += 1; }
      else break;
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // Record fast path: one physical line, no field opening with a quote, no
    // stray CR. A quote mid-field is literal, so split(',') stays valid.
    const le = text.indexOf('\n', pos);
    const lineEnd = le === -1 ? n : le;
    const ls = text.slice(pos, lineEnd);
    let slow = false;
    const r0 = ls.indexOf('\r');
    if (r0 !== -1 && !(le !== -1 && r0 === ls.length - 1)) slow = true;
    if (!slow) {
      let qi = ls.indexOf('"');
      while (qi !== -1) {
        if (qi === 0 || ls.charCodeAt(qi - 1) === 44) { slow = true; break; }
        qi = ls.indexOf('"', qi + 1);
      }
    }

    let fields;
    let lastQuoted = false;
    if (!slow) {
      const end = le !== -1 && ls.length > 0 && ls.charCodeAt(ls.length - 1) === 13
        ? ls.length - 1
        : ls.length;
      fields = ls.slice(0, end).split(',');
      pos = le === -1 ? n : le + 1;
      if (le !== -1) line += 1;
    } else {
      fields = [];
      for (;;) {
        if (text.charCodeAt(pos) === 34) { lastQuoted = true; quo(); }
        else { lastQuoted = false; unq(''); }
        fields.push(fVal);
        if (fEnd !== COMMA) break;
      }
    }

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
