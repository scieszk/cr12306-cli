import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after } from 'node:test';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = new URL('./fixtures/mock-fetch.mjs', import.meta.url).href;
const temporary = mkdtempSync(join(tmpdir(), 'cr12306-cli-test-'));
after(() => rmSync(temporary, { recursive: true, force: true }));
const fixtureEnv = { ...process.env, CR12306_PREFERENCES: join(temporary, 'preferences.json') };
const cli = (...args) => spawnSync(process.execPath, ['--import', fixture, cliPath, ...args], { encoding: 'utf8', timeout: 5_000, env: fixtureEnv });
const cliWithFetch = (mode, ...args) => spawnSync(process.execPath, ['--import', fixture, cliPath, ...args], {
  encoding: 'utf8', timeout: 5_000, env: { ...fixtureEnv, CR12306_TEST_FETCH: mode },
});

for (const args of [
  ['stations', '不存在', '--json'],
  ['query', '甲站', '乙站', '2030-01-01', '--json'],
  ['transfer', '甲站', '乙站', '2030-01-01', '--json'],
  ['transfer', '甲站', '乙站', '2030-01-01', '--smart', '--middle', '丙站', '--json'],
  ['sale-time', '甲站', '--json'],
  ['route', 'G1', '2030-01-01', '--json'],
]) {
  test(`${args[0]} ${args.includes('--smart') ? 'smart ' : ''}emits [] for empty JSON results`, () => {
    const result = cli(...args);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), '[]');
  });
}

test('impossible calendar dates are rejected before querying', () => {
  for (const date of ['2026-02-30', '2025-02-29', '2026-13-01']) {
    const result = cli('query', '甲站', '乙站', date, '--json');
    assert.equal(result.status, 1, date);
    assert.match(result.stderr, /日期/);
  }
  assert.equal(cli('query', '甲站', '乙站', '2028-02-29', '--json').status, 0);
});

test('ambiguous station prefix is rejected with candidate names', () => {
  const result = cli('query', '甲', '乙站', '2030-01-01');
  assert.equal(result.status, 1);
  assert.match(result.stderr, /甲站/);
  assert.match(result.stderr, /甲南/);
});

test('station resolution preserves exact telecodes and unique prefixes', () => {
  assert.equal(cli('query', 'aaa', '乙', '2030-01-01', '--json').status, 0);
});

test('missing train-status announcements mean unknown status', () => {
  const result = cli('status', 'G1', '2030-01-01');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /未知/);
  assert.doesNotMatch(result.stdout, /预计正常开行/);
});

test('smart transfer reports a missing middle station on stderr', () => {
  const result = cli('transfer', '甲站', '乙站', '2030-01-01', '--smart', '--json');
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /--middle/);
});

const structuredCommands = [
  ['stations', '不存在'], ['query', '甲站', '乙站', '2030-01-01'],
  ['transfer', '甲站', '乙站', '2030-01-01'], ['route', 'G1', '2030-01-01'],
  ['sale-time', '甲站'], ['delay', 'G1', '甲站'], ['status', 'G1', '2030-01-01'],
  ['gate', 'G1', '甲站', '2030-01-01'],
];
function checkEnvelope(result, command, ok) {
  assert.equal(result.status, ok ? 0 : 1, result.stderr);
  assert.ok(result.stdout.trim(), `Missing stdout: ${JSON.stringify({ command, status: result.status, signal: result.signal, error: result.error?.message, stderr: result.stderr, args: result.spawnargs })}`);
  const body = JSON.parse(result.stdout);
  assert.equal(body.schema_version, '1.0');
  assert.equal(body.command, command);
  assert.equal(body.ok, ok);
  assert.equal(new Date(body.queried_at).toISOString(), body.queried_at);
  assert.deepEqual(body.sources, [{ name: '12306', url: 'https://www.12306.cn/' }]);
  assert.equal(result.stderr, '');
  assert.equal(result.stdout.trim().split('\n').length, 1);
  return body;
}
for (const args of structuredCommands) {
  test(`${args[0]} supports the structured success envelope`, () => {
    const body = checkEnvelope(cli(...args, '--structured'), args[0], true);
    assert.ok(Object.hasOwn(body, 'data'));
    assert.ok(!Object.hasOwn(body, 'error'));
  });
}
test('structured smart transfer and --json combination have one envelope', () => {
  const body = checkEnvelope(cli('transfer', '甲站', '乙站', '2030-01-01', '--smart', '--middle', '丙站', '--json', '--structured'), 'transfer', true);
  assert.deepEqual(body.data, []);
});
test('structured failures cover parser, validation and upstream errors without leaking inputs', () => {
  for (const args of [['query'], ['query', 'sensitive-input', '乙站', 'invalid-date'], ['query', '--unknown-argument']]) {
    const body = checkEnvelope(cli(...args, '--structured'), 'query', false);
    assert.equal(body.error.code, 'INVALID_ARGUMENT');
    assert.doesNotMatch(JSON.stringify(body), /sensitive-input|invalid-date|unknown-argument/);
    assert.ok(!Object.hasOwn(body, 'data'));
  }
  const body = checkEnvelope(cliWithFetch('malformed', 'stations', 'private-query', '--structured'), 'stations', false);
  assert.equal(body.error.code, 'UPSTREAM_INVALID_RESPONSE');
  assert.doesNotMatch(JSON.stringify(body), /synthetic-secret-body|private-query/);
});
test('all numeric/time constraints fail before any network request', () => {
  const cases = [
    ['query', '--limit', '0'], ['query', '--limit', '-1'], ['query', '--limit', '1.5'],
    ['query', '--limit', 'NaN'], ['query', '--limit', '1e2'], ['query', '--limit', '1001'],
    ['query', '--earliest', '9:00'], ['query', '--earliest', '24:00'], ['query', '--latest', '12:60'],
    ['query', '--earliest', '12:00', '--latest', '11:59'], ['query', '--sort', 'invalid'],
    ['transfer', '--limit', '301'], ['transfer', '--wait-min', 'NaN'], ['transfer', '--wait-max', '1441'],
    ['transfer', '--wait-min', '91', '--wait-max', '90'], ['transfer', '--smart'],
    ['transfer', '--seat', '二等座'], ['transfer', '--max-duration', '120'],
    ['transfer', '--smart', '--middle', '丙站', '--seat', 'unknown'],
    ['transfer', '--smart', '--middle', '丙站', '--max-duration', '0'],
    ['transfer', '--smart', '--middle', '丙站', '--max-duration', '10081'],
  ];
  for (const [command, ...options] of cases) {
    const result = cliWithFetch('forbid', command, '甲站', '乙站', '2030-01-01', ...options, '--structured');
    assert.doesNotMatch(result.stderr, /FIXTURE_NETWORK_CALLED/, options.join(' '));
    const body = checkEnvelope(result, command, false);
    assert.equal(body.error.code, 'INVALID_ARGUMENT', options.join(' '));
  }
});
