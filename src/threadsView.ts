// Sidebar tree for review threads: files → threads, fed from the same mapped
// data the editor rendering uses. Knows nothing about GitHub.
import * as vscode from 'vscode';
import { join } from 'path';
import { MappedThread } from './commentUI';

function firstLine(s: string | undefined): string {
  return (s ?? '').split('\n', 1)[0].slice(0, 80);
}

interface FileNode {
  kind: 'file';
  path: string;
  uri: vscode.Uri;
  threads: MappedThread[];
}

interface ThreadNode {
  kind: 'thread';
  mt: MappedThread;
  uri: vscode.Uri;
  line: number;
}

export type ThreadsNode = FileNode | ThreadNode;

export class ThreadsView implements vscode.TreeDataProvider<ThreadsNode> {
  private emitter = new vscode.EventEmitter<void | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private files: FileNode[] = [];

  setData(root: string | null, mapped: MappedThread[]): void {
    const byPath = new Map<string, MappedThread[]>();
    for (const m of mapped) {
      byPath.set(m.thread.path, [...(byPath.get(m.thread.path) ?? []), m]);
    }
    this.files = root
      ? [...byPath.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, threads]) => ({
            kind: 'file' as const,
            path,
            uri: vscode.Uri.file(join(root, path)),
            threads,
          }))
      : [];
    this.emitter.fire(undefined);
  }

  /** Re-read mutated thread state (optimistic resolve/unresolve) without new data. */
  poke(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(n: ThreadsNode): vscode.TreeItem {
    if (n.kind === 'file') {
      const unresolved = n.threads.filter((t) => !t.thread.isResolved).length;
      const item = new vscode.TreeItem(n.path, vscode.TreeItemCollapsibleState.Expanded);
      item.resourceUri = n.uri; // theme file icon + decorations
      item.iconPath = vscode.ThemeIcon.File;
      item.description = unresolved > 0 ? `${unresolved} unresolved` : 'all resolved';
      return item;
    }
    const { thread, anchor } = n.mt;
    const head = thread.comments[0];
    const item = new vscode.TreeItem(
      `${head?.author ?? '?'}: ${firstLine(head?.body)}`,
      vscode.TreeItemCollapsibleState.None,
    );
    item.iconPath = new vscode.ThemeIcon(
      thread.isResolved ? 'check' : anchor.confidence === 'lost' ? 'warning' : 'comment',
    );
    item.description = `:${anchor.line ?? '?'}${thread.isOutdated ? ' · outdated' : ''}`;
    item.tooltip = head?.body;
    item.command = { command: 'ptal.openLocation', title: 'Go to comment', arguments: [n.uri, n.line] };
    return item;
  }

  getChildren(n?: ThreadsNode): ThreadsNode[] {
    if (!n) {
      return this.files;
    }
    if (n.kind === 'file') {
      return n.threads.map((mt) => ({
        kind: 'thread' as const,
        mt,
        uri: n.uri,
        line: mt.anchor.line ?? 1,
      }));
    }
    return [];
  }
}
