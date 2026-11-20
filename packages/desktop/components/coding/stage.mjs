/** A disposable Git worktree for coding; the source checkout stays the promotion target. */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

function git(cwd, args) {
  try {
    return execFileSync('git', ['-C', cwd, ...args], {
      encoding: 'utf8', timeout: 30000, maxBuffer: 8 * 1024 * 1024,
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    const detail = String(error.stderr ?? error.message).trim().slice(-500);
    throw new Error('git-command-failed: ' + detail);
  }
}

export function requireGitHead(cwd, expectedHead) {
  const actual = git(cwd, ['rev-parse', 'HEAD']);
  if (actual !== expectedHead) throw new Error('git-head-changed');
}

export function requireCleanGitRoot(cwd, expectedHead = null) {
  const root = git(cwd, ['rev-parse', '--show-toplevel']);
  if (realpathSync.native(root) !== realpathSync.native(cwd))
    throw new Error('git-worktree-mode-requires-repository-root');
  if (git(cwd, ['rev-parse', '--is-bare-repository']) !== 'false')
    throw new Error('git-worktree-mode-requires-nonbare-repository');
  const head = git(cwd, ['rev-parse', 'HEAD']);
  if (expectedHead !== null && head !== expectedHead) throw new Error('source-head-changed');
  if (git(cwd, ['status', '--porcelain=v1', '--untracked-files=all', '--ignore-submodules=none']))
    throw new Error('source-worktree-not-clean');
  if (git(cwd, ['ls-files', '--stage']).split('\n').some(line => line.startsWith('160000 ')))
    throw new Error('git-submodules-not-supported');
  return head;
}

export function createStageWorktree(cwd, stateDir, ticketId, head) {
  const parent = join(stateDir, 'stages');
  const path = join(parent, ticketId);
  if (existsSync(path)) throw new Error('ticket-stage-already-exists');
  mkdirSync(parent, { recursive: true });
  // Override hooks for this one Git command; repository hooks must not run at checkout.
  git(cwd, ['-c', 'core.hooksPath=' + join(parent, 'no-hooks'),
    'worktree', 'add', '--detach', path, head]);
  requireGitHead(path, head);
  return path;
}
