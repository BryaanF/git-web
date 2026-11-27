import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseRunnerArgs, resolveRunnerPlan } from '../scripts/runner-core.ts';

test('parseRunnerArgs supports per-service port specs, aliases, = syntax, and env defaults', () => {
  const cli = parseRunnerArgs([
    '--server-port=8080,8081',
    '--client-port',
    '3000-3005',
    '--tailscale-port',
    '9443',
    '--host',
    '127.0.0.1',
    '--strict-port',
    '--no-auth',
    '--workspace-root',
    'C:\\projects',
    '--repo',
    'C:\\projects\\demo',
  ]);

  assert.equal(cli.mode, 'dev');
  assert.equal(cli.enableServer, true);
  assert.equal(cli.enableClient, true);
  assert.equal(cli.serverPortSpec, '8080,8081');
  assert.equal(cli.clientPortSpec, '3000-3005');
  assert.equal(cli.tailscalePort, 9443);
  assert.equal(cli.host, '127.0.0.1');
  assert.equal(cli.strictPort, true);
  assert.equal(cli.noAuth, true);
  assert.equal(cli.workspaceRoot, 'C:\\projects');
  assert.deepEqual(cli.repoPaths, ['C:\\projects\\demo']);

  const envParsed = parseRunnerArgs([], {
    GITWEB_SERVER_PORT: '9100',
    GITWEB_CLIENT_PORT: 'off',
    GITWEB_TAILSCALE_PORT: 'off',
    GITWEB_STRICT_PORT: '1',
  });
  assert.equal(envParsed.enableServer, true);
  assert.equal(envParsed.enableClient, false);
  assert.equal(envParsed.serverPortSpec, '9100');
  assert.equal(envParsed.tailscalePort, null);
  assert.equal(envParsed.strictPort, true);

  assert.throws(() => parseRunnerArgs(['--unknown-flag']));
  assert.throws(() => parseRunnerArgs(['--services', 'server', '--server-port', 'off']));
});

test('resolveRunnerPlan coordinates ports between services and wires Vite proxy to resolved server port', async () => {
  const busy = new Set([8000, 8002]);
  const isAvailable = async (port: number) => !busy.has(port);

  // Overlapping ranges: server gets 8001 (since 8000 is busy), client must avoid 8001 and 8002 -> gets 8003
  const options = parseRunnerArgs([
    '--server-port',
    '8000-8005',
    '--client-port',
    '8000-8005',
    '--tailscale-port',
    '9443',
  ]);

  const plan = await resolveRunnerPlan(options, { isAvailable });

  assert.equal(plan.server.enabled, true);
  assert.equal(plan.server.port, 8001);
  assert.equal(plan.client.enabled, true);
  assert.equal(plan.client.port, 8003);
  assert.equal(plan.client.apiTarget, 'http://127.0.0.1:8001');
  assert.equal(plan.client.env.GITWEB_API_TARGET, 'http://127.0.0.1:8001');
  assert.equal(plan.client.env.GITWEB_CLIENT_PORT, '8003');
  assert.equal(plan.server.env.GITWEB_CLIENT_PORT, '8003');
  assert.equal(plan.server.env.GITWEB_SERVER_PORT, '8001');
  assert.equal(plan.server.env.GITWEB_TAILSCALE_PORT, '9443');
  assert.ok(plan.server.args.includes('--port'));
  assert.ok(plan.server.args.includes('8001'));
  assert.ok(plan.client.args.includes('--port'));
  assert.ok(plan.client.args.includes('8003'));
  assert.ok(plan.client.args.includes('--strictPort'));
});

test('resolveRunnerPlan supports server-only, client-only with proxy-port, and start mode', async () => {
  const isAvailable = async () => true;

  const serverOnly = await resolveRunnerPlan(
    parseRunnerArgs([
      '--services',
      'server',
      '--port',
      '9000',
      '--tailscale-port',
      'off',
      '--workspace-root',
      'C:\\projects',
    ]),
    { isAvailable },
  );
  assert.equal(serverOnly.server.enabled, true);
  assert.equal(serverOnly.server.port, 9000);
  assert.equal(serverOnly.client.enabled, false);
  assert.equal(serverOnly.client.port, null);
  assert.equal(serverOnly.tailscalePort, null);
  assert.equal(serverOnly.server.env.GITWEB_WORKSPACE_ROOT, 'C:\\projects');
  assert.ok(serverOnly.server.args.includes('--workspace-root'));

  const clientOnly = await resolveRunnerPlan(
    parseRunnerArgs(['--services', 'client', '--client-port', '4000', '--proxy-port', '9000']),
    { isAvailable },
  );
  assert.equal(clientOnly.server.enabled, false);
  assert.equal(clientOnly.client.enabled, true);
  assert.equal(clientOnly.client.port, 4000);
  assert.equal(clientOnly.client.apiTarget, 'http://127.0.0.1:9000');
  assert.equal(clientOnly.client.env.GITWEB_SERVER_PORT, '9000');

  const startMode = await resolveRunnerPlan(
    parseRunnerArgs(['--mode', 'start', '--port', '8080']),
    { isAvailable },
  );
  assert.equal(startMode.mode, 'start');
  assert.equal(startMode.watch, false);
  assert.equal(startMode.server.enabled, true);
  assert.equal(startMode.client.enabled, false);
  assert.deepEqual(startMode.server.args.slice(0, 1), ['src/server/index.ts']);
});
