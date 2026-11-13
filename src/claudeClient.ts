import { spawn } from 'child_process';

export interface ThreadReply {
  threadId: string;
  reply: string;
}

export interface ClaudeRequest {
  claudePath: string;
  prompt: string;
  sessionId: string | null;
  workspaceRoot: string;
}

export interface ClaudeResponse {
  replies: ThreadReply[];
  sessionId: string;
}

const REPLY_SCHEMA = JSON.stringify({
  type: 'object',
  properties: {
    replies: {
      type: 'array',
      items: {
        type: 'object',
        properties: { threadId: { type: 'string' }, reply: { type: 'string' } },
        required: ['threadId', 'reply'],
      },
    },
  },
  required: ['replies'],
});

export function askClaude(request: ClaudeRequest): Promise<ClaudeResponse> {
  const commandArguments = [
    '-p',
    '--output-format',
    'json',
    '--permission-mode',
    'acceptEdits',
    '--json-schema',
    REPLY_SCHEMA,
  ];
  if (request.sessionId) {
    commandArguments.push('--resume', request.sessionId);
  }

  return new Promise((resolve, reject) => {
    const claudeProcess = spawn(request.claudePath, commandArguments, { cwd: request.workspaceRoot });
    let standardOutput = '';
    let standardError = '';

    claudeProcess.stdout.on('data', (chunk) => (standardOutput += chunk));
    claudeProcess.stderr.on('data', (chunk) => (standardError += chunk));
    claudeProcess.on('error', reject);

    claudeProcess.on('close', (exitCode) => {
      if (exitCode !== 0) {
        reject(new Error(standardError || standardOutput || `claude exited with code ${exitCode}`));
        return;
      }

      const response = JSON.parse(standardOutput);
      if (response.is_error || !response.structured_output) {
        reject(new Error(response.result ?? 'Claude から返信を取得できませんでした'));
        return;
      }

      resolve({ replies: response.structured_output.replies, sessionId: response.session_id });
    });

    claudeProcess.stdin.end(request.prompt);
  });
}
