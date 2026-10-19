import { CdkDrag, CdkDragHandle, CdkDropList, CdkDropListGroup, type CdkDragDrop } from '@angular/cdk/drag-drop';
import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { PAGE_TYPE_ICONS, type PageSummaryDto } from '@cn/shared';
import { readStored, writeStored } from '../core/storage';
import { CampaignStore } from './campaign.store';

/** Expanded/collapsed state shared by all tree levels. */
const expanded = signal<Record<string, boolean>>(readStored('cn.tree.expanded', {}));

@Component({
  selector: 'cn-page-tree-level',
  imports: [CdkDropList, CdkDrag, CdkDragHandle, RouterLink, RouterLinkActive],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<ul
    cdkDropList
    [cdkDropListData]="parentId()"
    (cdkDropListDropped)="drop($event)"
    class="min-h-1"
    [class.pl-3]="depth() > 0"
    role="group"
  >
    @for (page of children(); track page.id) {
      <li cdkDrag [cdkDragData]="page.id" [cdkDragDisabled]="!store.isGm()" class="group">
        <div class="flex items-center gap-0.5 rounded pr-1 hover:bg-panel-2">
          <button
            type="button"
            class="flex h-6 w-5 shrink-0 items-center justify-center text-xs text-muted touch:h-[44px] touch:w-[44px]"
            [class.invisible]="!hasChildren(page.id)"
            (click)="toggle(page.id)"
            [attr.aria-label]="isOpen(page.id) ? 'Collapse' : 'Expand'"
            [attr.aria-expanded]="isOpen(page.id)"
          >
            {{ isOpen(page.id) ? '▾' : '▸' }}
          </button>
          <a
            [routerLink]="['/c', store.id(), 'p', page.id]"
            routerLinkActive="!text-accent font-semibold"
            class="flex min-w-0 flex-1 items-center gap-1.5 py-0.5 text-sm touch:min-h-[44px]"
            cdkDragHandle
          >
            <span aria-hidden="true">{{ page.icon || icons[page.type] }}</span>
            <span class="truncate">{{ page.title }}</span>
          </a>
          @if (store.isGm()) {
            <button
              type="button"
              class="invisible rounded px-1 text-muted group-hover:visible hover:text-accent focus:visible"
              title="Add subpage"
              (click)="addChild(page)"
            >
              +
            </button>
          }
        </div>
        @if (isOpen(page.id)) {
          <cn-page-tree-level [parentId]="page.id" [depth]="depth() + 1" />
        }
      </li>
    }
  </ul>`,
})
export class PageTreeLevel {
  readonly parentId = input<string | null>(null);
  readonly depth = input(0);
  protected readonly store = inject(CampaignStore);
  protected readonly icons = PAGE_TYPE_ICONS;
  protected readonly children = computed(() => this.store.childrenOf().get(this.parentId()) ?? []);

  protected hasChildren(id: string) {
    return (this.store.childrenOf().get(id)?.length ?? 0) > 0;
  }
  protected isOpen(id: string) {
    return !!expanded()[id];
  }
  protected toggle(id: string) {
    expanded.update((e) => ({ ...e, [id]: !e[id] }));
    writeStored('cn.tree.expanded', expanded());
  }

  protected async addChild(parent: PageSummaryDto) {
    const page = await this.store.createPage({ title: 'Untitled', parentId: parent.id, type: 'generic' });
    expanded.update((e) => ({ ...e, [parent.id]: true }));
    writeStored('cn.tree.expanded', expanded());
    this.store.navigateTo?.(page.id);
  }

  protected drop(event: CdkDragDrop<string | null, string | null, string>) {
    const pageId = event.item.data;
    const targetParent = event.container.data;
    const siblings = (this.store.childrenOf().get(targetParent) ?? []).filter((p) => p.id !== pageId);
    const before = siblings[event.currentIndex] ?? null;
    const after = event.currentIndex > 0 ? (siblings[event.currentIndex - 1] ?? null) : null;
    if (event.previousContainer === event.container && event.previousIndex === event.currentIndex) return;
    this.store.movePage(pageId, targetParent, before ? { beforeId: before.id } : after ? { afterId: after.id } : {});
  }
}

@Component({
  selector: 'cn-page-tree',
  imports: [PageTreeLevel, CdkDropListGroup],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<nav cdkDropListGroup aria-label="Pages"><cn-page-tree-level [parentId]="null" /></nav>`,
})
export class PageTree {}
