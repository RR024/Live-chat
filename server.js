const os = require('os');
const { server } = require('./app-core');


const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const localIp = getLocalIp();
  console.log('\n┌─────────────────────────────────────────────┐');
  console.log('│           LiveChat Server is RUNNING         │');
  console.log('├─────────────────────────────────────────────┤');
  console.log(`│  Local:    http://localhost:${PORT}              │`);
  console.log(`│  Network:  http://${localIp}:${PORT}          │`);
  console.log('├─────────────────────────────────────────────┤');
  console.log('│  Share the Network URL with anyone on        │');
  console.log('│  the same WiFi to let them join.             │');
  console.log('│                                              │');
  console.log('│  For internet access run:  npm run tunnel    │');
  console.log('└─────────────────────────────────────────────┘\n');
});

function getLocalIp() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}
