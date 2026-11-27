const path = require('node:path');

module.exports = {
  apps: [
    {
      name: 'gitdock-web',
      cwd: __dirname,
      script: path.join(__dirname, 'scripts', 'pm2-entry.mjs'),
      args: '--ensure-build',
      interpreter: process.execPath,
      exec_mode: 'fork',
      instances: 1,
      autorestart: true,
      watch: false,
      windowsHide: true,
      min_uptime: '5s',
      max_restarts: 10,
      restart_delay: 2000,
      max_memory_restart: '512M',
      kill_timeout: 5000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        // Default matches Tailscale Serve redirect: https://<machine>.ts.net:8443 -> http://127.0.0.1:8001
        // Set GITWEB_HOST=0.0.0.0 and GITWEB_PORT=7745 if you also want direct LAN Wi-Fi access.
        GITWEB_HOST: process.env.GITWEB_HOST || '127.0.0.1',
        GITWEB_PORT: process.env.GITWEB_PORT || '8001',
        GITWEB_STRICT_PORT: process.env.GITWEB_STRICT_PORT || '1',
        GITWEB_TAILSCALE_PORT: process.env.GITWEB_TAILSCALE_PORT || '8443',
      },
    },
  ],
};
