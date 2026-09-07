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
      // Двадцять дозволених рестартів плюс миттєві спроби означали, що помилка на СТАРТІ (зламаний
      // .env, недоступний Postgres, зайнятий getUpdates) спалювала ліміт за кілька секунд - і pm2
      // назавжди припиняв піднімати бота. Разом із ним умирали авто-звіти, і ніхто про це не
      // дізнавався. Тепер ліміт високий, а між спробами росте пауза (100мс -> до 15с), тож цикл
      // рестартів дає час на діагностику замість тихої смерті. Плюс за живістю бота тепер стежить
      // полер (core/liveness.js), тож навіть остаточна смерть більше не залишиться незамеченою.
      max_restarts: 100,
      exp_backoff_restart_delay: 2000,
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
