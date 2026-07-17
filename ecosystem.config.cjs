// pm2 config for the VPS deploy (AlmaLinux). Two processes from one repo:
//   obv-bot    — persistent report bot (grammy long-polling), kept alive 24/7
//   obv-poller — ingest job, run once every 15 min via pm2 cron (not kept alive)
// Both read .env from the project root (cwd) via `import 'dotenv/config'`.
// Usage: pm2 start ecosystem.config.cjs && pm2 save
module.exports = {
  apps: [
    {
      name: 'obv-bot',
      script: 'src/bot/index.js',
      cwd: __dirname,
      autorestart: true,
      max_restarts: 20,
      env: { NODE_ENV: 'production' },
    },
    {
      name: 'obv-poller',
      script: 'src/jobs/index.js',
      cwd: __dirname,
      autorestart: false, // one-shot task, must exit — don't keep it running
      cron_restart: '*/15 * * * *', // pm2 re-launches it every 15 min
      env: { NODE_ENV: 'production', JOB_TYPE: 'poll' },
    },
  ],
};
