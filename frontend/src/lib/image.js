const MAX_DIMENSION = 2000;
const JPEG_QUALITY = 0.85;

/**
 * Shrinks a camera photo before upload. Phone cameras produce 4-12 MB images;
 * 2000px on the long side keeps handwriting legible while cutting the upload to
 * a few hundred KB, which matters on a slow mobile connection.
 *
 * Falls back to the original file if the browser can't decode it (for example
 * HEIC in a browser without HEIC support); the server checks the type anyway.
 */
export async function shrinkImage(file) {
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));

    if (scale === 1 && file.type === 'image/jpeg' && file.size < 1.5 * 1024 * 1024) {
      bitmap.close();
      return file;
    }

    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY));
    if (!blob) return file;

    return new File([blob], file.name.replace(/\.\w+$/, '') + '.jpg', { type: 'image/jpeg' });
  } catch {
    return file;
  }
}
