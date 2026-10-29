export const SENSITIVE_ARGUMENT_KEY = /(?:token|password|secret|authorization|cookie|credential|private[_-]?key|api[_-]?key|base64|file[_-]?uri|download[_-]?url|(?:^|[_-])key$)/i;

export function sanitizeStructuredCandidateMetadata<T>(value: T, redact: (text: string) => string): T {
  if (typeof value === 'string') return redact(value) as T;
  if (Array.isArray(value)) return value.map(item => sanitizeStructuredCandidateMetadata(item, redact)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !SENSITIVE_ARGUMENT_KEY.test(key) && redact(key) === key)
    .map(([key, item]) => [key, sanitizeStructuredCandidateMetadata(item, redact)])) as T;
  return value;
}

export function sanitizeCandidateMetadata(value: unknown, redact: (text: string, maxBytes: number) => string | undefined): Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const entries: Array<[string, string | number | boolean]> = [];
  for (const [key, item] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9_.-]{1,40}$/.test(key) || SENSITIVE_ARGUMENT_KEY.test(key)) continue;
    const safeKey = redact(key, 40);
    if (!safeKey || safeKey !== key || SENSITIVE_ARGUMENT_KEY.test(safeKey)) continue;
    if (typeof item === 'string') entries.push([safeKey, redact(item, 500) ?? '']);
    else if (typeof item === 'number' && Number.isFinite(item) || typeof item === 'boolean') entries.push([safeKey, item]);
    if (entries.length === 16) break;
  }
  return Object.fromEntries(entries);
}
