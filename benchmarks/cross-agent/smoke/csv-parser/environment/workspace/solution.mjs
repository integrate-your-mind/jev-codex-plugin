export function parseCsv(text) { return text.split('\n').map(line=>line.split(',')); }
