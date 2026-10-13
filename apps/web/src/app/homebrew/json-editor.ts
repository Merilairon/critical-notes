import type { ElementRef} from '@angular/core';
import { ChangeDetectionStrategy, Component, effect, input, output, untracked, viewChild, type OnDestroy } from '@angular/core';
import { json, jsonParseLinter } from '@codemirror/lang-json';
import { syntaxTree } from '@codemirror/language';
import { forceLinting, linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import { EditorState, type Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { SyntaxNode, Tree } from '@lezer/common';
import { basicSetup } from 'codemirror';
import type { HomebrewIssue } from '@cn/shared';

/** The text range of a JSON pointer ("/a/0/b") in a JSON document, via the Lezer JSON tree. */
export function rangeOfPath(tree: Tree, doc: Text, path: string): { from: number; to: number } | null {
  let node: SyntaxNode | null = tree.topNode.firstChild;
  const segments = path.split('/').slice(1).map((s) => s.replace(/~1/g, '/').replace(/~0/g, '~'));
  for (const seg of segments) {
    if (!node) return null;
    if (node.name === 'Object') {
      let found: SyntaxNode | null = null;
      for (let p = node.firstChild; p; p = p.nextSibling) {
        if (p.name !== 'Property') continue;
        const key = p.getChild('PropertyName');
        if (key && JSON.parse(doc.sliceString(key.from, key.to)) === seg) {
          found = key.nextSibling?.name === ':' ? key.nextSibling.nextSibling : (p.lastChild ?? null);
          break;
        }
      }
      node = found;
    } else if (node.name === 'Array') {
      const values: SyntaxNode[] = [];
      for (let c = node.firstChild; c; c = c.nextSibling) if (!['[', ']', ','].includes(c.name)) values.push(c);
      node = values[Number(seg)] ?? null;
    } else return null;
  }
  return node ? { from: node.from, to: node.to } : null;
}

/** CodeMirror JSON editor: syntax errors from the parser, schema issues placed at their JSON paths. */
@Component({
  selector: 'cn-json-editor',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<div #host class="cn-json-editor overflow-hidden rounded-md border border-line text-sm"></div>`,
})
export class JsonEditor implements OnDestroy {
  /** The value to show. Only re-applied when it differs from what the editor currently holds. */
  readonly value = input.required<unknown>();
  readonly issues = input<HomebrewIssue[]>([]);
  readonly changed = output<unknown>();
  private readonly host = viewChild.required<ElementRef<HTMLElement>>('host');
  private view: EditorView | null = null;
  private lastEmitted = '';
  private issuesRef: HomebrewIssue[] = [];
  /** True while applying an outside value (not a user edit). */
  private applying = false;

  constructor() {
    effect(() => {
      const text = JSON.stringify(this.value(), null, 2);
      untracked(() => this.sync(text));
    });
    effect(() => {
      this.issuesRef = this.issues();
      // Re-run the linter with the new issues
      untracked(() => this.view && forceLinting(this.view));
    });
  }

  private sync(text: string) {
    if (!this.view) {
      this.lastEmitted = text;
      this.view = new EditorView({
        parent: this.host().nativeElement,
        state: EditorState.create({
          doc: text,
          extensions: [
            basicSetup,
            json(),
            lintGutter(),
            linter((view) => [...jsonParseLinter()(view), ...this.issueDiagnostics(view)], { delay: 300 }),
            EditorView.updateListener.of((u) => {
              if (!u.docChanged || this.applying) return;
              const current = u.state.doc.toString();
              try {
                const parsed: unknown = JSON.parse(current);
                this.lastEmitted = JSON.stringify(parsed, null, 2);
                this.changed.emit(parsed);
              } catch {
                // keep editing; the parse linter shows the problem
              }
            }),
            EditorView.theme({ '&': { maxHeight: '70vh' }, '.cn-json-editor &.cm-editor': { fontSize: '13px' } }),
          ],
        }),
      });
      return;
    }
    // Ignore echoes of our own edits (same JSON, possibly formatted differently)
    if (text === this.lastEmitted) return;
    this.lastEmitted = text;
    this.applying = true;
    try {
      this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: text } });
    } finally {
      this.applying = false;
    }
  }

  private issueDiagnostics(view: EditorView): Diagnostic[] {
    const tree = syntaxTree(view.state);
    return this.issuesRef.map((issue) => {
      const range = rangeOfPath(tree, view.state.doc, issue.path) ?? { from: 0, to: Math.min(1, view.state.doc.length) };
      return { from: range.from, to: range.to, severity: issue.message.startsWith('5etools schema') ? 'warning' : 'error', message: issue.message } satisfies Diagnostic;
    });
  }

  ngOnDestroy() {
    this.view?.destroy();
  }
}
