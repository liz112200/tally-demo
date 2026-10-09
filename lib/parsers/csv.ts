// A small RFC 4180 CSV tokenizer. Hand-rolled rather than a dependency: the
// three bank exports have known, simple shapes, and owning ~50 lines beats
// pulling in a parser we don't control. Reach for a library only if a bank ever
// emits embedded newlines inside quoted fields (none do today; this parser
// handles them anyway).
//
// One tokenizer path for every line, header included: detect.ts compares a
// parser's expected header against parseCsv(file)[0], so the header is
// normalized exactly as a data row would be. There is deliberately no separate
// header parser that could diverge from this one.
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Tracks whether the current record has produced any content, so a trailing
  // newline at end-of-file does not emit a phantom empty row.
  let sawContent = false;

  for (let i = 0; i < text.length; i++) {
    const c = text[i];

    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          // Escaped quote inside a quoted field.
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += c;
      }
      continue;
    }

    if (c === '"') {
      inQuotes = true;
      sawContent = true;
    } else if (c === ',') {
      row.push(field);
      field = '';
      sawContent = true;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      sawContent = false;
    } else if (c === '\r') {
      // Swallow CR; the following LF (or EOF) ends the record.
    } else {
      field += c;
      sawContent = true;
    }
  }

  // Flush a final record that was not newline-terminated.
  if (sawContent || field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}
