import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

const MAX_FILE_BYTES = 4096;
const KEY_LINE = /^(?:export )?TYPESAFE_API_KEY=(?:'([A-Za-z0-9._-]{1,512})'|"([A-Za-z0-9._-]{1,512})"|([A-Za-z0-9._-]{1,512}))\n?$/;

/** Read one protected, literal key assignment. Never evaluate shell syntax. */
export function readCredentialFile(path: string): string | null {
  if (!isAbsolute(path) || path.length > 4096 || /[\r\n\0]/.test(path)) return null;
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    const uid = process.getuid?.();
    if (!stat.isFile() || uid === undefined || stat.uid !== uid || (stat.mode & 0o077) !== 0 ||
        stat.size < 1 || stat.size > MAX_FILE_BYTES) return null;
    const buffer = Buffer.alloc(stat.size + 1);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    if (bytes !== stat.size) return null;
    const match = KEY_LINE.exec(buffer.toString('utf8', 0, bytes));
    return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd); } catch { /* No error details or path escape. */ }
    }
  }
}
