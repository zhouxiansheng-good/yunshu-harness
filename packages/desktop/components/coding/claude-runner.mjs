/** Claude Code CLI transport. It reuses user relay settings and never handles the token itself. */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { channelIssue } from '../system/channel-status.mjs';

const execFileAsync = promisify(execFile);

export function claudeArgs(request, config) {
  const args = [...(config.argvPrefix ?? []), '-p', '--output-format', 'json',
    '--permission-mode', request.sandbox === 'read-only' ? 'plan' : 'acceptEdits', '--permission-prompts', 'none',
    '--setting-sources', 'user', '--strict-mcp-config', '--no-chrome',
    '--tools', request.sandbox === 'read-only' ? 'Read,Glob,Grep' : 'Read,Edit,Write,Glob,Grep'];
  if (config.model) args.push('--model', config.model);
  if (config.maxBudgetUsd) args.push('--max-budget-usd', String(config.maxBudgetUsd));
  if (request.resumeThreadId) args.push('--resume', request.resumeThreadId);
  args.push(request.prompt);
  return args;
}

function nonnegative(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

export function parseClaudeResult(stdout, exitCode = 0) {
  let result;
  try { result = JSON.parse(String(stdout).trim()); }
  catch { throw new Error('claude-result-json-unavailable'); }
  if (!result || result.type !== 'result') throw new Error('claude-result-json-unavailable');
  const raw = result.usage;
  const cacheCreation = nonnegative(raw?.cache_creation_input_tokens);
  const cacheRead = nonnegative(raw?.cache_read_input_tokens);
  const input = nonnegative(raw?.input_tokens) + cacheCreation + cacheRead;
  const output = nonnegative(raw?.output_tokens);
  const usage = raw && Number.isSafeInteger(input + output)
    ? { inputTokens: input, outputTokens: output, cachedInputTokens: cacheRead,
      totalTokens: input + output } : null;
  return {
    status: exitCode === 0 && result.is_error !== true && result.subtype === 'success'
      ? 'completed' : 'failed',
    threadId: typeof result.session_id === 'string' ? result.session_id : null,
    answer: typeof result.result === 'string' ? result.result.slice(0, 12000) : '',
    usage,
    costUsd: typeof result.total_cost_usd === 'number' && Number.isFinite(result.total_cost_usd)
      && result.total_cost_usd >= 0 ? result.total_cost_usd : null,
  };
}

export async function runClaudeRequest(config, request, context = {}) {
  const startedAt = new Date().toISOString();
  const args = claudeArgs(request, config);
  let stdout, exitCode = 0;
  try {
    const result = await execFileAsync(config.path, args, {
      cwd: request.cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: config.home },
      windowsHide: true, signal: context.signal, timeout: config.runTimeoutMs,
      maxBuffer: 4 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    if (context.signal?.aborted) throw error;
    stdout = error.stdout;
    exitCode = typeof error.code === 'number' ? error.code : 1;
    if (!stdout) {
      const issue=channelIssue(error.stderr||error.code);
      throw Error(issue.reason+issue.action);
    }
  }
  const parsed = parseClaudeResult(stdout, exitCode);
  return { kind: 'run', outcome: {
    ...parsed, runId: 'claude-' + randomUUID(),
    resumedThreadId: request.resumeThreadId ?? null,
    startedAt, endedAt: new Date().toISOString(),
  } };
}
