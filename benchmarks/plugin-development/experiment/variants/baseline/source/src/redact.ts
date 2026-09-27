// Minimize fields before calling this defense-in-depth redactor. It cannot detect every secret.
export function redactText(value: string, explicitSecrets: string[] = []): string {
  let text = value;
  for (const secret of explicitSecrets) {
    if (secret.length >= 4) text = text.split(secret).join('[REDACTED]');
  }
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[REDACTED PRIVATE KEY]')
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.\-]+/gi, '$1 [REDACTED]')
    .replace(/\b(?:sk-[A-Za-z0-9_-]{12,}|gh[pousr]_[A-Za-z0-9_]{12,}|github_pat_[A-Za-z0-9_]{12,}|AKIA[A-Z0-9]{16})\b/g, '[REDACTED]')
    .replace(/((?:password|passwd|secret|api[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?token|id[_-]?token|\btoken|authorization)\s*["']?\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/gi, '$1[REDACTED]')
    .replace(/((?:[A-Z][A-Z0-9_]*(?:TOKEN|PASSWORD|SECRET|SECRET_ACCESS_KEY|API_KEY|PRIVATE_KEY)|AWS_SESSION_TOKEN)\s*[:=]\s*)(?:"[^"\n]*"|'[^'\n]*'|[^\s,;}]+)/g, '$1[REDACTED]')
    .replace(/(^|\n)((?:set-)?cookie\s*:\s*)[^\r\n]*/gi, '$1$2[REDACTED]')
    .replace(/\bnpm_[A-Za-z0-9]{12,}\b/g, '[REDACTED]')
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[REDACTED]@')
    .replace(/([?&](?:token|key|secret|password|signature|sig|x-amz-signature|x-amz-credential|x-amz-security-token|x-goog-signature|x-goog-credential)=)[^&#\s"']+/gi, '$1[REDACTED]')
    .replace(/\b[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,}\b/g, '[REDACTED JWT]');
}
export function sanitize<T>(value: T, secrets: string[]): T {
  if (typeof value === 'string') return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map(v => sanitize(v, secrets)) as T;
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets), sanitize(item, secrets)])) as T;
  }
  return value;
}
