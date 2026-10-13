/**
 * TipTap node definitions for the app's custom blocks. Names match the block registry in @cn/blocks; the
 * server validates and projects the same JSON.
 */
import type { Injector } from '@angular/core';
import { mergeAttributes, Node } from '@tiptap/core';
import { AngularNodeViewRenderer } from 'ngx-tiptap';
import { CalloutView, SecretView, TabView, TemplateInstanceView } from '../views/container-views';
import { GalleryView, ImageView, PageEmbedView, QueryView, RefEmbedView, StatGridView, UnknownView } from '../views/atom-views';
import { PageLinkView, PlaceholderView, TagView } from '../views/inline-views';
import { EncounterBlockView, LootBlockView } from '../../play/block-views';
import { jsonAttr, stringAttr } from './attributes';

const tagged = (tag: string, name: string) => [{ tag: `${tag}[data-type="${name}"]` }];

export function customNodes(injector: Injector) {
  const view = (component: Parameters<typeof AngularNodeViewRenderer>[0]) => AngularNodeViewRenderer(component, { injector });

  const container = (name: string, opts: { className: string; attrs?: Record<string, unknown>; nodeView?: Parameters<typeof AngularNodeViewRenderer>[0]; content?: string; group?: string }) =>
    Node.create({
      name,
      group: opts.group ?? 'block',
      content: opts.content ?? 'block+',
      defining: true,
      draggable: false,
      addAttributes: () => opts.attrs ?? {},
      parseHTML: () => tagged('div', name),
      renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': name, class: opts.className }), 0],
      ...(opts.nodeView ? { addNodeView: () => view(opts.nodeView!) } : {}),
    });

  const atom = (name: string, attrs: Record<string, unknown>, component: Parameters<typeof AngularNodeViewRenderer>[0]) =>
    Node.create({
      name,
      group: 'block',
      atom: true,
      selectable: true,
      draggable: true,
      addAttributes: () => attrs,
      parseHTML: () => tagged('div', name),
      renderHTML: ({ HTMLAttributes }) => ['div', mergeAttributes(HTMLAttributes, { 'data-type': name })],
      addNodeView: () => view(component),
    });

  const inlineAtom = (name: string, attrs: Record<string, unknown>, component: Parameters<typeof AngularNodeViewRenderer>[0], text: (attrs: Record<string, unknown>) => string) =>
    Node.create({
      name,
      group: 'inline',
      inline: true,
      atom: true,
      selectable: true,
      addAttributes: () => attrs,
      parseHTML: () => tagged('span', name),
      renderHTML: ({ HTMLAttributes, node }) => ['span', mergeAttributes(HTMLAttributes, { 'data-type': name }), text(node.attrs)],
      renderText: ({ node }) => text(node.attrs),
      addNodeView: () => view(component),
    });

  return [
    container('callout', { className: 'cn-callout', attrs: { tone: stringAttr('tone', 'note'), icon: stringAttr('icon') }, nodeView: CalloutView }),
    container('readAloud', { className: 'cn-readaloud' }),
    container('secret', { className: 'cn-secret', attrs: { note: stringAttr('note', '') }, nodeView: SecretView }),
    container('columns', { className: 'cn-columns', content: 'column{2,4}' }),
    container('column', { className: 'cn-column', group: 'column' }),
    container('tabs', { className: 'cn-tabs', content: 'tab+' }),
    container('tab', { className: 'cn-tab', group: 'tab', attrs: { title: stringAttr('title', 'Tab') }, nodeView: TabView }),
    container('templateInstance', {
      className: 'cn-linked-template',
      attrs: { templateId: stringAttr('template-id'), version: jsonAttr('version', 0), values: jsonAttr('values', {}), detached: jsonAttr('detached', false) },
      nodeView: TemplateInstanceView,
    }),
    atom('image', { src: jsonAttr('src', null), alt: stringAttr('alt', ''), caption: stringAttr('caption', ''), style: stringAttr('style', 'inline') }, ImageView),
    atom('gallery', { images: jsonAttr('images', []) }, GalleryView),
    atom('refEmbed', { uid: stringAttr('uid'), kind: stringAttr('kind'), display: stringAttr('display', 'full') }, RefEmbedView),
    atom('pageEmbed', { pageId: stringAttr('page-id'), mode: stringAttr('mode', 'card') }, PageEmbedView),
    atom('query', { title: stringAttr('title', ''), filter: jsonAttr('filter', { types: [], tags: [], parent: null, where: [], sort: { field: 'title', dir: 'asc' }, limit: 100 }), view: stringAttr('view', 'list'), columns: jsonAttr('columns', []) }, QueryView),
    atom('statGrid', { items: jsonAttr('items', [{ label: '', value: '' }]), columns: jsonAttr('columns', 2) }, StatGridView),
    atom('encounter', { encounterId: stringAttr('encounter-id') }, EncounterBlockView),
    atom('loot', { items: jsonAttr('items', []), coins: jsonAttr('coins', { cp: 0, sp: 0, ep: 0, gp: 0, pp: 0 }), awarded: jsonAttr('awarded', null) }, LootBlockView),
    atom('unknownBlock', { raw: jsonAttr('raw', null) }, UnknownView),
    inlineAtom('tag', { markup: stringAttr('markup', '') }, TagView, (a) => String(a['markup'] ?? '')),
    inlineAtom('pageLink', { pageId: stringAttr('page-id', ''), label: stringAttr('label', '') }, PageLinkView, (a) => `[[${String(a['label'] ?? '')}]]`),
    inlineAtom('placeholder', { name: stringAttr('name', ''), valueType: stringAttr('value-type', 'text'), label: stringAttr('label', '') }, PlaceholderView, (a) => `{{${String(a['name'] ?? '')}}}`),
  ];
}
