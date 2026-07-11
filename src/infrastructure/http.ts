export interface FetchOptions {
  timeoutMs: number;
  retries: number;
  headers?: Record<string, string>;
}

export async function fetchText(url: URL | string, options: FetchOptions): Promise<string> {
  const response = await fetchWithRetry(url, options);
  return response.text();
}

export async function fetchJson(url: URL | string, options: FetchOptions): Promise<unknown> {
  const response = await fetchWithRetry(url, options);
  return response.json();
}

async function fetchWithRetry(
  url: URL | string,
  options: FetchOptions,
): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetch(url, {
        ...(options.headers ? { headers: options.headers } : {}),
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (response.ok) return response;
      const body = (await response.text()).slice(0, 500);
      const error = new Error(`HTTP ${response.status} from ${url}: ${body}`);
      if (response.status < 500 && response.status !== 429) throw error;
      lastError = error;
    } catch (error) {
      lastError = error;
    }
    if (attempt < options.retries) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 300 * 2 ** attempt));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}
