export function retryDelay({ status, attempt, retryAfter, nowMs }) {
  if (![429, 502, 503, 504].includes(status) || attempt >= 3) return null;

  const fallback = 1000 * 2 ** attempt;
  const header = typeof retryAfter === 'string'
    ? retryAfter.trim()
    : typeof retryAfter === 'number' ? String(retryAfter) : '';
  const clamp = (delay) => Math.min(10000, Math.max(0, delay));

  if (/^\d+$/.test(header)) return clamp(Number(header) * 1000);

  // Accept HTTP-date formats, without Date.parse's permissive numeric parsing.
  const day = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const time = '\\d{2}:\\d{2}:\\d{2}';
  const httpDate = new RegExp(
    `^(?:${day}, \\d{2} ${month} \\d{4} ${time} GMT|` +
    `(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${time} GMT|` +
    `${day} ${month} (?: \\d|\\d{2}) ${time} \\d{4})$`
  );
  if (httpDate.test(header)) {
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp) && Number.isFinite(nowMs)) {
      return clamp(timestamp - nowMs);
    }
  }

  return fallback;
}
