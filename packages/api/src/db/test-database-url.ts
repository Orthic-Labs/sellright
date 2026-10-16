/** Test-only guard: never infer a destructive fixture's target from credentials or query text. */
export function isDisposablePostgresUrl(databaseUrl: unknown): databaseUrl is string {
  if (typeof databaseUrl !== 'string' || !databaseUrl || /[\s\u0000-\u001f\u007f-\u009f\\]/u.test(databaseUrl)
    || /%(?![\da-f]{2})/i.test(databaseUrl)) return false;

  try {
    // URL accepts some malformed UTF-8 escapes that pg's component decoding rejects.
    decodeURIComponent(databaseUrl);
    const url = new URL(databaseUrl);
    if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || url.hash
      || databaseUrl.includes('#')) return false;

    // Inspect the original path too: URL normalizes dot segments before exposing pathname.
    const rawPath = /^[a-z]+:\/\/[^/?#]+(\/[^?#]*)?(?:\?[^#]*)?$/i.exec(databaseUrl)?.[1];
    if (!rawPath || !/^\/[^/]+$/.test(rawPath)) return false;
    const databaseName = decodeURIComponent(rawPath.slice(1));
    if (databaseName.length <= 5 || !databaseName.endsWith('_test')
      || /[\s\u0000-\u001f\u007f-\u009f/\\]/u.test(databaseName)) return false;

    // pg applies query settings after parsing pathname, so these can select another database.
    for (const key of url.searchParams.keys()) {
      if (/^(database|dbname|connectionstring)$/i.test(key)) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function requireDisposablePostgresUrl(databaseUrl: unknown, label: string): void {
  if (!isDisposablePostgresUrl(databaseUrl)) {
    // Do not echo any portion of a URL: passwords can also occur outside userinfo.
    throw new Error(`${label} requires a disposable PostgreSQL database named *_test without database query overrides`);
  }
}
