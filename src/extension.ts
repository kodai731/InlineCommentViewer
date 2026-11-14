import * as path from 'path';
import * as vscode from 'vscode';
import { askClaude } from './claudeClient';
import { StoredThread, ThreadStatus, ThreadStore, findPendingComments } from './threadStore';
import { SHOW_MORE_COMMENTS_COMMAND, ThreadView } from './threadView';

const CONTROLLER_ID = 'inlineComment';
const HAS_PENDING_COMMENTS_CONTEXT_KEY = 'inlineComment.hasPendingComments';

class InlineCommentSession {
  private readonly store: ThreadStore;
  private readonly view: ThreadView;
  private isSending = false;

  constructor(
    private readonly workspaceRoot: string,
    commentController: vscode.CommentController,
    private readonly statusBarItem: vscode.StatusBarItem
  ) {
    this.store = new ThreadStore(workspaceRoot);
    this.view = new ThreadView(commentController, workspaceRoot);

    this.store.threads.forEach((thread) => this.view.restoreThread(thread));
    this.refreshStatusBar();
  }

  addComment(reply: vscode.CommentReply): void {
    const thread = this.findOrCreateThread(reply.thread);

    this.store.addComment(thread, 'user', reply.text, 'pending');
    this.persistThread(thread);
  }

  async sendThread(editorThread: vscode.CommentThread): Promise<void> {
    const thread = this.store.findThread(this.view.findThreadId(editorThread));
    if (!thread || findPendingComments(thread).length === 0) {
      vscode.window.showInformationMessage('このスレッドに未送信コメントはありません');
      return;
    }

    await this.sendThreads([thread]);
  }

  async sendAll(): Promise<void> {
    const sendableThreads = this.store.findSendableThreads();
    if (sendableThreads.length === 0) {
      vscode.window.showInformationMessage('送信できる未送信コメントはありません');
      return;
    }

    await this.sendThreads(sendableThreads);
  }

  startNewSession(): void {
    this.store.sessionId = null;
    this.store.save();
    vscode.window.showInformationMessage('次の送信から新しい Claude セッションを使います');
  }

  setThreadStatus(editorThread: vscode.CommentThread, status: ThreadStatus): void {
    const thread = this.store.findThread(this.view.findThreadId(editorThread));
    if (!thread) {
      return;
    }

    thread.status = status;
    this.persistThread(thread);
  }

  showMoreComments(threadId: string): void {
    const thread = this.store.findThread(threadId);
    if (thread) {
      this.view.showMoreComments(thread);
    }
  }

  deleteThread(editorThread: vscode.CommentThread): void {
    const thread = this.store.findThread(this.view.findThreadId(editorThread));
    if (!thread) {
      editorThread.dispose();
      return;
    }

    this.store.deleteThread(thread);
    this.store.save();
    this.view.removeThread(thread);
    this.refreshStatusBar();
  }

  private async sendThreads(threads: StoredThread[]): Promise<void> {
    if (this.isSending) {
      vscode.window.showWarningMessage('Claude に送信中です。完了後にもう一度実行してください');
      return;
    }

    this.isSending = true;
    try {
      await vscode.workspace.saveAll(false);
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: `Claude に送信中 (${threads.length} スレッド)` },
        () => this.sendThreadsInOneSession(threads)
      );
    } catch (error) {
      vscode.window.showErrorMessage(`送信に失敗しました: ${error instanceof Error ? error.message : error}`);
    } finally {
      this.isSending = false;
    }
  }

  private async sendThreadsInOneSession(threads: StoredThread[]): Promise<void> {
    const sentComments = threads.flatMap(findPendingComments);

    const response = await askClaude({
      claudePath: vscode.workspace.getConfiguration('inlineComment').get('claudePath', 'claude'),
      prompt: await this.buildPrompt(threads),
      sessionId: this.store.sessionId,
      workspaceRoot: this.workspaceRoot,
    });

    sentComments.forEach((comment) => (comment.state = 'sent'));
    for (const threadReply of response.replies) {
      const repliedThread = threads.find((thread) => thread.id === threadReply.threadId);
      if (repliedThread) {
        this.store.addComment(repliedThread, 'claude', threadReply.reply, 'sent');
      }
    }

    this.store.sessionId = response.sessionId;
    this.store.save();
    threads.forEach((thread) => this.view.renderThread(thread));
    this.refreshStatusBar();
  }

  private async buildPrompt(threads: StoredThread[]): Promise<string> {
    const threadSections = await Promise.all(threads.map((thread) => this.buildThreadSection(thread)));

    return [
      'コードのインラインコメントスレッドでの会話です。各スレッドのコメントに対応し、必要ならコードを編集してください。',
      'すべてのスレッドについて、threadId ごとに簡潔な返信を返してください。',
      ...threadSections,
    ].join('\n\n');
  }

  private async buildThreadSection(thread: StoredThread): Promise<string> {
    const document = await vscode.workspace.openTextDocument(path.join(this.workspaceRoot, thread.filePath));
    const codeRange = document.validateRange(
      new vscode.Range(thread.startLine, 0, thread.endLine, Number.MAX_SAFE_INTEGER)
    );
    const commentText = findPendingComments(thread)
      .map((comment) => comment.body)
      .join('\n\n');

    return [
      `## threadId: ${thread.id}`,
      `対象: ${thread.filePath} の ${thread.startLine + 1}〜${thread.endLine + 1} 行目`,
      '```\n' + document.getText(codeRange) + '\n```',
      `コメント:\n${commentText}`,
    ].join('\n\n');
  }

  private findOrCreateThread(editorThread: vscode.CommentThread): StoredThread {
    const existingThread = this.store.findThread(this.view.findThreadId(editorThread));
    if (existingThread) {
      return existingThread;
    }

    const relativeFilePath = path.relative(this.workspaceRoot, editorThread.uri.fsPath);
    const lineRange = editorThread.range ?? new vscode.Range(0, 0, 0, 0);
    const thread = this.store.createThread(relativeFilePath, lineRange.start.line, lineRange.end.line);

    this.view.attachEditorThread(thread, editorThread);
    return thread;
  }

  private persistThread(thread: StoredThread): void {
    this.store.save();
    this.view.renderThread(thread);
    this.refreshStatusBar();
  }

  private refreshStatusBar(): void {
    const pendingCommentCount = this.store
      .findSendableThreads()
      .reduce((count, thread) => count + findPendingComments(thread).length, 0);

    vscode.commands.executeCommand('setContext', HAS_PENDING_COMMENTS_CONTEXT_KEY, pendingCommentCount > 0);

    this.statusBarItem.text = `$(comment-discussion) 未送信 ${pendingCommentCount}`;
    if (pendingCommentCount > 0) {
      this.statusBarItem.show();
    } else {
      this.statusBarItem.hide();
    }
  }
}

function createCommentController(workspaceRoot: string): vscode.CommentController {
  const commentController = vscode.comments.createCommentController(CONTROLLER_ID, 'Inline Comment Viewer');

  commentController.options = { prompt: 'Claude へのコメント', placeHolder: 'この行について Claude に伝えたいこと' };
  commentController.commentingRangeProvider = {
    provideCommentingRanges: (document) => {
      const isWorkspaceFile =
        document.uri.scheme === 'file' && !path.relative(workspaceRoot, document.uri.fsPath).startsWith('..');

      return isWorkspaceFile ? [new vscode.Range(0, 0, document.lineCount - 1, 0)] : [];
    },
  };

  return commentController;
}

export function activate(context: vscode.ExtensionContext): void {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  const workspaceRoot = workspaceFolder.uri.fsPath;
  const commentController = createCommentController(workspaceRoot);
  const statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left);
  statusBarItem.command = 'inlineComment.sendAll';
  statusBarItem.tooltip = '未送信コメントを Claude に一斉送信';

  const session = new InlineCommentSession(workspaceRoot, commentController, statusBarItem);

  context.subscriptions.push(
    commentController,
    statusBarItem,
    vscode.commands.registerCommand('inlineComment.addComment', (reply: vscode.CommentReply) =>
      session.addComment(reply)
    ),
    vscode.commands.registerCommand('inlineComment.sendThread', (editorThread: vscode.CommentThread) =>
      session.sendThread(editorThread)
    ),
    vscode.commands.registerCommand('inlineComment.sendAll', () => session.sendAll()),
    vscode.commands.registerCommand('inlineComment.startNewSession', () => session.startNewSession()),
    vscode.commands.registerCommand('inlineComment.resolveThread', (editorThread: vscode.CommentThread) =>
      session.setThreadStatus(editorThread, 'resolved')
    ),
    vscode.commands.registerCommand('inlineComment.unresolveThread', (editorThread: vscode.CommentThread) =>
      session.setThreadStatus(editorThread, 'unresolved')
    ),
    vscode.commands.registerCommand(SHOW_MORE_COMMENTS_COMMAND, (threadId: string) =>
      session.showMoreComments(threadId)
    ),
    vscode.commands.registerCommand('inlineComment.deleteThread', (editorThread: vscode.CommentThread) =>
      session.deleteThread(editorThread)
    )
  );
}

export function deactivate(): void {}
