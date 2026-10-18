import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventEmitter } from 'node:events';

type FakeStream = EventEmitter & { destroyed: boolean; destroy: ReturnType<typeof vi.fn> };
const transport = vi.hoisted(() => ({
  headers: {} as Record<string, string>, chunks: [] as Buffer[], terminal: 'end', statusCode: 200,
  response: null as FakeStream | null, request: null as FakeStream | null, bodyListenersAtStart: -1,
}));
vi.mock('node:http', async original => {
  const actual = await original<typeof import('node:http')>();
  const { EventEmitter } = await import('node:events');
  return { ...actual, request: vi.fn((_url: URL, _options: unknown, receive: (response: unknown) => void) => {
    function stream() {
      const value = Object.assign(new EventEmitter(), { destroyed: false, destroy: vi.fn() });
      value.destroy.mockImplementation(() => {
        if (value.destroyed) return value;
        value.destroyed = true;
        value.emit('error', new Error('destroyed stream'));
        value.emit('close');
        return value;
      });
      return value;
    }
    const req = Object.assign(stream(), { end: vi.fn() });
    transport.request = req;
    req.end.mockImplementation(() => {
      const res = Object.assign(stream(), { headers: transport.headers, statusCode: transport.statusCode, statusMessage: 'OK' });
      transport.response = res;
      receive(res);
      transport.bodyListenersAtStart = res.listenerCount('data');
      for (const chunk of transport.chunks) {
        if (res.destroyed) break;
        res.emit('data', chunk);
      }
      if (!res.destroyed) {
        if (transport.terminal === 'error') res.emit('error', new Error('peer stream failed'));
        else res.emit(transport.terminal);
      }
      if (!res.destroyed) res.emit('close');
      req.emit('close');
      return req;
    });
    return req;
  }) };
});

import { safeOutboundFetch } from './outbound-url.js';

const CAP = 8 * 1024 * 1024;
const framingHeaders: Record<string, string>[] = [{}, { 'transfer-encoding': 'chunked' }, { 'content-length': '1' }];
const fetchResponse = (init: RequestInit = {}) => safeOutboundFetch('http://merchant.example/hook', init, {
  lookup: async () => [{ address: '93.184.216.34', family: 4 }],
});
function expectListenersReleased() {
  for (const event of ['data', 'end', 'aborted', 'error', 'close']) expect(transport.response?.listenerCount(event)).toBe(0);
  for (const event of ['error', 'close']) expect(transport.request?.listenerCount(event)).toBe(0);
}
beforeEach(() => {
  transport.headers = {};
  transport.chunks = [];
  transport.terminal = 'end';
  transport.statusCode = 200;
  transport.response = null;
  transport.request = null;
  transport.bodyListenersAtStart = -1;
});

describe('pinned outbound response buffering', () => {
  it.each([204, 205])('accepts legitimate empty %s responses with a null body', async status => {
    transport.statusCode = status;
    const response = await fetchResponse();
    expect(response.status).toBe(status);
    expect(response.body).toBeNull();
    expect(await response.text()).toBe('');
    expect(transport.response?.destroy).not.toHaveBeenCalled();
    expectListenersReleased();
  });

  it('constructs empty 304 responses before applying existing redirect refusal', async () => {
    transport.statusCode = 304;
    transport.headers = { 'content-length': String(CAP + 1) };
    await expect(fetchResponse()).rejects.toThrow('Outbound redirects are not allowed');
    expect(transport.response?.destroy).not.toHaveBeenCalled();
    expectListenersReleased();
  });

  it('accepts empty HEAD responses with representation content length beyond body cap', async () => {
    transport.headers = { 'content-length': String(CAP + 1) };
    const response = await fetchResponse({ method: 'HEAD' });
    expect(response.status).toBe(200);
    expect(response.body).toBeNull();
    expect(response.headers.get('content-length')).toBe(String(CAP + 1));
    expectListenersReleased();
  });

  it.each([204, 205, 304])('rejects forbidden nonempty bodies on %s responses', async status => {
    transport.statusCode = status;
    transport.chunks = [Buffer.from('forbidden')];
    await expect(fetchResponse()).rejects.toThrow('Outbound response must not contain a body');
    expect(transport.response?.destroy).toHaveBeenCalledOnce();
    expect(transport.request?.destroy).toHaveBeenCalledOnce();
    expectListenersReleased();
  });

  it('rejects forbidden response bytes on HEAD', async () => {
    transport.chunks = [Buffer.from('forbidden')];
    await expect(fetchResponse({ method: 'HEAD' })).rejects.toThrow('Outbound response must not contain a body');
    expectListenersReleased();
  });

  it('preserves ordinary 2xx response bodies below cap', async () => {
    transport.statusCode = 201;
    transport.headers = { 'content-type': 'application/json' };
    transport.chunks = [Buffer.from('{"ok":'), Buffer.from('true}')];
    const response = await fetchResponse();
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expectListenersReleased();
  });

  it('rejects oversized declared length before reading any response bytes', async () => {
    transport.headers = { 'content-length': String(CAP + 1) };
    await expect(fetchResponse()).rejects.toThrow('Outbound response exceeds 8388608 byte limit');
    expect(transport.bodyListenersAtStart).toBe(0);
    expect(transport.response?.destroy).toHaveBeenCalledOnce();
    expect(transport.request?.destroy).toHaveBeenCalledOnce();
    expectListenersReleased();
  });

  it('rejects huge content lengths without numeric precision loss', async () => {
    transport.headers = { 'content-length': '9007199254740993' };
    await expect(fetchResponse()).rejects.toThrow(/byte limit/);
    expectListenersReleased();
  });

  it.each(framingHeaders)('enforces actual streamed bytes with headers %j', async headers => {
    transport.headers = headers;
    transport.chunks = [Buffer.alloc(CAP / 2), Buffer.alloc(CAP / 2), Buffer.from('x')];
    await expect(fetchResponse()).rejects.toThrow(/byte limit/);
    expect(transport.response?.destroy).toHaveBeenCalledOnce();
    expect(transport.request?.destroy).toHaveBeenCalledOnce();
    expectListenersReleased();
  });

  it('accepts exactly the limit & preserves response headers/status/body', async () => {
    transport.headers = { 'content-length': String(CAP), 'content-type': 'application/json' };
    transport.chunks = [Buffer.alloc(CAP / 2, 'a'), Buffer.alloc(CAP / 2, 'b')];
    const response = await fetchResponse();
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body.byteLength).toBe(CAP);
    expect(body[0]).toBe('a'.charCodeAt(0));
    expect(body[CAP - 1]).toBe('b'.charCodeAt(0));
    expect(transport.response?.destroy).not.toHaveBeenCalled();
    expect(transport.request?.destroy).not.toHaveBeenCalled();
    expectListenersReleased();
  });

  it('coalesces tiny & empty chunks without losing bytes across buffer growth', async () => {
    transport.chunks = [Buffer.alloc(0), ...Array.from({ length: 1025 }, () => Buffer.alloc(128, 'x')), Buffer.from('end')];
    const response = await fetchResponse();
    expect(await response.text()).toBe('x'.repeat(1025 * 128) + 'end');
    expectListenersReleased();
  });

  it.each(['aborted', 'error', 'close'])('rejects an incomplete %s response & releases listeners', async terminal => {
    transport.chunks = [Buffer.from('partial')];
    transport.terminal = terminal;
    await expect(fetchResponse()).rejects.toThrow();
    expect(transport.response?.destroy).toHaveBeenCalledOnce();
    expect(transport.request?.destroy).toHaveBeenCalledOnce();
    expectListenersReleased();
  });
});
