export function retryDelay({status,attempt,retryAfter,nowMs}) { return status>=400 ? (Number(retryAfter)*1000 || 1000) : null; }
