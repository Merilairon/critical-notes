import { describe, expect, it } from 'vitest';
import type { BlockDocument, BlockNode } from '@cn/blocks';
import { docToMarkdown, markdownToDoc } from '@cn/blocks/markdown';
import { BUILTIN_TEMPLATES, type BlockTemplateDef, type PageTemplateDef } from '../src';

const content = (def: BlockTemplateDef | PageTemplateDef): BlockNode[] => ('content' in def ? def.content : def.body);

describe('built-in templates as Markdown', () => {
  it.each(BUILTIN_TEMPLATES.map((b) => [b.key, b] as const))('%s reads back unchanged', (_key, builtin) => {
    const base: BlockDocument = { type: 'doc', content: content(builtin.definition) };
    const md = docToMarkdown(base, { mode: 'template' });
    const back = markdownToDoc(md, { mode: 'template', base });
    expect(back.warnings).toEqual([]);
    expect(docToMarkdown(back.doc, { mode: 'template' })).toBe(md);
    // Bindings ({$var}, {$rulesetTag}) and every attribute survive
    expect(JSON.stringify(back.doc.content)).toBe(JSON.stringify(base.content));
  });
});
