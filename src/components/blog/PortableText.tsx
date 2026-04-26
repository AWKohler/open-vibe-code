import { PortableText, type PortableTextComponents } from '@portabletext/react';
import type { PortableTextBlock } from '@portabletext/react';
import Image from 'next/image';
import Link from 'next/link';
import { imageUrl } from '@/lib/sanity/image';
import type { SanityImage } from '@/lib/sanity/types';

type CodeBlockValue = {
  language?: string;
  filename?: string;
  code: string;
};

type CalloutValue = {
  tone?: 'info' | 'tip' | 'warning';
  body: string;
};

type LinkAnnotation = {
  href: string;
  newTab?: boolean;
};

const components: PortableTextComponents = {
  types: {
    image: ({ value }: { value: SanityImage }) => {
      const src = imageUrl(value, 1600);
      if (!src) return null;
      const dims = value.asset?.metadata?.dimensions;
      const w = dims?.width ?? 1600;
      const h = dims?.height ?? Math.round(w * 0.6);
      return (
        <figure className="my-10">
          <div className="relative overflow-hidden rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)]">
            <Image
              src={src}
              alt={value.alt ?? ''}
              width={w}
              height={h}
              sizes="(min-width: 768px) 720px, 100vw"
              className="h-auto w-full"
              placeholder={value.asset?.metadata?.lqip ? 'blur' : undefined}
              blurDataURL={value.asset?.metadata?.lqip}
            />
          </div>
          {value.caption ? (
            <figcaption className="mt-3 text-center text-sm italic text-[var(--sand-text-muted)]">
              {value.caption}
            </figcaption>
          ) : null}
        </figure>
      );
    },
    codeBlock: ({ value }: { value: CodeBlockValue }) => (
      <figure className="my-8 overflow-hidden rounded-2xl border border-[var(--sand-border)] bg-[var(--sand-elevated)]">
        {(value.filename || value.language) && (
          <figcaption className="flex items-center justify-between border-b border-[var(--sand-border)] bg-[var(--sand-soft)]/40 px-4 py-2 font-mono text-xs text-[var(--sand-text-muted)]">
            <span>{value.filename ?? ''}</span>
            <span className="uppercase tracking-wider">
              {value.language ?? ''}
            </span>
          </figcaption>
        )}
        <pre className="overflow-x-auto px-4 py-4 font-mono text-sm leading-relaxed text-[var(--sand-text)]">
          <code>{value.code}</code>
        </pre>
      </figure>
    ),
    callout: ({ value }: { value: CalloutValue }) => {
      const toneClass =
        value.tone === 'warning'
          ? 'border-l-[var(--sand-accent)]'
          : value.tone === 'tip'
            ? 'border-l-emerald-600'
            : 'border-l-[var(--sand-text-muted)]';
      return (
        <aside
          className={`my-8 rounded-r-lg border-l-4 bg-[var(--sand-elevated)] px-5 py-4 text-[var(--sand-text)] ${toneClass}`}
        >
          <p className="m-0 whitespace-pre-line text-[0.95rem]">{value.body}</p>
        </aside>
      );
    },
  },
  block: {
    h1: ({ children }) => (
      <h2 className="mb-4 mt-12 text-3xl font-semibold tracking-tight">
        {children}
      </h2>
    ),
    h2: ({ children }) => (
      <h2 className="mb-4 mt-12 text-3xl font-semibold tracking-tight">
        {children}
      </h2>
    ),
    h3: ({ children }) => (
      <h3 className="mb-3 mt-10 text-2xl font-semibold tracking-tight">
        {children}
      </h3>
    ),
    h4: ({ children }) => (
      <h4 className="mb-2 mt-8 text-xl font-semibold tracking-tight">
        {children}
      </h4>
    ),
    blockquote: ({ children }) => (
      <blockquote className="my-8 border-l-2 border-[var(--sand-accent)] pl-5 italic text-[var(--sand-text-muted)]">
        {children}
      </blockquote>
    ),
    normal: ({ children }) => (
      <p className="my-5 text-[1.05rem] leading-[1.75] text-[var(--sand-text)]">
        {children}
      </p>
    ),
  },
  list: {
    bullet: ({ children }) => (
      <ul className="my-5 list-disc space-y-2 pl-6 text-[1.05rem] leading-[1.75] marker:text-[var(--sand-accent)]">
        {children}
      </ul>
    ),
    number: ({ children }) => (
      <ol className="my-5 list-decimal space-y-2 pl-6 text-[1.05rem] leading-[1.75] marker:text-[var(--sand-text-muted)]">
        {children}
      </ol>
    ),
  },
  marks: {
    strong: ({ children }) => (
      <strong className="font-semibold text-[var(--sand-text)]">
        {children}
      </strong>
    ),
    em: ({ children }) => <em className="italic">{children}</em>,
    code: ({ children }) => (
      <code className="rounded bg-[var(--sand-elevated)] px-1.5 py-0.5 font-mono text-[0.9em] text-[var(--sand-accent)]">
        {children}
      </code>
    ),
    underline: ({ children }) => (
      <span className="underline decoration-[var(--sand-accent)] decoration-2 underline-offset-4">
        {children}
      </span>
    ),
    link: ({ value, children }: { value?: LinkAnnotation; children: React.ReactNode }) => {
      if (!value?.href) return <>{children}</>;
      const isInternal = value.href.startsWith('/');
      const newTab = value.newTab && !isInternal;
      const className =
        'underline decoration-[var(--sand-accent)] decoration-1 underline-offset-4 transition hover:text-[var(--sand-accent)]';
      if (isInternal) {
        return (
          <Link href={value.href} className={className}>
            {children}
          </Link>
        );
      }
      return (
        <a
          href={value.href}
          className={className}
          target={newTab ? '_blank' : undefined}
          rel={newTab ? 'noopener noreferrer' : undefined}
        >
          {children}
        </a>
      );
    },
  },
};

export function BlogPortableText({ value }: { value: PortableTextBlock[] }) {
  if (!value || value.length === 0) return null;
  return <PortableText value={value} components={components} />;
}
