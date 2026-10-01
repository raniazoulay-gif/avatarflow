/** fetch with a hard timeout; throws on network errors, timeouts and non-2xx. */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export type FetchFn = typeof fetch;

export async function fetchJson<T>(
  url: string,
  init: RequestInit & { timeoutMs: number; fetchFn?: FetchFn },
): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), init.timeoutMs);
  try {
    const res = await (init.fetchFn ?? fetch)(url, { ...init, signal: ctrl.signal });
    if (!res.ok) throw new HttpError(res.status, `HTTP ${res.status} from ${new URL(url).host}`);
    return (await res.json()) as T;
  } finally {
    clearTimeout(timer);
  }
}

/** Serialises calls so they are at least `minIntervalMs` apart (public API etiquette). */
export class MinIntervalGate {
  private last = 0;
  private chain: Promise<void> = Promise.resolve();
  constructor(private readonly minIntervalMs: number) {}
  run<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.chain.then(async () => {
      const wait = this.last + this.minIntervalMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
    });
    this.chain = p.catch(() => undefined);
    return p.then(fn);
  }
}
