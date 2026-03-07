/**
 * tunnel.js - Start the LiveChat server + instant public URL via localhost.run
 * Run with:  npm run tunnel
 *
 * No account. No token. No install. Uses SSH (built into Windows 10/11).
 */

const os = require('os');
const { spawn, execSync } = require('child_process');
const { server } = require('./app-core');

const PORT = process.env.PORT || 3000;

// Kill whatever process is currently holding the port
function killPort(port) {
  try {
    if (process.platform === 'win32') {
      const out = execSync(`netstat -ano | findstr :${port} | findstr LISTENING`, { encoding: 'utf8' });
      out.trim().split('\n').forEach(line => {
        const pid = line.trim().split(/\s+/).pop();
        if (pid && pid !== '0') {
          try { execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' }); } catch {}
        }
      });
    } else {
      execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'ignore' });
    }
  } catch {}
}

function startListening() {
  server.listen(PORT, onListening);
}

function onListening() {
  const localIp = getLocalIp();
  let retryCount = 0;
  const MAX_RETRIES = 20;
  let currentSsh = null;
  let stopping = false;

  process.on('SIGINT', () => {
    stopping = true;
    if (currentSsh) currentSsh.kill();
    process.exit(0);
  });

  function startTunnel() {
    if (stopping) return;

    console.log('\nStarting public tunnel via localhost.run... (takes ~5 seconds)\n');

    // SSH reverse tunnel to localhost.run - no account, no install needed
    const ssh = spawn('ssh', [
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'ServerAliveCountMax=3',
      '-R', `80:localhost:${PORT}`,
      'nokey@localhost.run'
    ], { stdio: ['ignore', 'pipe', 'pipe'] });

    currentSsh = ssh;
    let urlPrinted = false;

    const handleOutput = (data) => {
      const text = data.toString();

      // localhost.run prints the real tunnel URL in its output.
      // Must NOT match admin.localhost.run (that's their website, not a tunnel).
      const match = text.match(/https?:\/\/[a-z0-9]{6,}\.lhr\.life/i)
                 || text.match(/https?:\/\/(?!admin\.)[a-z0-9][a-z0-9\-]{3,}\.localhost\.run/i);

      if (match && !urlPrinted) {
        urlPrinted = true;
        retryCount = 0; // reset on successful connection
        const publicUrl = match[0].replace(/[^a-z0-9\-.:\/]/gi, '');
        console.log('+---------------------------------------------------------------+');
        console.log('|            LiveChat -- Public Tunnel ACTIVE                   |');
        console.log('+---------------------------------------------------------------+');
        console.log(`|  Local:    http://localhost:${PORT}                                 |`);
        console.log(`|  Network:  http://${localIp}:${PORT}                             |`);
        console.log(`|  PUBLIC:   ${publicUrl.padEnd(54)} |`);
        console.log('+---------------------------------------------------------------+');
        console.log('|  Share the PUBLIC URL -- anyone anywhere can join instantly!  |');
        console.log('|  No WiFi needed. No account. Works from any device/country.   |');
        console.log('|  Press Ctrl+C to stop.                                        |');
        console.log('+---------------------------------------------------------------+\n');
      }
    };

    ssh.stdout.on('data', handleOutput);
    ssh.stderr.on('data', handleOutput);

    ssh.on('error', (err) => {
      console.error('\nCould not start SSH tunnel:', err.message);
      console.error('Make sure SSH is installed (it is built into Windows 10/11).\n');
      scheduleRetry();
    });

    ssh.on('close', (code) => {
      if (stopping) return;
      console.log(`\nTunnel disconnected (code ${code}). Reconnecting...\n`);
      scheduleRetry();
    });
  }

  function scheduleRetry() {
    if (stopping) return;
    retryCount++;
    if (retryCount > MAX_RETRIES) {
      console.error(`Failed to reconnect after ${MAX_RETRIES} attempts. Giving up.\n`);
      process.exit(1);
    }
    const delay = Math.min(5000 * retryCount, 60000); // 5s, 10s, ... up to 60s
    console.log(`Retry ${retryCount}/${MAX_RETRIES} in ${delay / 1000}s...\n`);
    setTimeout(startTunnel, delay);
  }

  startTunnel();
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.log(`Port ${PORT} in use — stopping it automatically...`);
    server.removeAllListeners('listening');
    killPort(PORT);
    setTimeout(startListening, 600);
  } else {
    console.error('Server error:', err.message);
    process.exit(1);
  }
});

startListening();

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}
