/** Absolute provider-work deadline; callers must pass signal to cancellable I/O. */
export async function withRequestDeadline<T>(
  timeoutMs: number,
  run: (signal: AbortSignal) => Promise<T>,
  parent?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) forwardAbort();
  else parent?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException('Listmonk request deadline exceeded', 'TimeoutError')), timeoutMs);
  timer.unref();
  try {
    controller.signal.throwIfAborted();
    return await run(controller.signal);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener('abort', forwardAbort);
  }
}
