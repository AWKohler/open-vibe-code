import Image from 'next/image';
import Link from 'next/link';
import { imageUrl } from '@/lib/sanity/image';
import type { BlogPostListItem } from '@/lib/sanity/types';

function formatDate(input?: string) {
  if (!input) return null;
  try {
    return new Date(input).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return null;
  }
}

export function PostCard({
  post,
  variant = 'default',
}: {
  post: BlogPostListItem;
  variant?: 'default' | 'featured';
}) {
  const cover = imageUrl(post.mainImage, variant === 'featured' ? 1600 : 900);
  const date = formatDate(post.publishedAt);
  const isFeatured = variant === 'featured';

  return (
    <Link
      href={`/blog/${post.slug}`}
      className="group flex flex-col gap-5"
      aria-label={post.title}
    >
      <div
        className={`relative overflow-hidden rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)] transition-shadow duration-500 group-hover:shadow-[0_24px_60px_-30px_rgba(0,0,0,0.25)] ${
          isFeatured ? 'aspect-[16/9]' : 'aspect-[4/3]'
        }`}
      >
        {cover ? (
          <Image
            src={cover}
            alt={post.mainImage?.alt ?? post.title}
            fill
            sizes={
              isFeatured
                ? '(min-width: 1024px) 75vw, 100vw'
                : '(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw'
            }
            className="object-cover transition-transform duration-700 group-hover:scale-[1.03]"
            placeholder={post.mainImage?.asset?.metadata?.lqip ? 'blur' : undefined}
            blurDataURL={post.mainImage?.asset?.metadata?.lqip}
            priority={isFeatured}
          />
        ) : (
          <div className="absolute inset-0 grid place-items-center text-[var(--sand-text-muted)]">
            <span className="font-serif text-3xl">Botflow</span>
          </div>
        )}
      </div>

      <div className="flex flex-col gap-3">
        {(post.categories?.length || date) && (
          <div className="flex items-center gap-3 text-[11px] font-medium uppercase tracking-[0.18em] text-[var(--sand-text-muted)]">
            {post.categories?.[0]?.title && (
              <span className="text-[var(--sand-accent)]">
                {post.categories[0].title}
              </span>
            )}
            {date && <span>{date}</span>}
            {post.readingTime ? <span>{post.readingTime} min read</span> : null}
          </div>
        )}
        <h3
          className={`text-balance font-medium tracking-tight text-[var(--sand-text)] transition-colors group-hover:text-[var(--sand-accent)] ${
            isFeatured ? 'text-3xl sm:text-4xl' : 'text-xl sm:text-2xl'
          }`}
        >
          {post.title}
        </h3>
        {post.excerpt && (
          <p
            className={`text-[var(--sand-text-muted)] ${
              isFeatured ? 'text-base leading-relaxed' : 'line-clamp-2 text-sm'
            }`}
          >
            {post.excerpt}
          </p>
        )}
      </div>
    </Link>
  );
}
