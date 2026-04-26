const POST_FIELDS_BASE = /* groq */ `
  _id,
  title,
  "slug": slug.current,
  excerpt,
  mainImage{
    ...,
    "alt": coalesce(alt, ""),
    asset->{
      _ref,
      _type,
      metadata{ lqip, dimensions }
    }
  },
  // Fall back to titleImage for legacy posts authored under the old schema
  "legacyImage": titleImage{
    ...,
    asset->{ _ref, _type, metadata{ lqip, dimensions } }
  },
  // smallDescription was the legacy field name for excerpt
  "legacyExcerpt": smallDescription,
  publishedAt,
  "updatedAt": coalesce(updatedAt, _updatedAt),
  author->{
    name,
    role,
    twitter,
    avatar{ asset->{ _ref, _type } }
  },
  // Inline author fallback for legacy
  "authorInline": author{
    name, role, twitter,
    avatar{ asset->{ _ref, _type } }
  },
  categories[]->{
    title,
    "slug": slug.current
  },
  readingTime,
  featured
`;

export const allPostsQuery = /* groq */ `
  *[_type == "blog" && !(_id in path("drafts.**"))] | order(coalesce(publishedAt, _createdAt) desc) {
    ${POST_FIELDS_BASE}
  }
`;

export const featuredPostsQuery = /* groq */ `
  *[_type == "blog" && featured == true && !(_id in path("drafts.**"))] | order(coalesce(publishedAt, _createdAt) desc) [0...3] {
    ${POST_FIELDS_BASE}
  }
`;

export const postBySlugQuery = /* groq */ `
  *[_type == "blog" && slug.current == $slug && !(_id in path("drafts.**"))][0] {
    ${POST_FIELDS_BASE},
    body[]{
      ...,
      _type == "image" => {
        ...,
        "alt": coalesce(alt, ""),
        asset->{
          _ref,
          _type,
          metadata{ lqip, dimensions }
        }
      },
      // Legacy posts stored portable text under "content"
      markDefs[]{ ... }
    },
    // Legacy fallback when authors used the old schema field name
    "legacyBody": content,
    seo{
      metaTitle,
      metaDescription,
      noIndex,
      canonicalUrl,
      ogImage{
        ...,
        asset->{ _ref, _type, metadata{ dimensions } }
      }
    }
  }
`;

export const postSlugsQuery = /* groq */ `
  *[_type == "blog" && defined(slug.current) && !(_id in path("drafts.**"))]{
    "slug": slug.current,
    publishedAt,
    "updatedAt": coalesce(updatedAt, _updatedAt)
  }
`;

export const relatedPostsQuery = /* groq */ `
  *[
    _type == "blog"
    && slug.current != $slug
    && !(_id in path("drafts.**"))
    && count(categories[]._ref[@ in $categoryIds]) > 0
  ] | order(coalesce(publishedAt, _createdAt) desc) [0...3] {
    ${POST_FIELDS_BASE}
  }
`;
