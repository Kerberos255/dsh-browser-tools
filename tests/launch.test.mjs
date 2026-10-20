import test from 'node:test';
import assert from 'node:assert/strict';
import { Connection, BrowserFailure } from '../lib/connection.js';
import { schema } from '../config.js';

/** Fake browser object good enough for connectOverCDP consumers. */
function fakeBrowser() {
  const closed = { value: false };
  return {
    closed,
    isConnected: () => !closed.value,
    on() {},
    contexts: () => [],
    close: async () => { closed.value = true; },
  };
}

/** Connection with injected spawn/probe/clock so no real browser is needed. */
function fixture({ probe, connect, config: overrides = {} } = {}) {
  const spawns = [], kills = [], timers = [];
  let time = 0, connectCalls = 0, probeCalls = 0;
  const config = {
    cdpUrl: 'http://127.0.0.1:18801',
    launch: true,
    launchExecutablePath: 'E:\\browser\\chrome.exe',
    launchUserDataDir: 'E:\\profile',
    launchArgsJson: '[]',
    launchTimeoutMs: 20000,
    idleExitMinutes: 30,
    actionTimeoutMs: 30000,
    ...overrides,
  };
  const connection = new Connection(() => config, {
    connect: connect ?? (async () => { connectCalls += 1; if (connectCalls === 1) throw new Error('connect-refused'); return fakeBrowser(); }),
    artifactsDir: async () => undefined,
    spawnProcess: (file, args, options) => { spawns.push({ file, args, options }); return { pid: 4242, exitCode: undefined, unref() {} }; },
    probe: probe ?? (async () => { probeCalls += 1; return probeCalls > 1; }),
    now: () => time,
    schedule: (run, ms) => { const timer = { run, ms, cancelled: false }; timers.push(timer); return timer; },
    cancel: timer => { if (timer) timer.cancelled = true; },
    kill: async pid => { kills.push(pid); },
  });
  return { connection, config, spawns, kills, timers, advance: ms => { time += ms; }, connectCalls: () => connectCalls };
}

/** Drive scheduled timers until the promise settles. */
async function drive(promise, timers, limit = 200) {
  let settled = false, failure = null;
  promise.then(() => { settled = true; }, error => { settled = true; failure = error; });
  for (let i = 0; i < limit && !settled; i++) {
    await Promise.resolve();
    const timer = timers.shift();
    if (timer && !timer.cancelled) timer.run();
  }
  if (!settled) throw new Error('driver stalled');
  if (failure) throw failure;
  return promise;
}

const signal = () => new AbortController().signal;

test('an instance already listening on the endpoint is reused, never launched', async () => {
  const f = fixture({ probe: async () => true });
  await f.connection.ensureLaunched(f.config);
  assert.equal(f.spawns.length, 0);
  assert.equal(f.connection.launchOwned, false);
});

test('a missing endpoint is launched with debugging flags and waited for', async () => {
  let probes = 0;
  const f = fixture({ probe: async () => ++probes > 2 });
  await drive(f.connection.ensureLaunched(f.config), f.timers);
  assert.equal(f.spawns.length, 1);
  const [spawn] = f.spawns;
  assert.equal(spawn.file, 'E:\\browser\\chrome.exe');
  assert.deepEqual(spawn.args.slice(0, 3), ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=18801', '--user-data-dir=E:\\profile']);
  assert.ok(spawn.args.includes('--no-first-run'));
  assert.ok(spawn.args.includes('--no-default-browser-check'));
  assert.equal(spawn.options.detached, true);
  assert.equal(f.connection.launchOwned, true);
});

test('connecting after a failed first attempt launches once and reports the live browser', async () => {
  const f = fixture();
  const browser = await drive(f.connection.ready(signal()), f.timers);
  assert.equal(browser.isConnected(), true);
  assert.equal(f.spawns.length, 1, 'first connect failed, so exactly one launch');
  assert.equal(f.connectCalls(), 2, 'one failed attempt plus one reconnect');
  assert.equal(f.timers.length > 0, true, 'an idle timer is armed for a launched instance');
});

test('broken launch settings fail closed with the reason instead of a silent retry', async () => {
  const f = fixture({ config: { launchExecutablePath: '' }, connect: async () => { throw new Error('connect-refused'); } });
  await assert.rejects(drive(f.connection.ready(signal()), f.timers), error => {
    assert.ok(error instanceof BrowserFailure);
    assert.equal(error.code, 'browser-unavailable');
    assert.match(error.message, /自动启动也未成功（launch-executable-missing）/);
    return true;
  });
  assert.equal(f.spawns.length, 0);
});

test('a launch that never becomes ready fails on the configured timeout', async () => {
  const f = fixture({ probe: async () => false, config: { launchTimeoutMs: 2000 } });
  const pending = f.connection.ensureLaunched(f.config);
  let settled = null;
  pending.then(() => { settled = 'resolved'; }, error => { settled = error.message; });
  for (let i = 0; i < 40 && settled === null; i++) {
    await Promise.resolve();
    const timer = f.timers.shift();
    if (!timer || timer.cancelled) continue;
    f.advance(500);
    timer.run();
    await Promise.resolve();
  }
  assert.equal(settled, 'launch-timeout');
});

test('concurrent tool calls share one launch attempt', async () => {
  let probes = 0;
  const f = fixture({ probe: async () => ++probes > 3 });
  const first = f.connection.ensureLaunched(f.config);
  const second = f.connection.ensureLaunched(f.config);
  await drive(Promise.all([first, second]), f.timers);
  assert.equal(f.spawns.length, 1);
});

test('an idle instance this plugin started is closed and its process tree killed', async () => {
  const f = fixture();
  await drive(f.connection.ready(signal()), f.timers);
  assert.equal(f.connection.launchOwned, true);
  const idleTimer = f.timers.find(timer => timer.ms === 60000);
  assert.ok(idleTimer, 'idle timer armed with the 60s check interval');
  f.advance(30 * 60000 + 1);
  idleTimer.run();
  for (let i = 0; i < 20 && f.kills.length === 0; i++) await Promise.resolve();
  assert.deepEqual(f.kills, [4242]);
  assert.equal(f.connection.launchOwned, false);
});

test('a user-started instance is never closed by the idle timer', async () => {
  const f = fixture({ probe: async () => true, connect: async () => fakeBrowser() });
  await drive(f.connection.ready(signal()), f.timers);
  assert.equal(f.connection.launchOwned, false);
  assert.equal(f.timers.length, 0, 'no idle timer for an instance we did not start');
});

test('idle exit can be disabled and manual mode keeps the old message', async () => {
  const f = fixture({ config: { idleExitMinutes: 0 } });
  await drive(f.connection.ready(signal()), f.timers);
  assert.equal(f.timers.length, 0, '0 minutes disables the idle timer');

  const manual = fixture({ config: { launch: false }, connect: async () => { throw new Error('connect-refused'); } });
  await assert.rejects(manual.connection.ready(signal()), error => {
    assert.match(error.message, /请用户手动启动 CloakBrowser/);
    return true;
  });
  assert.equal(manual.spawns.length, 0);
});

test('the new launch settings validate before they reach a spawn', () => {
  assert.equal(schema.validate({ launch: true }).launch, true);
  assert.equal(schema.validate({}).idleExitMinutes, 30, 'idle exit defaults to 30 minutes');
  assert.throws(() => schema.validate({ launch: 'yes' }), { code: 'invalid-config' });
  assert.throws(() => schema.validate({ launchArgsJson: '{"a":1}' }), { code: 'invalid-config' });
  assert.throws(() => schema.validate({ idleExitMinutes: -1 }), { code: 'invalid-config' });
  assert.throws(() => schema.validate({ idleExitMinutes: 1441 }), { code: 'invalid-config' });
  assert.throws(() => schema.validate({ launchTimeoutMs: 1000 }), { code: 'invalid-config' });
  assert.equal(schema.validate({ launchArgsJson: '["--lang=zh-CN"]' }).launchArgsJson, '["--lang=zh-CN"]');
});
