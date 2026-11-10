const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const { WebSocket, WebSocketServer } = require('ws');
const { startServer } = require('../server');

// Control messages are text frames and shell bytes are binary ones, so each is kept with its type
const frame = (data, isBinary) => [data.toString(), isBinary];

test("a shell handed over by the previous build's PTY host reaches the page whole", { timeout: 10000 }, async (t) => {
  const handover = [
    JSON.stringify({ adopt: { session: 'abc', session_ids: ['42'], running: false } }),
    Buffer.from('bootstrap'),
    Buffer.from('prompt'),
    JSON.stringify('adopted'),
  ];
  // The previous host still has the pane's shell: it sends the whole handover at once, like
  // `adopt` in server.js, then the shell's output once the page has sent its size
  const previous = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  let server;
  let page;
  t.after(() => {
    page?.terminate();
    for (const client of previous.clients) client.terminate();
    previous.close();
    server?.close();
  });
  await once(previous, 'listening');
  const fromPage = [];
  previous.on('connection', (ws) => {
    for (const message of handover) ws.send(message);
    ws.on('message', (data, isBinary) => {
      fromPage.push(frame(data, isBinary));
      ws.send(Buffer.from('later output'));
    });
  });
  server = await startServer({
    bundleDir: __dirname,
    token: 'f'.repeat(64),
    log: () => {},
    previousHosts: [{ pid: process.pid, ptyBaseUrl: `ws://127.0.0.1:${previous.address().port}/create` }],
  });
  page = new WebSocket(`${server.ptyBaseUrl}&shell=zsh&pane=abc123`);

  const size = JSON.stringify({ width: 80, height: 24 });
  page.on('open', () => page.send(size));
  const received = [];
  await new Promise((resolve) => {
    page.on('message', (data, isBinary) => {
      received.push(frame(data, isBinary));
      if (data.toString() === 'later output') resolve();
    });
  });

  assert.deepEqual(received, [
    [handover[0], false],
    ['bootstrap', true],
    ['prompt', true],
    ['"adopted"', false],
    ['later output', true],
  ]);
  assert.deepEqual(fromPage, [[size, false]]);
});
