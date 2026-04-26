import { v4 as uuid } from 'uuid';

export type AuthoredBlock =
  | { type: 'heading2'; text: string }
  | { type: 'heading3'; text: string }
  | { type: 'paragraph'; text: string };

interface PortableSpan {
  _key: string;
  _type: 'span';
  text: string;
  marks: string[];
}

interface PortableBlock {
  _key: string;
  _type: 'block';
  style: 'normal' | 'h2' | 'h3';
  markDefs: never[];
  children: PortableSpan[];
}

const STYLE: Record<AuthoredBlock['type'], PortableBlock['style']> = {
  heading2: 'h2',
  heading3: 'h3',
  paragraph: 'normal',
};

export function blocksToPortableText(blocks: AuthoredBlock[]): PortableBlock[] {
  return blocks
    .filter((b) => b.text && b.text.trim().length > 0)
    .map((b) => ({
      _key: uuid().replace(/-/g, '').slice(0, 12),
      _type: 'block',
      style: STYLE[b.type],
      markDefs: [],
      children: [
        {
          _key: uuid().replace(/-/g, '').slice(0, 12),
          _type: 'span',
          text: b.text.trim(),
          marks: [],
        },
      ],
    }));
}
