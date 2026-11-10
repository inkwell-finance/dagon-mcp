/** Every gateway and Solana RPC request is bounded by this deadline in addition to client cancellation. */
export const REQUEST_TIMEOUT_MS = 30_000;

/** Combines an optional caller signal with a request deadline. */
export const deadline = (signal: AbortSignal | undefined, timeoutMs = REQUEST_TIMEOUT_MS): AbortSignal =>
  signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);

/** Reads a response body as JSON, refusing bodies larger than `maxBytes` without buffering them. Non-JSON yields null. */
export async function readJsonCapped(res: Response, maxBytes: number): Promise<unknown> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await res.body?.cancel().catch(() => {});
    throw new Error(`response exceeds ${maxBytes} bytes`);
  }
  if (!res.body) return null;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => {});
      throw new Error(`response exceeds ${maxBytes} bytes`);
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    return null;
  }
}

const LOOPBACK_HOST = /^(localhost|.+\.localhost|127\.\d+\.\d+\.\d+|\[::1\])$/;

/** Validates a configured base URL: https, or http only on loopback, so bearer keys never travel in cleartext. */
export function checkedHttpsUrl(name: string, raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${name} must be an absolute https:// URL.`);
  }
  const loopback = LOOPBACK_HOST.test(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${name} must use https:// (plain http:// is allowed only for localhost).`);
  }
  if (url.username || url.password || url.search || url.hash) throw new Error(`${name} must not contain credentials, a query, or a fragment.`);
  return raw.replace(/\/+$/, "");
}
