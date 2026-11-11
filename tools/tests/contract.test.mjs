import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { busyPorts } from '../contract.mjs';

test('busyPorts names a port someone else listens on, and nothing else', async () => {
  const srv = net.createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  try {
    assert.deepEqual(await busyPorts([port]), [port]);
  } finally {
    await new Promise((r) => srv.close(r));
  }
  assert.deepEqual(await busyPorts([port]), []);
});
