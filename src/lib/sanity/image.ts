import {
  createImageUrlBuilder,
  type SanityImageSource,
} from '@sanity/image-url';
import { sanityClient } from './client';

const builder = createImageUrlBuilder(sanityClient);

function hasUsableRef(source: SanityImageSource | undefined | null): boolean {
  if (!source) return false;
  if (typeof source === 'string') return source.length > 0;
  const ref =
    (source as { _ref?: string })._ref ??
    (source as { asset?: { _ref?: string; _id?: string } }).asset?._ref ??
    (source as { asset?: { _ref?: string; _id?: string } }).asset?._id;
  return typeof ref === 'string' && ref.length > 0;
}

export function urlForImage(source: SanityImageSource | undefined | null) {
  if (!hasUsableRef(source)) return null;
  return builder.image(source!).auto('format').fit('max');
}

export function imageUrl(
  source: SanityImageSource | undefined | null,
  width?: number,
  height?: number,
): string | null {
  const u = urlForImage(source);
  if (!u) return null;
  try {
    let b = u;
    if (width) b = b.width(width);
    if (height) b = b.height(height);
    return b.url();
  } catch {
    return null;
  }
}
