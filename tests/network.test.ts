import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import {
  buildNetworkInfo,
  DEFAULT_PORT,
  detectTailscaleInfo,
  findSafePort,
  parsePortSpec,
  PRIVILEGED_WEB_PORTS,
  resolvePortSpec,
} from '../src/server/network.ts';

test('findSafePort avoids ports 80 and 443 and auto-steps past occupied ports', async () => {
  const from80 = await findSafePort(80, '127.0.0.1');
  assert.ok(from80 >= DEFAULT_PORT);
  assert.equal(PRIVILEGED_WEB_PORTS.has(from80), false);

  const from443 = await findSafePort(443, '127.0.0.1');
  assert.ok(from443 >= DEFAULT_PORT);
  assert.equal(PRIVILEGED_WEB_PORTS.has(from443), false);

  // Bind an ephemeral port, then verify findSafePort avoids it
  const blocker = net.createServer();
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
  const addr = blocker.address();
  assert.ok(addr && typeof addr === 'object');
  const occupiedPort = addr.port;

  try {
    const resolved = await findSafePort(occupiedPort, '127.0.0.1');
    assert.notEqual(resolved, occupiedPort);
    assert.ok(resolved > occupiedPort);
  } finally {
    await new Promise<void>((resolve) => blocker.close(() => resolve()));
  }
});

test('parsePortSpec parses single, list, range, mixed, auto, and off specs', () => {
  assert.deepEqual(parsePortSpec('off'), { mode: 'disabled', raw: 'off' });
  assert.deepEqual(parsePortSpec('none'), { mode: 'disabled', raw: 'none' });
  assert.deepEqual(parsePortSpec('auto'), { mode: 'auto', raw: 'auto' });
  assert.deepEqual(parsePortSpec(0), { mode: 'auto', raw: '0' });

  assert.deepEqual(parsePortSpec('7745'), {
    mode: 'candidates',
    raw: '7745',
    candidates: [7745],
    hasRange: false,
  });

  assert.deepEqual(parsePortSpec('7745, 8080, 7745, 9000'), {
    mode: 'candidates',
    raw: '7745, 8080, 7745, 9000',
    candidates: [7745, 8080, 9000],
    hasRange: false,
  });

  assert.deepEqual(parsePortSpec('8000-8002, 9000'), {
    mode: 'candidates',
    raw: '8000-8002, 9000',
    candidates: [8000, 8001, 8002, 9000],
    hasRange: true,
  });

  assert.throws(() => parsePortSpec(''));
  assert.throws(() => parsePortSpec('8010-8000'));
  assert.throws(() => parsePortSpec('70000'));
  assert.throws(() => parsePortSpec('abc'));
});

test('resolvePortSpec handles candidate lists, ranges, strict mode, excluded ports, and allowPrivileged', async () => {
  const busy = new Set([7745, 8000, 8001]);
  const isAvailable = async (port: number) => !busy.has(port);

  // Candidate list picks first free port
  const fromList = await resolvePortSpec('7745,8080,9000', { isAvailable });
  assert.equal(fromList, 8080);

  // Range skips busy ports and picks within range
  const fromRange = await resolvePortSpec('8000-8005', { isAvailable });
  assert.equal(fromRange, 8002);

  // Range fails if all ports in range are busy (does not escape range)
  await assert.rejects(() => resolvePortSpec('8000-8001', { isAvailable }));

  // Exclude ports avoids colliding with another active service
  const excluded = await resolvePortSpec('8000-8005', {
    isAvailable,
    excludePorts: new Set([8002]),
  });
  assert.equal(excluded, 8003);

  // Strict mode rejects occupied single port instead of auto-stepping
  await assert.rejects(() => resolvePortSpec('7745', { isAvailable, strict: true }));

  // Privileged port rejected by default, permitted with allowPrivileged
  const privilegedAllowed = await resolvePortSpec('80', {
    isAvailable,
    allowPrivileged: true,
    strict: true,
  });
  assert.equal(privilegedAllowed, 80);

  // Auto mode avoids excluded ports
  let nextEphemeral = 40000;
  const ephemeralPort = await resolvePortSpec('auto', {
    excludePorts: new Set([40000]),
    getEphemeral: async () => nextEphemeral++,
  });
  assert.equal(ephemeralPort, 40001);

  // Disabled returns null
  assert.equal(await resolvePortSpec('off', { isAvailable }), null);
});

test('buildNetworkInfo & detectTailscaleInfo reflect custom clientPort and tailscalePort', async () => {
  const tsCustom = await detectTailscaleInfo(8080, 9443);
  assert.equal(tsCustom.servePort, 9443);
  assert.equal(tsCustom.serveCommand, 'tailscale serve --bg --https=9443 http://127.0.0.1:8080');

  const tsOff = await detectTailscaleInfo(8080, null);
  assert.equal(tsOff.servePort, null);
  assert.equal(tsOff.serveCommand, '');

  const info = await buildNetworkInfo(8080, '0.0.0.0', false, '', {
    clientPort: 3000,
    tailscalePort: 9443,
  });
  assert.equal(info.port, 8080);
  assert.equal(info.clientPort, 3000);
  assert.equal(info.localUrl, 'http://localhost:3000');
  assert.equal(info.tailscale.servePort, 9443);
  assert.equal(info.avoidsPrivilegedPorts, true);

  const loopbackInfo = await buildNetworkInfo(8001, '127.0.0.1', false, '', {
    tailscalePort: 8443,
  });
  assert.equal(loopbackInfo.port, 8001);
  assert.deepEqual(loopbackInfo.lanUrls, []);
  assert.equal(loopbackInfo.tailscale.tailscaleUrl, null);
  assert.equal(loopbackInfo.tailscale.servePort, 8443);
});
