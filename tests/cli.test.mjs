import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = new URL('./fixtures/mock-fetch.mjs', import.meta.url).href;
const cli = (...args) => spawnSync(process.execPath, ['--import', fixture, cliPath, ...args], { encoding: 'utf8', timeout: 5_000 });

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
