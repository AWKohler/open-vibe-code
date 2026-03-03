interface ProcessOptions {
  maxDimension?: number;
  quality?: number;
  outputType?: 'image/webp' | 'image/jpeg';
}

/**
 * Resize and compress an image file for upload.
 * - Scales down if either dimension exceeds maxDimension (preserving aspect ratio)
 * - Converts to WebP (fallback: JPEG) at the given quality
 * - If the result is larger than the original, returns the original unchanged
 */
export async function processImageForUpload(
  file: File,
  opts: ProcessOptions = {},
): Promise<File> {
  const { maxDimension = 1500, quality = 0.8, outputType = 'image/webp' } = opts;

  return new Promise((resolve) => {
    const objectUrl = URL.createObjectURL(file);
    const img = new Image();

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      let { width, height } = img;

      // Scale down if necessary
      if (width > maxDimension || height > maxDimension) {
        const ratio = Math.min(maxDimension / width, maxDimension / height);
        width = Math.round(width * ratio);
        height = Math.round(height * ratio);
      }

      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        resolve(file);
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);

      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          // If compressed result is larger, keep original
          if (blob.size >= file.size) {
            resolve(file);
            return;
          }
          const ext = outputType === 'image/webp' ? 'webp' : 'jpg';
          const baseName = file.name.replace(/\.[^.]+$/, '');
          resolve(new File([blob], `${baseName}.${ext}`, { type: outputType }));
        },
        outputType,
        quality,
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      resolve(file);
    };

    img.src = objectUrl;
  });
}
