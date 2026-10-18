import { describe, expect, it, vi } from 'vitest';
import sharp from 'sharp';
import { ASSET_IMAGE_MAX_DIMENSION, ASSET_IMAGE_MAX_PIXELS, reencodeAssetImage, withAssetImageSlot } from './asset-image.js';

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

async function pngHeader(width: number, height: number): Promise<Buffer> {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: 'white' } }).png().toBuffer();
  png.writeUInt32BE(width, 16);
  png.writeUInt32BE(height, 20);
  png.writeUInt32BE(crc32(png.subarray(12, 29)), 29);
  return png;
}

describe('bounded asset image decoding', () => {
  it.each(['jpeg', 'png', 'webp', 'avif', 'gif'] as const)('reencodes supported %s input with the real decoder', async (format) => {
    const input = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } }).toFormat(format).toBuffer();
    const result = await withAssetImageSlot(() => reencodeAssetImage(input));
    expect(result).toMatchObject({ width: 4, height: 3 });
    expect(await sharp(result.data).metadata()).toMatchObject({ format: 'webp', width: 4, height: 3 });
  });

  it('strips original metadata during WebP normalization', async () => {
    const input = await sharp({ create: { width: 4, height: 3, channels: 3, background: 'white' } })
      .withExif({ IFD0: { Artist: 'Synthetic image fixture' } }).jpeg().toBuffer();
    expect((await sharp(input).metadata()).exif).toBeDefined();
    const result = await withAssetImageSlot(() => reencodeAssetImage(input));
    expect((await sharp(result.data).metadata()).exif).toBeUndefined();
  });

  it('rejects a tiny real PNG with an oversized decoded-pixel header before decoding pixels', async () => {
    const input = await pngHeader(8001, 8000);
    expect(input.byteLength).toBeLessThan(1024);
    expect(8001 * 8000).toBeGreaterThan(ASSET_IMAGE_MAX_PIXELS);
    // This is a real, decoder-readable header; its advertised pixel data is never allocated.
    expect(await sharp(input, { limitInputPixels: false }).metadata()).toMatchObject({ width: 8001, height: 8000 });
    await expect(withAssetImageSlot(() => reencodeAssetImage(input))).rejects.toMatchObject({ status: 413 });
  });

  it.each([
    { width: ASSET_IMAGE_MAX_DIMENSION + 1, height: 1 },
    { width: 1, height: ASSET_IMAGE_MAX_DIMENSION + 1 },
  ])('rejects an overlong edge even below the pixel ceiling ($width x $height)', async ({ width, height }) => {
    const input = await pngHeader(width, height);
    await expect(withAssetImageSlot(() => reencodeAssetImage(input))).rejects.toMatchObject({ status: 413 });
  });

  it('rejects a busy slot immediately without running or queuing another operation', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const held = withAssetImageSlot(() => gate);
    const next = vi.fn(async () => 'queued');
    try {
      await expect(withAssetImageSlot(next)).rejects.toMatchObject({ status: 503 });
      expect(next).not.toHaveBeenCalled();
    } finally {
      release();
      await held;
    }
    await expect(withAssetImageSlot(async () => 'available')).resolves.toBe('available');
    expect(next).not.toHaveBeenCalled();
  });

  it.each([Buffer.alloc(0), Buffer.from('invalid image')])('releases its slot after decoder rejection', async (input) => {
    await expect(withAssetImageSlot(() => reencodeAssetImage(input))).rejects.toMatchObject({ status: 415 });
    await expect(withAssetImageSlot(async () => 'released')).resolves.toBe('released');
  });

  it('rejects corrupt pixel data after a valid header & releases its slot', async () => {
    const input = await pngHeader(4, 3);
    expect(await sharp(input).metadata()).toMatchObject({ width: 4, height: 3 });
    await expect(withAssetImageSlot(() => reencodeAssetImage(input))).rejects.toMatchObject({ status: 415 });
    await expect(withAssetImageSlot(async () => 'released')).resolves.toBe('released');
  });

  it('holds its slot through failure cleanup & releases it even when cleanup fails', async () => {
    let cleanupStarted!: () => void;
    let releaseCleanup!: () => void;
    const started = new Promise<void>((resolve) => { cleanupStarted = resolve; });
    const cleanup = new Promise<void>((resolve) => { releaseCleanup = resolve; });
    const failure = new Error('synthetic cleanup failure');
    const held = withAssetImageSlot(async () => {
      try { throw new Error('synthetic persistence failure'); }
      finally {
        cleanupStarted();
        await cleanup;
        throw failure;
      }
    });
    const rejected = expect(held).rejects.toBe(failure);
    await started;
    try {
      await expect(withAssetImageSlot(async () => 'blocked')).rejects.toMatchObject({ status: 503 });
    } finally {
      releaseCleanup();
      await rejected;
    }
    await expect(withAssetImageSlot(async () => 'released')).resolves.toBe('released');
  });
});
