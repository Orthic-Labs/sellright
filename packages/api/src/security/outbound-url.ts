import { lookup as dnsLookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest, type IncomingMessage } from 'node:http';
import { request as httpsRequest } from 'node:https';

interface LookupAddress {
  address: string;
  family: number;
}

export type OutboundUrlLookup = (hostname: string) => Promise<LookupAddress[]>;
type ConnectLookup = (hostname: string, options: unknown, callback: (err: Error | null, address: string, family: number) => void) => void;
type SafeOutboundRequest = (
  url: URL,
  init: RequestInit,
  connect: { lookup: ConnectLookup; address: string; family: number; servername: string },
) => Promise<Response>;

interface CheckedOutboundUrl {
  url: URL;
  address: string;
  family: number;
}

export interface SafeOutboundFetchOptions {
  lookup?: OutboundUrlLookup;
  request?: SafeOutboundRequest;
}

// Callers consume JSON or webhook acknowledgements, including Listmonk's
// paginated lists & campaign HTML response. Never buffer an unbounded peer body.
const MAX_OUTBOUND_RESPONSE_BYTES = 8 * 1024 * 1024;

const PRIVATE_HOSTNAMES = new Set([
  'localhost',
  'localhost.localdomain',
  'ip6-localhost',
  'ip6-loopback',
]);

async function defaultLookup(hostname: string): Promise<LookupAddress[]> {
  return dnsLookup(hostname, { all: true, verbatim: true });
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .replace(/^\[(.*)]$/, '$1')
    .replace(/\.$/, '')
    .toLowerCase();
}

function isPrivateHostname(hostname: string): boolean {
  return PRIVATE_HOSTNAMES.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local');
}

function isBlockedIpv4(address: string): boolean {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;

  const [a = -1, b = -1, c = -1] = parts;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function ipv4ToBytes(address: string): number[] | null {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return parts;
}

function parseIpv6Hextets(part: string): number[] | null {
  if (!part) return [];
  const segments = part.split(':');
  const out: number[] = [];
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]!;
    if (!segment) return null;
    if (segment.includes('.')) {
      if (i !== segments.length - 1) return null;
      const bytes = ipv4ToBytes(segment);
      if (!bytes) return null;
      out.push((bytes[0]! << 8) | bytes[1]!, (bytes[2]! << 8) | bytes[3]!);
      continue;
    }
    if (!/^[0-9a-f]{1,4}$/i.test(segment)) return null;
    out.push(Number.parseInt(segment, 16));
  }
  return out;
}

function parseIpv6ToBytes(address: string): number[] | null {
  const zoneIndex = address.indexOf('%');
  if (zoneIndex >= 0) return null;
  const pieces = address.toLowerCase().split('::');
  if (pieces.length > 2) return null;

  const head = parseIpv6Hextets(pieces[0] ?? '');
  const tail = parseIpv6Hextets(pieces[1] ?? '');
  if (!head || !tail) return null;

  let hextets: number[];
  if (pieces.length === 2) {
    const zeros = 8 - head.length - tail.length;
    if (zeros < 1) return null;
    hextets = [...head, ...Array(zeros).fill(0), ...tail];
  } else {
    hextets = head;
  }
  if (hextets.length !== 8) return null;

  const bytes: number[] = [];
  for (const hextet of hextets) {
    bytes.push((hextet >> 8) & 0xff, hextet & 0xff);
  }
  return bytes;
}

function mappedIpv4(bytes: number[]): string | null {
  const firstTenZero = bytes.slice(0, 10).every((b) => b === 0);
  if (firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff) {
    return bytes.slice(12, 16).join('.');
  }
  return null;
}

function allZero(bytes: number[]): boolean {
  return bytes.every((b) => b === 0);
}

function isBlockedIpv6(address: string): boolean {
  const bytes = parseIpv6ToBytes(address);
  if (!bytes) return true;

  const mapped = mappedIpv4(bytes);
  if (mapped) return isBlockedIpv4(mapped);

  const isLoopback = bytes.slice(0, 15).every((b) => b === 0) && bytes[15] === 1;
  if (allZero(bytes) || isLoopback) return true;

  return (
    (bytes[0]! & 0xfe) === 0xfc || // unique local fc00::/7
    (bytes[0] === 0xfe && (bytes[1]! & 0xc0) === 0x80) || // link-local fe80::/10
    bytes[0] === 0xff || // multicast
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8) || // docs 2001:db8::/32
    (bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00) || // Teredo 2001::/32
    (bytes[0] === 0x20 && bytes[1] === 0x02) || // 6to4 2002::/16
    (bytes[0] === 0x00 && bytes[1] === 0x64 && bytes[2] === 0xff && bytes[3] === 0x9b) || // NAT64 WKP
    (bytes[0] === 0x01 && bytes.slice(1, 8).every((b) => b === 0)) // discard-only 100::/64
  );
}

export function isPrivateOrSpecialAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const version = isIP(normalized);
  if (version === 4) return isBlockedIpv4(normalized);
  if (version === 6) return isBlockedIpv6(normalized);
  return true;
}

async function checkOutboundUrl(rawUrl: string, opts: { lookup?: OutboundUrlLookup } = {}): Promise<CheckedOutboundUrl> {
  if (typeof rawUrl !== 'string' || rawUrl.trim() === '') throw new Error('Outbound URL is required');
  if (rawUrl.length > 2048) throw new Error('Outbound URL is too long');

  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Outbound URL must be absolute');
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Outbound URL must use http or https');
  if (url.username || url.password) throw new Error('Outbound URL must not include credentials');

  const hostname = normalizeHostname(url.hostname);
  if (!hostname || isPrivateHostname(hostname)) throw new Error('Outbound URL must not target private network hosts');
  if (isIP(hostname)) {
    if (isPrivateOrSpecialAddress(hostname)) throw new Error('Outbound URL must not target private network hosts');
    url.hash = '';
    return { url, address: hostname, family: isIP(hostname) };
  }

  const lookup = opts.lookup ?? defaultLookup;
  const records = await lookup(hostname);
  if (!records.length) throw new Error('Outbound URL host could not be resolved');
  if (records.some((record) => isPrivateOrSpecialAddress(record.address))) {
    throw new Error('Outbound URL must not resolve to private network addresses');
  }

  url.hash = '';
  return { url, address: records[0]!.address, family: records[0]!.family };
}

export async function assertSafeOutboundUrl(rawUrl: string, opts: { lookup?: OutboundUrlLookup } = {}): Promise<string> {
  const checked = await checkOutboundUrl(rawUrl, opts);
  return checked.url.toString();
}

function headersToRecord(headers?: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => { out[key] = value; });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) out[key] = value;
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

function bodyForNode(body: RequestInit['body'] | null | undefined): string | Buffer | Uint8Array | undefined {
  if (body == null) return undefined;
  if (typeof body === 'string' || Buffer.isBuffer(body) || body instanceof Uint8Array) return body;
  if (body instanceof URLSearchParams) return body.toString();
  throw new Error('Unsupported outbound request body type');
}

async function nodeRequestWithPinnedLookup(
  url: URL,
  init: RequestInit,
  connect: { lookup: ConnectLookup; servername: string },
): Promise<Response> {
  const request = url.protocol === 'https:' ? httpsRequest : httpRequest;
  const body = bodyForNode(init.body);
  const headers = headersToRecord(init.headers);

  return await new Promise<Response>((resolve, reject) => {
    let responseBody = Buffer.alloc(0);
    let receivedBytes = 0;
    let settled = false;
    let bodyless = false;
    let response: IncomingMessage | undefined;
    const detachBodyListeners = () => {
      response?.off('data', onData);
      response?.off('end', onEnd);
      response?.off('aborted', onAborted);
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      responseBody = Buffer.alloc(0);
      detachBodyListeners();
      // Error listeners stay until close to consume errors emitted by destroy.
      // Destruction carries no peer-provided error or response body.
      response?.destroy();
      req.destroy();
      reject(error);
    };
    const onData = (chunk: Buffer | string) => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
      if (bodyless && bytes > 0) {
        fail(new Error('Outbound response must not contain a body'));
        return;
      }
      if (bytes > MAX_OUTBOUND_RESPONSE_BYTES - receivedBytes) {
        fail(new Error('Outbound response exceeds 8388608 byte limit'));
        return;
      }
      if (bytes === 0) return;
      const nextSize = receivedBytes + bytes;
      if (responseBody.length < nextSize) {
        // Coalesce tiny chunks too: retained memory & per-chunk object overhead
        // stay bounded rather than accumulating millions of small Buffers.
        const capacity = Math.min(MAX_OUTBOUND_RESPONSE_BYTES, Math.max(64 * 1024, nextSize, responseBody.length * 2));
        const grown = Buffer.allocUnsafe(capacity);
        responseBody.copy(grown, 0, 0, receivedBytes);
        responseBody = grown;
      }
      (Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)).copy(responseBody, receivedBytes);
      receivedBytes = nextSize;
    };
    const onAborted = () => fail(new Error('Outbound response aborted'));
    const onResponseError = (error: Error) => fail(error);
    const onRequestError = (error: Error) => fail(error);
    const onEnd = () => {
      if (settled || !response) return;
      try {
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(response.headers)) {
          if (Array.isArray(value)) {
            for (const item of value) responseHeaders.append(key, item);
          } else if (value != null) {
            responseHeaders.set(key, String(value));
          }
        }
        const result = new Response(bodyless ? null : responseBody.subarray(0, receivedBytes), {
          status: response.statusCode ?? 0,
          statusText: response.statusMessage,
          headers: responseHeaders,
        });
        settled = true;
        responseBody = Buffer.alloc(0);
        detachBodyListeners();
        resolve(result);
      } catch (error) { fail(error instanceof Error ? error : new Error('Invalid outbound response')); }
    };
    const req = request(url, {
      method: init.method ?? 'GET',
      headers,
      lookup: connect.lookup,
      servername: connect.servername,
      signal: init.signal as AbortSignal | undefined,
    }, (res) => {
      response = res;
      res.on('error', onResponseError);
      res.once('close', () => {
        if (!settled) fail(new Error('Outbound response closed before completion'));
        detachBodyListeners();
        res.off('error', onResponseError);
      });
      if (settled) { res.destroy(); return; }
      bodyless = (init.method ?? 'GET').toUpperCase() === 'HEAD' || [204, 205, 304].includes(res.statusCode ?? 0);
      const declaredLength = res.headers['content-length']?.trim();
      // HEAD & 304 may describe a representation larger than their absent body.
      if (!bodyless && typeof declaredLength === 'string' && /^\d+$/.test(declaredLength) && BigInt(declaredLength) > BigInt(MAX_OUTBOUND_RESPONSE_BYTES)) {
        fail(new Error('Outbound response exceeds 8388608 byte limit'));
        return;
      }
      res.on('data', onData);
      res.once('end', onEnd);
      res.once('aborted', onAborted);
    });
    req.on('error', onRequestError);
    req.once('close', () => req.off('error', onRequestError));
    try { req.end(body); }
    catch (error) { fail(error instanceof Error ? error : new Error('Outbound request failed')); }
  });
}

function pinnedLookup(address: string, family: number): ConnectLookup {
  return (_hostname, _options, callback) => callback(null, address, family);
}

export async function safeOutboundFetch(
  rawUrl: string,
  init: RequestInit = {},
  opts: SafeOutboundFetchOptions = {},
): Promise<Response> {
  const checked = await checkOutboundUrl(rawUrl, opts);
  const request = opts.request ?? nodeRequestWithPinnedLookup;
  const response = await request(checked.url, init, {
    lookup: pinnedLookup(checked.address, checked.family),
    address: checked.address,
    family: checked.family,
    servername: normalizeHostname(checked.url.hostname),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) throw new Error('Outbound redirects are not allowed');
    await checkOutboundUrl(new URL(location, checked.url).toString(), opts);
    throw new Error('Outbound redirects are not allowed');
  }

  return response;
}
