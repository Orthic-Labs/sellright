module.exports = {
  apps: [
    { name: 'sellright-demo-db', script: './postgres.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000 },
    // 768M: the demo API + interactive wrapper idles around 340 MB RSS, so the old 256M limit
    // restarted it in a loop. DEMO_BIND_HOST is the production bind: nginx runs in Docker and
    // reaches the host over the bridge gateway 172.22.0.1 (127.0.0.1 would 502); UFW keeps the
    // port off the public interface. Override it for a loopback-only install.
    { name: 'sellright-demo', script: './run.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000,
      max_memory_restart: '768M',
      env: { DEMO_BIND_HOST: '172.22.0.1' } },
    // Generic Qwik storefront (packages/storefront), serving /shop for the
    // demo wrapper (interactive-server.mjs) to reverse-proxy to. No database
    // access, no secrets — run-storefront.mjs also strips any inherited
    // DATABASE_URL/STRIPE_/SMTP_/etc before spawning it.
    { name: 'sellright-demo-storefront', script: './run-storefront.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000,
      max_memory_restart: '256M' },
  ],
};
