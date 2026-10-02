import type { Dispatcher } from 'undici';
import { promisify } from 'util';
import {
  brotliDecompress,
  brotliDecompressSync,
  gunzip,
  gunzipSync,
  inflate,
  inflateRaw,
  inflateRawSync,
  inflateSync,
} from 'zlib';

/** The slice of a fetch `Response` the JSON-RPC paths read. */
export interface JsonPostResponse {
  ok: boolean;
  status: number;
  headers: { get(name: string): string | null };
  text(): Promise<string>;
}

// Bodies at or under this size are decompressed inline: a threadpool hop costs
// more than inflating a few KB. Larger multicall replies go async so a big
// inflate never blocks the event loop.
const SYNC_DECODE_MAX_BYTES = 64 * 1024;

const gunzipAsync = promisify(gunzip);
const inflateAsync = promisify(inflate);
const inflateRawAsync = promisify(inflateRaw);
const brotliAsync = promisify(brotliDecompress);

/**
 * A transport failure in the shape undici's `fetch` used: `TypeError: fetch
 * failed` with the real error in `cause`. Callers (crypto-ethcall's error
 * classification) match on that shape. A timeout keeps its own error, as it
 * did under fetch: the request rejects with the signal's reason.
 */
function asFetchError(error: unknown, signal: AbortSignal): unknown {
  if (signal.aborted && error === (signal as { reason?: unknown }).reason) {
    return error;
  }
  if (error instanceof TypeError && error.message === 'fetch failed') {
    return error;
  }
  return Object.assign(new TypeError('fetch failed'), { cause: error });
}

function headerValue(
  headers: Dispatcher.ResponseData['headers'],
  name: string
): string | null {
  const value = headers[name.toLowerCase()];
  if (value === undefined) return null;
  return Array.isArray(value) ? value.join(', ') : value;
}

// RFC 9110 "deflate" is zlib-wrapped, but some servers send raw deflate;
// fetch accepts both, so this does too.
function isZlibWrapped(raw: Buffer): boolean {
  return (
    raw.length >= 2 &&
    (raw[0] & 0x0f) === 0x08 &&
    (raw[0] * 256 + raw[1]) % 31 === 0
  );
}

async function decodeOne(raw: Buffer, coding: string): Promise<Buffer> {
  const sync = raw.length <= SYNC_DECODE_MAX_BYTES;
  switch (coding) {
    case 'gzip':
    case 'x-gzip':
      return sync ? gunzipSync(raw) : gunzipAsync(raw);
    case 'deflate':
      if (isZlibWrapped(raw)) {
        return sync ? inflateSync(raw) : inflateAsync(raw);
      }
      return sync ? inflateRawSync(raw) : inflateRawAsync(raw);
    case 'br':
      return sync ? brotliDecompressSync(raw) : brotliAsync(raw);
    default:
      // identity, or a coding we never asked for: hand back the bytes as-is.
      return raw;
  }
}

async function decodeBody(
  raw: Buffer,
  contentEncoding: string | null
): Promise<Buffer> {
  if (!contentEncoding) return raw;
  // Codings are listed in the order they were applied; undo them in reverse.
  const codings = contentEncoding
    .split(',')
    .map((coding) => coding.trim().toLowerCase())
    .filter((coding) => coding.length > 0)
    .reverse();
  let decoded = raw;
  for (const coding of codings) decoded = await decodeOne(decoded, coding);
  return decoded;
}

/**
 * POST a JSON body through an undici dispatcher with `dispatcher.request`
 * rather than `fetch`. Measured from a prod EKS pod on 2026-10-02 against an
 * in-cluster node, fetch's WHATWG Request/Response/stream layer cost ~1 ms
 * per call (13-call multicall, 6 in flight: fetch mean 2.2-2.9 ms, `request`
 * 1.3-1.45 ms). Decompression, which fetch did implicitly, is done here. A
 * non-2xx body is discarded immediately so the connection goes back to the
 * pool; callers never read it.
 */
export async function postJson(
  dispatcher: Dispatcher,
  url: string,
  init: { headers: Record<string, string>; body: string; signal: AbortSignal }
): Promise<JsonPostResponse> {
  const target = new URL(url);
  let response: Dispatcher.ResponseData;
  try {
    response = await dispatcher.request({
      origin: target.origin,
      path: `${target.pathname}${target.search}`,
      method: 'POST',
      headers: init.headers,
      body: init.body,
      signal: init.signal,
    });
  } catch (error) {
    throw asFetchError(error, init.signal);
  }

  const { statusCode, headers, body } = response;
  const ok = statusCode >= 200 && statusCode < 300;
  const get = (name: string): string | null => headerValue(headers, name);

  if (!ok) {
    await body.dump().catch((): undefined => undefined);
    return {
      ok,
      status: statusCode,
      headers: { get },
      text: async (): Promise<string> => '',
    };
  }

  return {
    ok,
    status: statusCode,
    headers: { get },
    text: async (): Promise<string> => {
      let raw: Buffer;
      try {
        raw = Buffer.from(await body.arrayBuffer());
      } catch (error) {
        throw asFetchError(error, init.signal);
      }
      return (await decodeBody(raw, get('content-encoding'))).toString('utf8');
    },
  };
}
