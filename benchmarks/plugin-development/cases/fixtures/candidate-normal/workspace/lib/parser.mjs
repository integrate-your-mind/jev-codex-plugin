export function parseRecord(line) {
  const [key, value] = line.replace(/\r?\n$/, '').split('=');
  return {key, value};
}
