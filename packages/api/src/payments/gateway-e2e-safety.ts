/** A test-looking username or URL query must never authorize destructive fixtures. */
export function assertGatewayTestTarget(connection: string, resetDatabase: string | undefined): void {
  let url: URL;
  try { url = new URL(connection); } catch { throw new Error('Gateway E2E requires a valid test database URL'); }
  const database = decodeURIComponent(url.pathname.slice(1));
  if (!['postgres:', 'postgresql:'].includes(url.protocol) ||
      !/^[a-zA-Z0-9_]+_test$/.test(database) || resetDatabase !== database) {
    throw new Error('Gateway E2E requires a *_test database and SR_GATEWAY_E2E_RESET_DATABASE matching its exact name');
  }
}
