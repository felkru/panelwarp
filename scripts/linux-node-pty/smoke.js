// Starts server.js, opens a shell over its WebSocket and checks bash runs a command.
const { startServer } = require('./server');
const WebSocket = require('ws');
(async () => {
  const srv = await startServer({ bundleDir: __dirname + '/bundle', token: 't', shell: '/bin/bash', log: (m) => console.log('server:', m) });
  const ws = new WebSocket(`${srv.ptyBaseUrl}&shell=bash&shell_path=%2Fbin%2Fbash&num_cols=80&num_rows=24`);
  let out = '';
  const timer = setTimeout(() => { console.log('FAIL, output:', JSON.stringify(out.slice(-500))); process.exit(1); }, 15000);
  ws.on('message', (data, binary) => {
    if (!binary) return;
    out += data.toString();
    if (out.includes('smoke-ok-42')) { clearTimeout(timer); console.log('SMOKE OK', process.platform, process.arch); process.exit(0); }
  });
  ws.on('open', () => setTimeout(() => ws.send(Buffer.from('echo smoke-ok-$((40+2))\r')), 1500));
})();
