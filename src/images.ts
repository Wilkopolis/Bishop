// Project pictures: validate and downscale in the browser before upload.

export const MAX_PICTURE_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 1600;
const ACCEPTED = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
export const PICTURE_ACCEPT = ACCEPTED.join(',');

export class PictureError extends Error {}

/**
 * Returns the blob to upload. PNG stays PNG (transparency); JPEG/WebP become JPEG;
 * GIF is sent as-is so animation survives. Images within 1600px are only re-encoded
 * when that makes them smaller.
 */
export async function preparePicture(file: File): Promise<Blob> {
  if (!ACCEPTED.includes(file.type)) throw new PictureError('Unsupported picture type. Use PNG, JPEG, WebP or GIF.');
  if (file.size > MAX_PICTURE_BYTES) throw new PictureError(`Picture is too large (${(file.size / 1048576).toFixed(1)} MB); the limit is 20 MB.`);
  if (file.type === 'image/gif') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new PictureError("That picture couldn't be read. It may be damaged.");
  }
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.type !== 'image/webp') {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, type, 0.88));
  if (!blob) throw new PictureError("That picture couldn't be processed.");
  // WebP that's already small: keep whichever is smaller.
  return file.type === 'image/webp' && scale === 1 && file.size <= blob.size ? file : blob;
}

/** First image file in a drop or paste, if any. */
export function imageFromDataTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null;
  for (const item of Array.from(dt.items ?? [])) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) return f;
    }
  }
  return dt.files?.[0] ?? null;
}
