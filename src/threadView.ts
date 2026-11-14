import * as path from 'path';
import * as vscode from 'vscode';
import { CommentAuthor, StoredComment, StoredThread } from './threadStore';

const COMMENT_AUTHORS: Record<CommentAuthor, vscode.CommentAuthorInformation> = {
  user: { name: 'You', iconPath: createAvatarIcon('Y', '#1F6FEB') },
  claude: { name: 'Claude', iconPath: createAvatarIcon('C', '#D97757') },
};
const PENDING_LABEL = '未送信';
const LEADING_VISIBLE_COMMENT_COUNT = 1;
const INITIAL_TRAILING_VISIBLE_COMMENT_COUNT = 2;
const COMMENT_COUNT_PER_REVEAL = 3;

export const SHOW_MORE_COMMENTS_COMMAND = 'inlineComment.showMoreComments';

export class ThreadView {
  private readonly editorThreadsByThreadId = new Map<string, vscode.CommentThread>();
  private readonly trailingVisibleCommentCountsByThreadId = new Map<string, number>();
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
    editorThread.comments = this.buildVisibleComments(thread);
    editorThread.contextValue = thread.status;
    editorThread.state = isResolved ? vscode.CommentThreadState.Resolved : vscode.CommentThreadState.Unresolved;
    editorThread.collapsibleState = isResolved
      ? vscode.CommentThreadCollapsibleState.Collapsed
      : vscode.CommentThreadCollapsibleState.Expanded;
  }

  showMoreComments(thread: StoredThread): void {
    this.trailingVisibleCommentCountsByThreadId.set(
      thread.id,
      this.findTrailingVisibleCommentCount(thread) + COMMENT_COUNT_PER_REVEAL
    );
    this.renderThread(thread);
  }

  removeThread(thread: StoredThread): void {
    this.editorThreadsByThreadId.get(thread.id)?.dispose();
    this.editorThreadsByThreadId.delete(thread.id);
    this.trailingVisibleCommentCountsByThreadId.delete(thread.id);
  }

  findThreadId(editorThread: vscode.CommentThread): string | undefined {
    return this.threadIdsByEditorThread.get(editorThread);
  }

  private buildVisibleComments(thread: StoredThread): vscode.Comment[] {
    const trailingVisibleCommentCount = this.findTrailingVisibleCommentCount(thread);
    const hiddenCommentCount = thread.comments.length - LEADING_VISIBLE_COMMENT_COUNT - trailingVisibleCommentCount;
    if (hiddenCommentCount <= 0) {
      return thread.comments.map(convertToEditorComment);
    }

    const leadingComments = thread.comments.slice(0, LEADING_VISIBLE_COMMENT_COUNT);
    const trailingComments = thread.comments.slice(-trailingVisibleCommentCount);

    return [
      ...leadingComments.map(convertToEditorComment),
      createHiddenCommentsPlaceholder(thread.id, hiddenCommentCount),
      ...trailingComments.map(convertToEditorComment),
    ];
  }

  private findTrailingVisibleCommentCount(thread: StoredThread): number {
    return this.trailingVisibleCommentCountsByThreadId.get(thread.id) ?? INITIAL_TRAILING_VISIBLE_COMMENT_COUNT;
  }
}

function createAvatarIcon(initial: string, backgroundColor: string): vscode.Uri {
  const avatarSvg = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">',
    `<circle cx="16" cy="16" r="16" fill="${backgroundColor}"/>`,
    '<text x="16" y="22" font-family="sans-serif" font-size="17" font-weight="bold" text-anchor="middle" fill="#FFFFFF">',
    initial,
    '</text></svg>',
  ].join('');

  return vscode.Uri.parse(`data:image/svg+xml;base64,${Buffer.from(avatarSvg).toString('base64')}`);
}

function createHiddenCommentsPlaceholder(threadId: string, hiddenCommentCount: number): vscode.Comment {
  const revealCommentCount = Math.min(COMMENT_COUNT_PER_REVEAL, hiddenCommentCount);
  const commandArguments = encodeURIComponent(JSON.stringify([threadId]));
  const body = new vscode.MarkdownString(
    `[さらに ${revealCommentCount} 件表示](command:${SHOW_MORE_COMMENTS_COMMAND}?${commandArguments})`
  );
  body.isTrusted = { enabledCommands: [SHOW_MORE_COMMENTS_COMMAND] };

  return {
    author: { name: `${hiddenCommentCount} 件のコメントを省略中` },
    body,
    mode: vscode.CommentMode.Preview,
  };
}

function convertToEditorComment(comment: StoredComment): vscode.Comment {
  return {
    author: COMMENT_AUTHORS[comment.author],
    body: new vscode.MarkdownString(comment.body),
    mode: vscode.CommentMode.Preview,
    label: comment.state === 'pending' ? PENDING_LABEL : undefined,
    timestamp: new Date(comment.createdAt),
  };
}
