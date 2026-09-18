module.exports = {
  apps: [
    { name: 'sellright-demo-db', script: './postgres.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000 },
    { name: 'sellright-demo', script: './run.mjs', cwd: __dirname,
      interpreter: 'node', kill_timeout: 10000, restart_delay: 3000,
      max_memory_restart: '256M' },
  ],
};
