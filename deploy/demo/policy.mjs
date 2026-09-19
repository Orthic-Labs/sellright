const adminReads = new Set([
  'me', 'dashboard', 'products', 'variants', 'collections', 'inventory', 'orders',
  'customers', 'reports', 'activity', 'locations', 'promotions', 'returns',
]);

export function demoSessionCookie(cookie) {
  return cookie.replace(/;\s*(?:max-age|expires)=[^;]*/gi, '') + '; Max-Age=3600';
}

export function demoBindHost(host = '127.0.0.1') {
  if (!['127.0.0.1', '172.22.0.1'].includes(host)) {
    throw new Error('Demo listener must use loopback or the designated private nginx bridge');
  }
  return host;
}

export function allowedDemoRequest(method, pathname) {
  if (method === 'GET' || method === 'HEAD') {
    if (['/v1/health', '/v1/readyz', '/v1/shop/config'].includes(pathname)) return true;
    if (/^\/v1\/shop\/catalog\/(products|collections)(\/[a-zA-Z0-9_-]+)?$/.test(pathname)) return true;
    if (/^\/v1\/shop\/cart\/[0-9a-f-]{36}$/.test(pathname)) return true;
    const match = /^\/v1\/admin\/([a-z-]+)(?:\/([a-zA-Z0-9_-]+))?$/.exec(pathname);
    return !!match && adminReads.has(match[1]) && match[2] !== 'export';
  }
  if (method === 'POST') return ['/v1/shop/cart', '/v1/shop/cart/estimate'].includes(pathname);
  return method === 'PATCH' && /^\/v1\/shop\/cart\/[0-9a-f-]{36}\/lines$/.test(pathname);
}

export function allowedDemoBody(pathname, body) {
  if (pathname.startsWith('/v1/shop/cart')) {
    if (body.email || body.customerId || body.token || body.couponCode) return false;
    const lines = body.items ?? body.lines ?? [];
    return Array.isArray(lines) && lines.length <= 20 &&
      lines.every(line => /^DEMO-[A-Z]+$/.test(line.sku) &&
        Number.isInteger(line.quantity) && line.quantity >= 0 && line.quantity <= 10);
  }
  return false;
}
