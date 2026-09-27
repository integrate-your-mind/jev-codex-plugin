const httpDate = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), \d{2} (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) \d{4} \d{2}:\d{2}:\d{2} GMT|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), \d{2}-(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-\d{2} \d{2}:\d{2}:\d{2} GMT|(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (?: \d|\d{2}) \d{2}:\d{2}:\d{2} \d{4})$/;

export function retryDelay({ status, attempt, retryAfter, nowMs }) {
  if (![429, 502, 503, 504].includes(status) || attempt >= 3) return null;

  const fallback = 1000 * 2 ** attempt;
  const header = typeof retryAfter === 'string'
    ? retryAfter.trim()
    : typeof retryAfter === 'number' && Number.isInteger(retryAfter) && retryAfter >= 0
      ? String(retryAfter)
      : '';

  let delay;
  if (/^\d+$/.test(header)) {
    delay = Number(header) * 1000;
  } else if (httpDate.test(header) && Number.isFinite(nowMs)) {
    // The obsolete asctime format has no timezone; HTTP dates are always UTC.
    const timestamp = Date.parse(header.endsWith('GMT') ? header : `${header} GMT`);
    if (!Number.isFinite(timestamp)) return fallback;
    delay = timestamp - nowMs;
  } else {
    return fallback;
  }

  return Math.min(10000, Math.max(0, delay));
}
