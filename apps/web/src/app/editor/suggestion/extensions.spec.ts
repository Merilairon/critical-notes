import { sanitizeDoc } from '@cn/blocks';
import { filterSlashItems, slashItems } from './extensions';

describe('slash menu', () => {
  it('matches titles and keywords', () => {
    const titles = (q: string) => filterSlashItems(q).map((i) => i.title);
    expect(titles('secret')).toContain('DM secret');
    expect(titles('hidden')).toContain('DM secret');
    expect(titles('npcs')).toEqual(['Query']);
    expect(titles('  CALLOUT ')).toEqual(['Callout']);
    expect(titles('no such block')).toEqual([]);
    expect(filterSlashItems('', 5)).toHaveLength(5);
    // A block's own name wins over keyword matches ("Roll table" has the keyword "encounter")
    expect(titles('encounter')).toEqual(['Encounter', 'Roll table']);
  });

  it('leaves game-master tools out for players', () => {
    const titles = (gm: boolean) => slashItems({ openTemplatePicker: () => undefined, gm: () => gm }).map((i) => i.title);
    expect(titles(true)).toEqual(expect.arrayContaining(['DM secret', 'Encounter', 'Loot', 'Template…']));
    const player = titles(false);
    for (const t of ['DM secret', 'Encounter', 'Loot', 'Template…']) expect(player).not.toContain(t);
    expect(player).toEqual(expect.arrayContaining(['Text', 'Callout', 'Page link', '5etools reference']));
    expect(filterSlashItems('secret', 30, { gm: () => false })).toEqual([]);
  });

  it('inserts only blocks the server-side registry accepts unchanged', () => {
    const blocks = slashItems().filter((i) => i.content);
    expect(blocks.length).toBeGreaterThan(10);
    for (const item of blocks) {
      const { doc, issues } = sanitizeDoc({ type: 'doc', content: [item.content] });
      expect({ block: item.title, issues }).toEqual({ block: item.title, issues: [] });
      expect(doc.content?.[0]?.type).toBe((item.content as { type: string }).type);
    }
  });
});
