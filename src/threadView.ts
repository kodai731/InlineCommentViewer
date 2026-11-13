import * as path from 'path';
import * as vscode from 'vscode';
import { CommentAuthor, StoredComment, StoredThread } from './threadStore';

const AUTHOR_DISPLAY_NAMES: Record<CommentAuthor, string> = { user: 'You', claude: 'Claude' };
const PENDING_LABEL = '未送信';

export class ThreadView {
  private readonly editorThreadsByThreadId = new Map<string, vscode.CommentThread>();
  private readonly threadIdsByEditorThread = new WeakMap<vscode.CommentThread, string>();

  constructor(
    private readonly commentController: vscode.CommentController,
    private readonly workspaceRoot: string
  ) {}

  restoreThread(thread: StoredThread): void {
    const fileUri = vscode.Uri.file(path.join(this.workspaceRoot, thread.filePath));
    const lineRange = new vscode.Range(thread.startLine, 0, thread.endLine, 0);
    const editorThread = this.commentController.createCommentThread(fileUri, lineRange, []);

    this.attachEditorThread(thread, editorThread);
  }

  attachEditorThread(thread: StoredThread, editorThread: vscode.CommentThread): void {
    this.editorThreadsByThreadId.set(thread.id, editorThread);
    this.threadIdsByEditorThread.set(editorThread, thread.id);
    this.renderThread(thread);
  }

  renderThread(thread: StoredThread): void {
    const editorThread = this.editorThreadsByThreadId.get(thread.id);
    if (!editorThread) {
      return;
    }

    const isResolved = thread.status === 'resolved';
    editorThread.comments = thread.comments.map(convertToEditorComment);
    editorThread.contextValue = thread.status;
    editorThread.state = isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    editorThread.collapsibleState = isResolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
  }

  removeThread(thread: StoredThread): void {
    this.editorThreadsByThreadId.get(thread.id)?.dispose();
    this.editorThreadsByThreadId.delete(thread.id);
  }

  findThreadId(editorThread: vscode.CommentThread): string | undefined {
    return this.threadIdsByEditorThread.get(editorThread);
  }
}

function convertToEditorComment(comment: StoredComment): vscode.Comment {
  return {
    author: { name: AUTHOR_DISPLAY_NAMES[comment.author] },
    body: new vscode.MarkdownString(comment.body),
    mode: vscode.CommentMode.Preview,
    label: comment.state === 'pending' ? PENDING_LABEL : undefined,
    timestamp: new Date(comment.createdAt),
  };
}
