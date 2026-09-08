module.exports = {
  apps: [
    {
      name: 'torrserver',
      script: './TorrServer-linux-amd64',
      exec_mode: 'fork',
      interpreter: 'none',
      autorestart: true,
      max_memory_restart: '500M'
    },
    {
      name: 'animflix',
      script: './animflix.js',
      exec_mode: 'fork',
      autorestart: true,
      max_memory_restart: '300M',
      env: {
        NODE_ENV: 'production'
      }
    }
  ]
};
