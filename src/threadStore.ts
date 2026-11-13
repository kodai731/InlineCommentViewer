import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const STORE_DIRECTORY_NAME = '.inline-comments';
const STORE_FILE_NAME = 'threads.json';

export type ThreadStatus = 'unresolved' | 'resolved';
export type CommentState = 'pending' | 'sent';
export type CommentAuthor = 'user' | 'claude';

export interface StoredComment {
  author: CommentAuthor;
  body: string;
  state: CommentState;
  createdAt: string;
}

export interface StoredThread {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  status: ThreadStatus;
  comments: StoredComment[];
}

interface StoreContent {
  sessionId: string | null;
  threads: StoredThread[];
}

export class ThreadStore {
  private readonly storeDirectory: string;
  private readonly storeFile: string;
  private content: StoreContent;

  constructor(workspaceRoot: string) {
    this.storeDirectory = path.join(workspaceRoot, STORE_DIRECTORY_NAME);
    this.storeFile = path.join(this.storeDirectory, STORE_FILE_NAME);
    this.content = this.loadContent();
  }

  get threads(): readonly StoredThread[] {
    return this.content.threads;
  }

  get sessionId(): string | null {
    return this.content.sessionId;
  }

  set sessionId(sessionId: string | null) {
    this.content.sessionId = sessionId;
  }

  save(): void {
    fs.mkdirSync(this.storeDirectory, { recursive: true });
    fs.writeFileSync(path.join(this.storeDirectory, '.gitignore'), '*\n');
    fs.writeFileSync(this.storeFile, JSON.stringify(this.content, null, 2));
  }

  createThread(relativeFilePath: string, startLine: number, endLine: number): StoredThread {
    const thread: StoredThread = {
      id: randomUUID(),
      filePath: relativeFilePath,
      startLine,
      endLine,
      status: 'unresolved',
      comments: [],
    };

    this.content.threads.push(thread);
    return thread;
  }

  addComment(thread: StoredThread, author: CommentAuthor, body: string, state: CommentState): void {
    thread.comments.push({ author, body, state, createdAt: new Date().toISOString() });
  }

  deleteThread(thread: StoredThread): void {
    this.content.threads = this.content.threads.filter((candidate) => candidate.id !== thread.id);
  }

  findThread(threadId: string | undefined): StoredThread | undefined {
    return this.content.threads.find((thread) => thread.id === threadId);
  }

  findSendableThreads(): StoredThread[] {
    return this.content.threads.filter(
      (thread) => thread.status === 'unresolved' && findPendingComments(thread).length > 0
    );
  }

  private loadContent(): StoreContent {
    if (!fs.existsSync(this.storeFile)) {
      return { sessionId: null, threads: [] };
    }

    return JSON.parse(fs.readFileSync(this.storeFile, 'utf8'));
  }
}

export function findPendingComments(thread: StoredThread): StoredComment[] {
  return thread.comments.filter((comment) => comment.state === 'pending');
}
