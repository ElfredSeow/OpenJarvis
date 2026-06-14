// cdp.test.js — the dynamic-CDP acquisition ladder.
//
// Verifies that the engine reuses an existing CDP, launches one when free, and
// — the new behaviour — OPENS ANOTHER CDP ON ITS OWN (a dedicated instance on a
// free port) when the preferred port is busy. The browser/launch/probe seams
// are injected so no real Edge is spawned.

import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';

import { findFreePort, isCdpEndpointAvailable, waitForCdpEndpoint, buildEdgeLaunchArgs, acquireEdgeBrowser } from '../attach.js';

const fakeBrowser = { browser: { isConnected: () => true, contexts: () => [{}] } };

test('findFreePort returns a usable, bindable port', async () => {
  const port = await findFreePort();
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, `got ${port}`);
});

test('isCdpEndpointAvailable / waitForCdpEndpoint probe the given port', async () => {
  // A fake "CDP" that answers /json/version like Edge does.
  const srv = createServer((req, res) => {
    if (req.url === '/json/version') { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"Browser":"fake"}'); }
    else { res.writeHead(404); res.end(); }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  try {
    assert.equal(await isCdpEndpointAvailable(port), true);
    assert.equal(await waitForCdpEndpoint({ port, attempts: 2, delayMs: 50 }), true);
    const freeButClosed = await findFreePort();
    assert.equal(await isCdpEndpointAvailable(freeButClosed), false);
  } finally { srv.close(); }
});

test('buildEdgeLaunchArgs adds a dedicated user-data-dir + port when given', () => {
  assert.deepEqual(buildEdgeLaunchArgs('Default'), [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9222', '--profile-directory=Default',
  ]);
  assert.deepEqual(buildEdgeLaunchArgs('Default', { port: 9444, userDataDir: 'C:/tmp/jarvis' }), [
    '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9444', '--profile-directory=Default', '--user-data-dir=C:/tmp/jarvis',
  ]);
});

test('REUSES an existing CDP on the preferred port (no launch)', async () => {
  let launched = 0;
  const res = await acquireEdgeBrowser({
    profileDirectory: 'Default', preferredPort: 9222,
    probe: async () => true,
    launch: () => { launched++; },
    attach: async () => fakeBrowser,
    waitFor: async () => true,
    freePort: async () => 9999,
  });
  assert.equal(res.mode, 'reused');
  assert.equal(res.port, 9222);
  assert.equal(launched, 0);
});

test('LAUNCHES the remembered profile when the preferred port is free', async () => {
  const launches = [];
  const res = await acquireEdgeBrowser({
    profileDirectory: 'Default', preferredPort: 9222,
    probe: async () => false,
    launch: (dir, opts) => launches.push({ dir, opts }),
    waitFor: async ({ port }) => port === 9222,
    attach: async () => fakeBrowser,
    freePort: async () => 9999,
  });
  assert.equal(res.mode, 'launched');
  assert.equal(res.port, 9222);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].opts.port, 9222);
  assert.equal(launches[0].opts.userDataDir, undefined);
});

test('OPENS ANOTHER CDP on its own when the preferred port is busy', async () => {
  const launches = [];
  let waits = 0;
  const res = await acquireEdgeBrowser({
    profileDirectory: 'Default', preferredPort: 9222, dedicatedUserDataDir: 'C:/tmp/jarvis-edge',
    probe: async () => false,                 // nothing to reuse
    launch: (dir, opts) => launches.push({ dir, opts }),
    waitFor: async ({ port }) => { waits++; return port !== 9222; }, // preferred never opens; fallback does
    attach: async () => fakeBrowser,
    freePort: async () => 9444,
  });
  assert.equal(res.mode, 'dedicated');
  assert.equal(res.port, 9444);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].opts.port, 9222);                       // first tried preferred
  assert.equal(launches[1].opts.port, 9444);                       // then a free port
  assert.equal(launches[1].opts.userDataDir, 'C:/tmp/jarvis-edge'); // separate instance
});

test('errors clearly when no profile is remembered and nothing is reusable', async () => {
  await assert.rejects(
    () => acquireEdgeBrowser({ profileDirectory: undefined, probe: async () => false }),
    /No Edge profile remembered/,
  );
});
