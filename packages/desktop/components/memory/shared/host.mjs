import { RemoteError } from '@deepseek-ai/dsh-typert-protocol';
export function requireOwner(ctx, signal) {
  signal.throwIfAborted();
  if (ctx.invocation?.peer?.principal?.kind !== 'owner') throw new RemoteError('yunshu/owner-required', 'This operation requires the owner desktop interface', {});
}
export function registerRemote(ctx, info) {
  ctx.typert.register({ package: info.package, face: 'host', schemas: [], invocations: info.descriptors, model: { services: [], events: [], objects: [] } });
}
export function dataError(error) {
  if (error?.isDSHRemoteError) return new RemoteError(error.code, error.message, error.details && typeof error.details === 'object' && !Array.isArray(error.details) ? error.details : {});
  return new RemoteError('yunshu/' + (error?.code || 'operation-failed'), error instanceof Error ? error.message : String(error), {});
}
