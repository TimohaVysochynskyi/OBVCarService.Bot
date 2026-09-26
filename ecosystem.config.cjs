module.exports = {
  apps: [
    {
      name: 'obv-bot',
      script: 'src/bot/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 100,
      exp_backoff_restart_delay: 2000,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'obv-poller',
      script: 'src/jobs/index.js',
      cwd: __dirname,
      autorestart: false,
      cron_restart: '*/15 * * * *',
      env: { NODE_ENV: 'production', JOB_TYPE: 'poll' },
    },
  ],
};
