export function parseCsv(text) {
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let recordStart = 0;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      record.push(field);
      field = '';
    } else if (char === '\n' || (char === '\r' && text[i + 1] === '\n')) {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      if (char === '\r') i++;
      recordStart = i + 1;
    } else {
      field += char;
    }
  }

  if (quoted) throw new Error('Unterminated quoted field');

  // A separator completes its record; only remaining input starts another.
  if (recordStart < text.length) {
    record.push(field);
    records.push(record);
  }

  return records;
}
