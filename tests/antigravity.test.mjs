import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { transform } from 'esbuild';

// Compile the provider in isolation. All credential, process and network I/O is mocked.
// Test-only exports leave the extension's public API unchanged.
const source = fs.readFileSync(new URL('../src/providers/antigravity.ts', import.meta.url), 'utf8');
const { code } = await transform(`${source}\nexport { loadAgyCliTokens, refreshAccessToken, loadCachedToken };`, {
  loader: 'ts', format: 'cjs', target: 'node18',
});
const oauthEnv = {
  USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID: 'test-client-id',
  USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET: 'test-client-secret',
};
const futureMs = Date.now() + 3600_000;
const agentAccount = { type: 'oauth', access: 'agent-access', refresh: 'agent-refresh', expires: futureMs };
const cloudModels = { models: { gemini: { displayName: 'Gemini Pro', quotaInfo: { remainingFraction: 0.8 } } } };
const jsonResponse = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => data });
const plain = (value) => JSON.parse(JSON.stringify(value));

function harness(options = {}) {
  const calls = { reads: [], writes: [], removed: [], processes: [], fetches: [], db: [] };
  const fakeFs = {
    readFileSync(file) {
      calls.reads.push(file);
      if (options.agentError) throw new Error('unreadable');
      return options.agentRaw ?? JSON.stringify(options.agent ?? {});
    },
    existsSync(file) { return file === '/ide/state.vscdb' ? Boolean(options.dbRaw) : Boolean(options.windows); },
    mkdtempSync(prefix) { return `${prefix}unique`; },
    writeFileSync(...args) { calls.writes.push(args); if (options.writeError) throw new Error('write failed'); },
    rmSync(...args) { calls.removed.push(args); },
  };
  const childProcess = {
    execSync() { return ''; },
    execFileSync(executable, args, config) {
      calls.processes.push({ executable, args, config });
      if (args.includes('-Command')) {
        if (!options.ls) return '[]';
        return args.at(-1).includes('Get-CimInstance')
          ? JSON.stringify({ CommandLine: 'language_server antigravity --csrf_token abcdefgh --extension_server_port 12346', ProcessId: 123 })
          : '[12345]';
      }
      if (options.cliError) throw new Error('credential read failed');
      return options.cliRaw ?? JSON.stringify(options.cli ?? {});
    },
  };
  const fakeHttp = {
    request(config, callback) {
      const request = new EventEmitter();
      request.write = () => {};
      request.destroy = (error) => request.emit('error', error);
      request.end = () => queueMicrotask(() => {
        const response = new EventEmitter();
        response.statusCode = 200;
        response.setEncoding = () => {};
        callback(response);
        response.emit('data', JSON.stringify({ userStatus: {
          cascadeModelConfigData: { clientModelConfigs: [{ label: 'Gemini Pro', quotaInfo: { remainingFraction: 0.8 } }] },
        } }));
        response.emit('end');
      });
      return request;
    },
  };
  const modules = {
    fs: fakeFs, os: { homedir: () => '/fake-home', tmpdir: () => '/fake-temp' }, path,
    child_process: childProcess, http: fakeHttp, https: fakeHttp,
    vscode: { workspace: { getConfiguration: () => ({ get: () => options.enabled !== false }) } },
    '../util/platform': { getAntigravityDbPath: () => options.dbRaw ? '/ide/state.vscdb' : null },
    '../util/sqlite': { readDbValue: (...args) => { calls.db.push(args); return options.dbRaw; } },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports,
    require(name) { assert.ok(Object.hasOwn(modules, name), `Unexpected import: ${name}`); return modules[name]; },
    process: { platform: options.windows ? 'win32' : 'linux', env: { ...(options.windows ? { WINDIR: 'C:\\Windows' } : {}), ...options.env } },
    Buffer, URL, URLSearchParams, AbortSignal, console,
    fetch: async (url, config) => {
      calls.fetches.push({ url, config });
      return options.fetch ? options.fetch(url, config) : jsonResponse(cloudModels);
    },
  });
  return { ...module.exports, calls };
}

// Minimal protobuf envelope matching the IDE's double-base64 OAuth state.
function ideTokens(access, refresh = '') {
  const field = (number, data) => {
    const buffer = Buffer.from(data);
    assert.ok(buffer.length < 128);
    return Buffer.concat([Buffer.from([number * 8 + 2, buffer.length]), buffer]);
  };
  const inner = Buffer.concat([field(1, access), field(3, refresh)]).toString('base64');
  const wrapper = Buffer.concat([field(1, 'oauthTokenInfoSentinelKey'), field(2, field(1, inner))]);
  return field(1, wrapper).toString('base64');
}

test('agent cache selects the active account, converts milliseconds, and avoids subprocesses', () => {
  const h = harness({ windows: true, agent: { activeAccountId: 'second', accounts: { first: { access: 'wrong' }, second: agentAccount } } });
  assert.deepEqual(plain(h.loadAgyCliTokens()), {
    accessToken: 'agent-access', refreshToken: 'agent-refresh', expirySeconds: Math.floor(futureMs / 1000),
  });
  assert.equal(h.calls.processes.length, 0);
  assert.equal(h.calls.writes.length, 0);
  assert.equal(h.calls.reads[0], path.join('/fake-home', '.pi', 'agent', 'antigravity-accounts.json'));
});

test('agent cache uses the first account when no active account is selected', () => {
  const h = harness({ agent: { accounts: { first: agentAccount, second: { access: 'wrong' } } } });
  assert.equal(h.loadAgyCliTokens().accessToken, 'agent-access');
});

for (const [label, options] of Object.entries({
  missing: { agentError: true }, malformed: { agentRaw: '{' }, null: { agentRaw: 'null' },
  empty: {}, array: { agent: { accounts: [] } },
  'wrong token types': { agent: { accounts: { first: { access: 123, refresh: {} } } } },
  'empty tokens': { agent: { accounts: { first: { access: '  ', refresh: '' } } } },
  'non-OAuth account': { agent: { accounts: { first: { type: 'api_key', access: 'wrong' } } } },
  'missing active account': { agent: { activeAccountId: 'missing', accounts: { first: agentAccount } } },
})) {
  test(`${label} agent cache is unavailable and spawns nothing on Unix`, () => {
    const h = harness(options);
    assert.equal(h.loadAgyCliTokens(), null);
    assert.equal(h.calls.processes.length, 0);
  });
}

test('refresh-only agent credentials and unknown expiry are supported', () => {
  const h = harness({ agent: { accounts: { first: { refresh: 'refresh', expires: 'invalid' } } } });
  assert.deepEqual(plain(h.loadAgyCliTokens()), { accessToken: null, refreshToken: 'refresh', expirySeconds: null });
});

const cli = { auth_method: 'oauth', token: { access_token: 'cli-access', refresh_token: 'cli-refresh', expiry: '2030-01-02T03:04:05Z' } };
test('Windows fallback parses CLI tokens and safely executes and cleans up the script', () => {
  const h = harness({ windows: true, agentRaw: '{', cli });
  assert.deepEqual(plain(h.loadAgyCliTokens()), {
    accessToken: 'cli-access', refreshToken: 'cli-refresh', expirySeconds: Date.parse(cli.token.expiry) / 1000,
  });
  const { executable, args, config } = h.calls.processes[0];
  assert.match(executable, /WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  assert.deepEqual(Array.from(args).slice(0, 3), ['-NoProfile', '-NonInteractive', '-File']);
  assert.equal(args.at(-1), h.calls.writes[0][0]);
  assert.ok(!args.includes('-EncodedCommand') && !args.includes('Bypass'));
  assert.equal(config.windowsHide, true);
  assert.equal(config.timeout, 5000);
  assert.equal(config.maxBuffer, 64 * 1024);
  assert.match(h.calls.writes[0][1], /gemini:antigravity/);
  assert.match(h.calls.writes[0][1], /CredFree\(pointer\)/);
  assert.ok(!h.calls.writes[0][1].includes('cli-access'));
  assert.equal(h.calls.removed.length, 1);
  assert.equal(path.dirname(args.at(-1)), h.calls.removed[0][0]);
});

for (const [label, options] of Object.entries({
  'subprocess failure': { cliError: true }, 'script write failure': { writeError: true },
  'invalid JSON': { cliRaw: 'bad' }, 'no credential': { cliRaw: '' },
  'non-OAuth credential': { cli: { ...cli, auth_method: 'api_key' } },
  'no tokens': { cli: { auth_method: 'oauth', token: {} } },
})) {
  test(`Windows ${label} returns null and cleans up`, () => {
    const h = harness({ windows: true, ...options });
    assert.equal(h.loadAgyCliTokens(), null);
    assert.equal(h.calls.removed.length, 1);
  });
}

test('Windows accepts a UTF-8 BOM and treats invalid expiry as unknown', () => {
  const h = harness({ windows: true, cliRaw: '\uFEFF' + JSON.stringify({ ...cli, token: { ...cli.token, expiry: 'bad' } }) });
  assert.equal(h.loadAgyCliTokens().expirySeconds, null);
});

test('disabled provider performs no I/O', async () => {
  const h = harness({ enabled: false });
  await assert.rejects(h.probeAntigravity(), /Enable Antigravity/);
  assert.equal(h.calls.reads.length + h.calls.processes.length + h.calls.fetches.length, 0);
});

test('running IDE language server wins without reading credential stores', async () => {
  const h = harness({ windows: true, ls: true, dbRaw: ideTokens('ide-access'), agent: { accounts: { first: agentAccount } } });
  assert.ok((await h.probeAntigravity()).lines.length > 0);
  assert.equal(h.calls.db.length + h.calls.reads.length + h.calls.fetches.length, 0);
  assert.ok(h.calls.processes.every(({ args }) => !args.includes('Bypass')));
});

test('IDE database tokens win over agent credentials', async () => {
  const h = harness({ dbRaw: ideTokens('ide-access'), agent: { accounts: { first: agentAccount } } });
  assert.ok((await h.probeAntigravity()).lines.length > 0);
  assert.equal(h.calls.reads.length, 0);
  assert.equal(h.calls.fetches[0].config.headers.Authorization, 'Bearer ide-access');
});

for (const dbRaw of [undefined, 'malformed-db']) {
  test(`agent quota works with ${dbRaw ? 'tokenless' : 'absent'} IDE database`, async () => {
    const h = harness({ dbRaw, agent: { accounts: { first: agentAccount } } });
    assert.ok((await h.probeAntigravity()).lines.length > 0);
    assert.equal(h.calls.fetches[0].config.headers.Authorization, 'Bearer agent-access');
  });
}

test('CLI quota works without an installed IDE', async () => {
  const h = harness({ windows: true, cli });
  assert.ok((await h.probeAntigravity()).lines.length > 0);
  assert.equal(h.calls.fetches[0].config.headers.Authorization, 'Bearer cli-access');
});

test('expired access-only agent cache falls through to valid Windows CLI credentials', async () => {
  const h = harness({ windows: true, cli, agent: { accounts: { first: { access: 'expired', expires: 1 } } } });
  assert.ok((await h.probeAntigravity()).lines.length > 0);
  assert.ok(h.calls.processes.some(({ args }) => args.includes('-File')));
  assert.equal(h.calls.fetches[0].config.headers.Authorization, 'Bearer cli-access');
});

test('expired access-only agent cache is unavailable on Unix', () => {
  const h = harness({ agent: { accounts: { first: { access: 'expired', expires: 1 } } } });
  assert.equal(h.loadAgyCliTokens(), null);
  assert.equal(h.calls.processes.length, 0);
});

test('unexpired access-only agent credentials retain priority over Windows CLI', () => {
  const h = harness({ windows: true, cli, agent: { accounts: { first: { access: 'valid', expires: futureMs } } } });
  assert.equal(h.loadAgyCliTokens().accessToken, 'valid');
  assert.equal(h.calls.processes.length, 0);
});

test('absent credentials produce an actionable error', async () => {
  const h = harness();
  await assert.rejects(h.probeAntigravity(), /Antigravity \/ AGY CLI not installed or signed in/);
  assert.equal(h.calls.fetches.length, 0);
});

for (const expires of [0, Date.now() - 1000]) {
  test(`expired agent token (${expires === 0 ? 'zero' : 'past'}) refreshes with configured OAuth client`, async () => {
    const h = harness({
      env: oauthEnv,
      agent: { accounts: { first: { ...agentAccount, expires } } },
      fetch: (url) => jsonResponse(url.endsWith('/token') ? { access_token: 'renewed', expires_in: 3600 } : cloudModels),
    });
    assert.ok((await h.probeAntigravity()).lines.length > 0);
    const body = h.calls.fetches[0].config.body;
    assert.equal(body.get('client_id'), oauthEnv.USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID);
    assert.equal(body.get('client_secret'), oauthEnv.USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET);
    assert.equal(body.get('refresh_token'), 'agent-refresh');
    assert.equal(h.calls.fetches[1].config.headers.Authorization, 'Bearer renewed');
  });
}

for (const [label, env] of Object.entries({
  missing: {},
  'missing ID': { USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET: 'test-client-secret' },
  'missing secret': { USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID: 'test-client-id' },
  'blank ID': { ...oauthEnv, USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID: '  ' },
  'blank secret': { ...oauthEnv, USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET: '  ' },
})) {
  test(`${label} OAuth client configuration skips refresh without network I/O`, async () => {
    const h = harness({ env });
    assert.equal(await h.refreshAccessToken('refresh'), null);
    assert.equal(h.calls.fetches.length, 0);
    assert.equal(h.loadCachedToken('refresh'), null);
  });
}

test('OAuth client configuration is trimmed and cached tokens are account-scoped', async () => {
  const h = harness({
    env: { USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_ID: ' custom-id ', USAGEDOCK_ANTIGRAVITY_GOOGLE_CLIENT_SECRET: ' custom-secret ' },
    fetch: () => jsonResponse({ access_token: 'renewed', expires_in: 3600 }),
  });
  assert.equal(await h.refreshAccessToken('refresh-one'), 'renewed');
  assert.equal(h.calls.fetches[0].config.body.get('client_id'), 'custom-id');
  assert.equal(h.calls.fetches[0].config.body.get('client_secret'), 'custom-secret');
  assert.equal(h.loadCachedToken('refresh-one'), 'renewed');
  assert.equal(h.loadCachedToken('refresh-two'), null);
  assert.equal(h.loadCachedToken(null), null);
});

test('401 quota response refreshes and retries', async () => {
  const h = harness({ env: oauthEnv, agent: { accounts: { first: agentAccount } }, fetch: (url, config) => {
    if (url.endsWith('/token')) return jsonResponse({ access_token: 'renewed', expires_in: 3600 });
    return config.headers.Authorization === 'Bearer agent-access' ? jsonResponse({}, 401) : jsonResponse(cloudModels);
  } });
  assert.ok((await h.probeAntigravity()).lines.length > 0);
  assert.equal(h.calls.fetches.length, 3);
});

for (const [label, fetch] of Object.entries({
  rejected: () => jsonResponse({}, 400), malformed: () => jsonResponse({}),
  network: () => { throw new Error('network'); },
})) {
  test(`${label} OAuth refresh fails without caching a token`, async () => {
    const h = harness({ env: oauthEnv, fetch });
    assert.equal(await h.refreshAccessToken('refresh'), null);
    assert.equal(h.loadCachedToken('refresh'), null);
  });
}
