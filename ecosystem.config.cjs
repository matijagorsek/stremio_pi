module.exports = {
  apps: [
    {
      name: "stremio-pi",
      script: "./backend/src/server.js",
      cwd: "/home/jarvis/stremio_pi",
      interpreter: "node",
      env: {
        NODE_ENV: "production",
        PORT: 3000,
      },
      watch: false,
      max_memory_restart: "500M",
      restart_delay: 3000,
    },
  ],
};
