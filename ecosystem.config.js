module.exports = {
  apps: [{
    name: 'driago',
    script: '/root/driago/src/index.js',
    interpreter: '/usr/bin/node',
    cwd: '/root/driago',
    env_file: '/root/driago/.env',
    env: {
      NODE_ENV: 'production',
      RAG_ENABLED: 'true',
      RAG_AUTO_INJECT: 'true',
      EMBEDDING_MODEL: 'nomic-embed-text',
      EMBEDDING_DIMENSIONS: '768',
      QDRANT_URL: 'http://localhost:6334',
      OLLAMA_URL: 'http://localhost:11434',
    },
    exec_mode: 'fork',
    autorestart: true,
    restart_delay: 4000,
    max_restarts: 15,
    min_uptime: '10s',
    max_memory_restart: '1200M',
    exp_backoff_restart_delay: 100,
    cron_restart: '0 4 * * *', // restart diário às 4h
    watch: false,
    kill_timeout: 10000,
    error_file: '/root/driago/logs/err.log',
    out_file: '/root/driago/logs/out.log',
    log_file: '/root/driago/logs/combined.log',
    time: true
  }]
};
