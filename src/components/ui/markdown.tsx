'use client';

import React from 'react';


function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  let remaining = text;
  let key = 0;

  const patterns: [RegExp, (m: RegExpExecArray) => React.ReactNode][] = [
    [/`([^`]+)`/, (m) => <code key={`${keyPrefix}-code-${key++}`} className="px-1 py-0.5 rounded bg-elevated border border-border text-[0.95em] [overflow-wrap:anywhere]">{m[1]}</code>],
    [/\*\*([^*]+)\*\*/, (m) => <strong key={`${keyPrefix}-b-${key++}`}>{m[1]}</strong>],
    [/\*([^*]+)\*/, (m) => <em key={`${keyPrefix}-i-${key++}`}>{m[1]}</em>],
    [/\[([^\]]+)\]\(([^)]+)\)/, (m) => <a key={`${keyPrefix}-a-${key++}`} href={m[2]} target="_blank" rel="noreferrer" className="underline text-accent">{m[1]}</a>],
  ];

  while (remaining.length) {
    let earliest: { idx: number; match: RegExpExecArray; render: (m: RegExpExecArray) => React.ReactNode } | null = null;
    for (const [re, render] of patterns) {
      const m = re.exec(remaining);
      if (m && (earliest === null || m.index < earliest.idx)) earliest = { idx: m.index, match: m, render };
    }
    if (!earliest) {
      nodes.push(remaining);
      break;
    }
    if (earliest.idx > 0) nodes.push(remaining.slice(0, earliest.idx));
    nodes.push(earliest.render(earliest.match));
    remaining = remaining.slice(earliest.idx + earliest.match[0].length);
  }
  return nodes;
}

export function Markdown({ content }: { content: string }) {
  const lines = content.replaceAll('\r\n', '\n').split('\n');
  const out: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];
    // Code fences
    const fence = line.match(/^```(?:\s*(\w+))?\s*$/);
    if (fence) {
      const lang = fence[1] || '';
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) {
        code.push(lines[i]);
        i++;
      }
      // skip closing fence
      if (i < lines.length) i++;
      out.push(
        <pre key={`pre-${key++}`} className="text-xs overflow-auto bg-elevated p-3 rounded border border-border">
          <code className={`language-${lang}`}>{code.join('\n')}</code>
        </pre>
      );
      continue;
    }

    // Headings
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      const Tag = `h${level}` as 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6';
      out.push(<Tag key={`h-${key++}`} className="font-semibold mt-3 mb-1">{renderInline(heading[2], `h${key}`)}</Tag>);
      i++;
      continue;
    }

    // Unordered lists
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ''));
        i++;
      }
      out.push(
        <ul key={`ul-${key++}`} className="list-disc pl-5 my-2 space-y-1">
          {items.map((txt, idx) => (
            <li key={`li-${key}-${idx}`}>{renderInline(txt, `li-${key}-${idx}`)}</li>
          ))}
        </ul>
      );
      continue;
    }

    // Blank line -> spacing
    if (/^\s*$/.test(line)) {
      out.push(<div key={`sp-${key++}`} className="h-2" />);
      i++;
      continue;
    }

    // Paragraph
    const paras: string[] = [line];
    i++;
    while (i < lines.length && !/^\s*$/.test(lines[i])) {
      paras.push(lines[i]);
      i++;
    }
    out.push(
      <p key={`p-${key++}`} className="leading-relaxed">
        {renderInline(paras.join(' '), `p-${key}`)}
      </p>
    );
  }

  // `overflow-wrap: anywhere` (vs the weaker `break-word`) also shrinks the
  // element's intrinsic min-content width, so a long unbreakable token — a
  // UUID, hash, or a bolded id like **xxxx-xxxx** the browser treats as one
  // word — wraps instead of forcing the bubble wide and triggering a
  // horizontal scrollbar. min-w-0 lets it shrink inside flex/timeline parents.
  return <div className="space-y-2 min-w-0 [overflow-wrap:anywhere]">{out}</div>;
}
