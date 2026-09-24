module.exports = {
  apps: [
    { name: 'sellright-demo-db', script: './postgres.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000 },
    { name: 'sellright-demo', script: './run.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000,
      max_memory_restart: '256M' },
    // Generic Qwik storefront (packages/storefront), serving /shop for the
    // demo wrapper (interactive-server.mjs) to reverse-proxy to. No database
    // access, no secrets — run-storefront.mjs also strips any inherited
    // DATABASE_URL/STRIPE_/SMTP_/etc before spawning it.
    { name: 'sellright-demo-storefront', script: './run-storefront.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000,
      max_memory_restart: '256M' },
  ],
};
