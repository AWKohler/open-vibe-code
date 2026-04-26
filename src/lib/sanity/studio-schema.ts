/**
 * Sanity Studio schema definitions for the blog. These are NOT loaded by the
 * Next.js app at runtime — Sanity content is queried via GROQ. This file is
 * here as a single source of truth that can be copy-pasted into the hosted
 * Sanity Studio (sanity.studio) when authoring or updating the schema.
 *
 * Paste the exports below into the Studio's schemas/ directory and register
 * them in `schemaTypes/index.ts`.
 */

export const blogPostSchema = {
  name: 'blog',
  title: 'Blog Post',
  type: 'document',
  groups: [
    { name: 'content', title: 'Content', default: true },
    { name: 'meta', title: 'Meta' },
    { name: 'seo', title: 'SEO' },
  ],
  fields: [
    {
      name: 'title',
      title: 'Title',
      type: 'string',
      group: 'content',
      validation: (Rule: { required: () => unknown; max: (n: number) => unknown }) =>
        (Rule.required() as { max: (n: number) => unknown }).max(120),
    },
    {
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      group: 'content',
      options: { source: 'title', maxLength: 96 },
      validation: (Rule: { required: () => unknown }) => Rule.required(),
    },
    {
      name: 'excerpt',
      title: 'Excerpt',
      description:
        'Shown on the index, in social previews, and used as the meta description fallback.',
      type: 'text',
      rows: 3,
      group: 'content',
      validation: (Rule: { max: (n: number) => unknown }) => Rule.max(200),
    },
    {
      name: 'mainImage',
      title: 'Main image',
      type: 'image',
      group: 'content',
      options: { hotspot: true },
      fields: [
        { name: 'alt', title: 'Alt text', type: 'string' },
        { name: 'caption', title: 'Caption', type: 'string' },
      ],
    },
    {
      name: 'publishedAt',
      title: 'Published at',
      type: 'datetime',
      group: 'meta',
      validation: (Rule: { required: () => unknown }) => Rule.required(),
    },
    {
      name: 'updatedAt',
      title: 'Last updated',
      type: 'datetime',
      group: 'meta',
    },
    {
      name: 'author',
      title: 'Author',
      type: 'object',
      group: 'meta',
      fields: [
        { name: 'name', title: 'Name', type: 'string' },
        { name: 'role', title: 'Role', type: 'string' },
        { name: 'twitter', title: 'Twitter handle (no @)', type: 'string' },
        {
          name: 'avatar',
          title: 'Avatar',
          type: 'image',
          options: { hotspot: true },
        },
      ],
    },
    {
      name: 'categories',
      title: 'Categories',
      type: 'array',
      group: 'meta',
      of: [{ type: 'reference', to: [{ type: 'category' }] }],
    },
    {
      name: 'readingTime',
      title: 'Reading time (minutes, optional override)',
      type: 'number',
      group: 'meta',
    },
    {
      name: 'featured',
      title: 'Featured post',
      type: 'boolean',
      group: 'meta',
      initialValue: false,
    },
    {
      name: 'body',
      title: 'Body',
      type: 'array',
      group: 'content',
      of: [
        {
          type: 'block',
          marks: {
            decorators: [
              { title: 'Strong', value: 'strong' },
              { title: 'Emphasis', value: 'em' },
              { title: 'Code', value: 'code' },
              { title: 'Underline', value: 'underline' },
            ],
            annotations: [
              {
                name: 'link',
                type: 'object',
                title: 'Link',
                fields: [
                  { name: 'href', type: 'url', title: 'URL' },
                  { name: 'newTab', type: 'boolean', title: 'Open in new tab' },
                ],
              },
            ],
          },
        },
        {
          type: 'image',
          name: 'image',
          options: { hotspot: true },
          fields: [
            { name: 'alt', title: 'Alt text', type: 'string' },
            { name: 'caption', title: 'Caption', type: 'string' },
          ],
        },
        {
          type: 'object',
          name: 'codeBlock',
          title: 'Code block',
          fields: [
            { name: 'language', title: 'Language', type: 'string' },
            { name: 'filename', title: 'Filename', type: 'string' },
            { name: 'code', title: 'Code', type: 'text', rows: 12 },
          ],
        },
        {
          type: 'object',
          name: 'callout',
          title: 'Callout',
          fields: [
            {
              name: 'tone',
              title: 'Tone',
              type: 'string',
              options: { list: ['info', 'tip', 'warning'] },
              initialValue: 'info',
            },
            { name: 'body', title: 'Body', type: 'text', rows: 4 },
          ],
        },
      ],
    },
    {
      name: 'seo',
      title: 'SEO',
      type: 'object',
      group: 'seo',
      fields: [
        { name: 'metaTitle', title: 'Meta title', type: 'string' },
        { name: 'metaDescription', title: 'Meta description', type: 'text' },
        {
          name: 'ogImage',
          title: 'Social share image (1200×630)',
          type: 'image',
        },
        { name: 'noIndex', title: 'Hide from search engines', type: 'boolean' },
        { name: 'canonicalUrl', title: 'Canonical URL', type: 'url' },
      ],
    },
  ],
  preview: {
    select: { title: 'title', media: 'mainImage', date: 'publishedAt' },
    prepare({
      title,
      media,
      date,
    }: {
      title?: string;
      media?: unknown;
      date?: string;
    }) {
      return {
        title: title ?? 'Untitled',
        subtitle: date ? new Date(date).toLocaleDateString() : 'Unpublished',
        media,
      };
    },
  },
};

export const categorySchema = {
  name: 'category',
  title: 'Category',
  type: 'document',
  fields: [
    {
      name: 'title',
      title: 'Title',
      type: 'string',
      validation: (Rule: { required: () => unknown }) => Rule.required(),
    },
    {
      name: 'slug',
      title: 'Slug',
      type: 'slug',
      options: { source: 'title' },
    },
    { name: 'description', title: 'Description', type: 'text' },
  ],
};
