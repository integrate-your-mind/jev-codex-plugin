export function retryDelay({ status, attempt, retryAfter, nowMs }) {
  if (![429, 502, 503, 504].includes(status) || attempt >= 3) {
    return null;
  }

  const fallback = 1000 * 2 ** attempt;
  if (typeof retryAfter !== 'string' && typeof retryAfter !== 'number') {
    return fallback;
  }

  const header = String(retryAfter).trim();
  if (/^\d+$/.test(header)) {
    return Math.min(10000, Number(header) * 1000);
  }

  // Accept HTTP date formats, without Date.parse's permissive numeric parsing.
  const weekday = '(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)';
  const month = '(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)';
  const time = '\\d{2}:\\d{2}:\\d{2}';
  const httpDate = new RegExp(
    `^(?:${weekday}, \\d{2} ${month} \\d{4} ${time} GMT|` +
    `(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \\d{2}-${month}-\\d{2} ${time} GMT|` +
    `${weekday} ${month} (?: \\d|\\d{2}) ${time} \\d{4})$`
  );
  if (httpDate.test(header)) {
    const delay = Date.parse(header) - (nowMs ?? Date.now());
    if (Number.isFinite(delay)) {
      return Math.max(0, Math.min(10000, delay));
    }
  }

  return fallback;
}
