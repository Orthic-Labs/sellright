import sharp from 'sharp';
import type { Sharp } from 'sharp';

// Product/gallery originals may be up to 64MP; WebP output owns the per-edge ceiling.
export const ASSET_IMAGE_MAX_PIXELS = 64_000_000;
export const ASSET_IMAGE_MAX_DIMENSION = 16_383;
export const ASSET_IMAGE_MAX_CONCURRENT = 1;
const ALLOWED = new Set(['jpeg', 'png', 'webp', 'avif', 'gif']);
let activeUploads = 0;

export class AssetImageError extends Error {
  constructor(public readonly status: 413 | 415 | 503, message: string) {
    super(message);
  }
}

/** No waiting queue: reject excess upload operations before decoder work. */
export async function withAssetImageSlot<T>(operation: () => Promise<T>): Promise<T> {
  if (activeUploads >= ASSET_IMAGE_MAX_CONCURRENT) throw new AssetImageError(503, 'image processing busy; retry shortly');
  activeUploads += 1;
  try {
    return await operation();
  } finally {
    activeUploads -= 1;
  }
}

function decoderError(error: unknown): AssetImageError {
  // Sharp's input-pixel guard runs while opening the header, before metadata resolves.
  if (error instanceof Error && error.message.includes('Input image exceeds pixel limit')) {
    return new AssetImageError(413, `image exceeds ${ASSET_IMAGE_MAX_PIXELS} decoded pixels`);
  }
  return new AssetImageError(415, 'unsupported format — could not decode image');
}

/** Caller holds an upload slot through this work, persistence & any file cleanup. */
export async function reencodeAssetImage(input: Buffer): Promise<{ data: Buffer; width: number; height: number }> {
  let image: Sharp;
  try { image = sharp(input, { limitInputPixels: ASSET_IMAGE_MAX_PIXELS, failOn: 'warning', pages: 1 }); }
  catch (error) { throw decoderError(error); }
  try {
    let meta;
    try { meta = await image.metadata(); } catch (error) { throw decoderError(error); }
    // Sharp identifies AVIF as HEIF with AV1 compression; HEIC remains unsupported.
    const format = meta.format === 'heif' && meta.compression === 'av1' ? 'avif' : (meta.format ?? '').toLowerCase();
    if (!ALLOWED.has(format)) throw new AssetImageError(415, 'unsupported image format');
    const { width, height } = meta;
    if (!width || !height || !Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
      throw new AssetImageError(415, 'invalid image dimensions');
    }
    if (width > ASSET_IMAGE_MAX_DIMENSION || height > ASSET_IMAGE_MAX_DIMENSION || width * height > ASSET_IMAGE_MAX_PIXELS) {
      throw new AssetImageError(413, `image must be at most ${ASSET_IMAGE_MAX_DIMENSION}px per edge and ${ASSET_IMAGE_MAX_PIXELS} decoded pixels`);
    }
    try {
      // Same WebP normalization & default metadata stripping as the original upload route.
      const data = await image.webp({ quality: 85 }).toBuffer();
      return { data, width, height };
    } catch (error) {
      throw decoderError(error);
    }
  } finally {
    image.destroy();
  }
}
