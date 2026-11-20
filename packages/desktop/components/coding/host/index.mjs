import { featureTool } from '../../system/policy.mjs';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { CodingCoordinator } from '../coordinator.mjs';
import { projectReviewTool } from '../project-review.mjs';

const output = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
};

export default class YunshuCodingTools {
  static inject = ['tools'];

  constructor(ctx, config = {}) {
    this.coordinator = new CodingCoordinator(config);
    featureTool(ctx,defineTool({
      name: 'yunshu_code_status',
      description: 'Read Codex and Claude Code relay readiness or an existing coding ticket. Static local configuration only; ready does not prove a real request succeeded. No network or model call. For status-only requests, report this result and finish instead of scanning configs or running CLIs. Probe is on unless explicitly false. Ticket recovery is observation-only, not automatic diagnosis or a fresh-context runner; unresolved checks require reconciliation.',
      parameters: { ticketId: { type: 'string' }, probe: { type: 'boolean' } }, output,
      execute: async ({ ticketId, probe }, exec) => {
        exec.signal?.throwIfAborted();
        return ticketId ? this.coordinator.ticketStatus(ticketId) : this.coordinator.status(probe !== false);
      },
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_code_dispatch',
      description: 'Delegate one bounded coding task to Codex or Claude Code through their configured relays. Default provider is codex. On the explicitly configured rank-list-v1 offline host use the exact catalog ticket, cwd, United IDs, goal, acceptance, expectedFiles and deliverable=rank-list-v1, without provider overrides. On an enrolled handoff-wasi-v1 isolated host use the original ticket and public assignment without checkProgram/checkArgs. git-worktree stages in a clean Git worktree; tokenBudget, when set, gates later runs.',
      timeoutMs: this.coordinator.peer.config.runTimeoutMs + 30000,
      parameters: {
        ticketId: { type: 'string', required: true },
        provider: { type: 'string' }, cwd: { type: 'string' },
        goal: { type: 'string', required: true },
        deliverable: { type: 'string', required: true },
        expectedFiles: { type: 'array', items: { type: 'string' }, required: true },
        acceptance: { type: 'string', required: true },
        workspaceMode: { type: 'string' },
        tokenBudget: { type: 'number' },
        checkProgram: { type: 'string' },
        checkArgs: { type: 'array', items: { type: 'string' } },
        unitedRunId: { type: 'string' }, unitedMessageId: { type: 'string' },
        resume: { type: 'boolean' },
        attemptId: { type: 'string' }, followup: { type: 'string' },
      }, output,
      execute: (args, exec) => this.coordinator.dispatch(args, exec),
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_code_verify',
      description: 'Independently recheck expected file hashes, audit the workspace scope, and run the ticket test command without a shell. Windows 10+ uses a native Job for local CreateProcess descendants; no external broker/network side-effect guarantee. Native empty-Job proof is required to settle. Missing evidence stays held. reconcile=true only reads bound receipts and audits unchanged scope; never runs a command, grants a pass, or replays an operation.',
      timeoutMs: this.coordinator.checkTimeoutMs + 60000,
      parameters: { ticketId: { type: 'string', required: true }, reconcile: { type: 'boolean' } }, output,
      execute: ({ ticketId, reconcile }, exec) => reconcile === true
        ? this.coordinator.reconcileVerification(ticketId, exec.signal) : this.coordinator.verify(ticketId, exec.signal),
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_code_promote',
      description: 'Explicitly copy only verified changed files from a staged Git worktree into its unchanged source checkout. Keeps original file copies and a manifest in the rollback directory. Never runs automatically. The rank-list-v1 offline host promotes only the two graded text files and retains their preimages.',
      parameters: { ticketId: { type: 'string', required: true } }, output,
      execute: async ({ ticketId }, exec) => this.coordinator.promote(ticketId, exec.signal),
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_code_submit',
      description: 'After verified Git promotion, submit one finding to the linked manual United builder task through its authoritative CLI. No model call; repeat is idempotent.',
      parameters: { ticketId: { type: 'string', required: true } }, output,
      execute: ({ ticketId }, exec) => this.coordinator.submit(ticketId, exec.signal),
    }));
    featureTool(ctx,defineTool({
      name: 'yunshu_code_cancel',
      description: 'Request cancellation of an active coding run or independent verification Job. Its settled status must be checked afterward.',
      parameters: { ticketId: { type: 'string', required: true } }, output,
      execute: async ({ ticketId }, exec) => {
        exec.signal?.throwIfAborted();
        return this.coordinator.cancel(ticketId);
      },
    }));
    // Capture only server-side read settings, never the coordinator/execution methods.
    const reviewConfig = structuredClone({ allowedRoots: config.allowedRoots ?? [], limits: config.projectReviewLimits,
      stateDir: this.coordinator.stateDir, unitedRoot: this.coordinator.united?.root,
      maxRunsPerTicket: this.coordinator.maxRunsPerTicket, taskLimits: config.projectReviewTaskLimits, projectReviewSourceKind: config.projectReviewSourceKind });
    featureTool(ctx,defineTool({
      name: 'yunshu_project_review',
      description: 'Read-only project-method routing and evidence checks, not a dispatch gate. Known ticket: pass only ticketId to read bounded original ledger facts and route in one call. No arguments: protocol only, no task facts; then follow with ticketId or requestJson action=route/review. Do not mix ticketId and requestJson. Not native receipt or live workspace re-verification. No preflight/enforce. No writes, network, model or command execution. Skip for status-only and clear routine work.',
      parameters: { ticketId: { type: 'string' }, requestJson: { type: 'string' } }, output,
      execute: async (args, exec) => {
        exec.signal?.throwIfAborted();
        return projectReviewTool(args, reviewConfig, exec.signal);
      },
    }));
  }
}
