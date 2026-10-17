import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, statSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const cliPath = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const fixture = new URL('./fixtures/mock-fetch.mjs', import.meta.url).href;
function setup(t) {
  const dir = mkdtempSync(join(tmpdir(), 'cr12306-planning-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const preferences = join(dir, 'preferences.json');
  const run = (args, mode = 'trips') => spawnSync(process.execPath, ['--import', fixture, cliPath, ...args], {
    encoding: 'utf8', timeout: 5_000, env: { ...process.env, CR12306_PREFERENCES: preferences, CR12306_TEST_FETCH: mode },
  });
  return { dir, preferences, run };
}
const trip = ['roundtrip', '甲站', '乙站', '2030-01-01'];
function success(result) {
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const envelope = JSON.parse(result.stdout);
  assert.equal(envelope.ok, true);
  return envelope.data;
}

test('same-day roundtrip measures destination stay and includes only bookable direct trains', (t) => {
  const { run } = setup(t);
  const plans = success(run([...trip, '--structured']));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].outbound.code, 'G1');
  assert.equal(plans[0].return.code, 'G2');
  assert.equal(plans[0].stayMin, 480);
  assert.equal(plans[0].totalTravelMin, 240);
  assert.equal(plans[0].destinationArrival, '2030-01-01T10:00:00+08:00');
  assert.deepEqual(success(run([...trip, '--min-stay', '481', '--structured'])), []);
  assert.deepEqual(success(run([...trip, '--structured'], 'trips-unavailable')), []);
});

test('roundtrip handles overnight outbound and next-day return using boarding dates', (t) => {
  const { run } = setup(t);
  const plans = success(run([...trip, '--return-date', '2030-01-02', '--outbound-earliest', '23:00', '--return-latest', '02:00', '--min-stay', '60', '--seat', '商务座', '--structured']));
  assert.equal(plans.length, 1);
  assert.equal(plans[0].stayMin, 60);
  assert.equal(plans[0].homeArrival, '2030-01-02T04:00:00+08:00');
  assert.equal(plans[0].totalElapsedMin, 300);
  assert.deepEqual(success(run([...trip, '--outbound-earliest', '23:00', '--structured'])), []);
});

test('roundtrip validates all calendar, time, count and seat options before network', (t) => {
  const { run } = setup(t);
  for (const options of [
    ['--return-date', '2029-12-31'], ['--return-date', '2030-02-30'],
    ['--outbound-earliest', '24:00'], ['--outbound-latest', '9:00'],
    ['--return-earliest', '18:00', '--return-latest', '17:00'],
    ['--min-stay', '1.5'], ['--min-stay', '10081'], ['--limit', '101'], ['--limit', '0'],
    ['--seat', 'unknown'], ['--select', '0'], ['--card', '--structured'],
  ]) {
    const result = run([...trip, ...options, '--structured'], 'forbid');
    assert.equal(result.status, 1, options.join(' '));
    assert.doesNotMatch(result.stderr, /FIXTURE_NETWORK_CALLED/);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENT');
  }
});

test('preferences persist only whitelisted fields and explicit CLI options override them', (t) => {
  const { preferences, run } = setup(t);
  assert.deepEqual(success(run(['preferences', 'show', '--structured'], 'forbid')), {});
  for (const [key, value] of [['seat', '商务座'], ['minWait', '40'], ['maxWait', '120'], ['earliest', '09:00']]) {
    success(run(['preferences', 'set', key, value, '--structured'], 'forbid'));
  }
  assert.deepEqual(JSON.parse(readFileSync(preferences, 'utf8')), { seat: '商务座', minWait: 40, maxWait: 120, earliest: '09:00' });
  if (process.platform !== 'win32') assert.equal(statSync(preferences).mode & 0o777, 0o600);
  assert.deepEqual(success(run([...trip, '--structured'])), []);
  const plans = success(run([...trip, '--seat', '二等座', '--outbound-earliest', '08:00', '--structured']));
  assert.equal(plans.length, 1);
  assert.equal(success(run(['query', '甲站', '乙站', '2030-01-01', '--structured'])).length, 1);
  assert.equal(success(run(['query', '甲站', '乙站', '2030-01-01', '--earliest', '08:00', '--structured'])).length, 2);
  const smart = ['transfer', '甲站', '乙站', '2030-01-01', '--smart', '--middle', '丙站'];
  assert.deepEqual(success(run([...smart, '--seat', '二等座', '--structured'])), []);
  assert.equal(success(run([...smart, '--seat', '二等座', '--wait-min', '20', '--structured'])).length, 1);
  success(run(['preferences', 'reset', '--structured'], 'forbid'));
  assert.deepEqual(JSON.parse(readFileSync(preferences, 'utf8')), {});
});

test('invalid preference updates cannot change the previous store or trigger network', (t) => {
  const { preferences, run } = setup(t);
  success(run(['preferences', 'set', 'earliest', '10:00', '--structured'], 'forbid'));
  const original = readFileSync(preferences, 'utf8');
  for (const args of [['latest', '09:00'], ['minWait', '91'], ['unknown', 'value'], ['seat', 'invalid']]) {
    const result = run(['preferences', 'set', ...args, '--structured'], 'forbid');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).error.code, 'INVALID_ARGUMENT');
    assert.doesNotMatch(result.stderr, /FIXTURE_NETWORK_CALLED/);
    assert.equal(readFileSync(preferences, 'utf8'), original);
  }
  writeFileSync(preferences, '{private broken input');
  const result = run([...trip, '--structured'], 'forbid');
  assert.equal(result.status, 1);
  assert.equal(JSON.parse(result.stdout).error.code, 'PREFERENCES_INVALID');
  assert.doesNotMatch(result.stdout + result.stderr, /private broken input|FIXTURE_NETWORK_CALLED/);
});

test('itinerary cards show actual dates, stay time, selected seats, source and freshness caveat', (t) => {
  const { run, dir } = setup(t);
  const result = run([...trip, '--seat', '二等座', '--card']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^# 往返行程卡/m);
  for (const value of ['G1', 'G2', '2030-01-01', '480', '二等座', 'https://www.12306.cn/', '查询时间', '余票可能变化']) assert.ok(result.stdout.includes(value), value);
  assert.equal(run([...trip, '--select', '2', '--card']).status, 1);
  const path = join(dir, 'card.watch.json');
  const saved = run([...trip, '--card', '--save-watch', path]);
  assert.equal(saved.status, 0);
  assert.ok(saved.stderr.includes(path));
  assert.ok(!saved.stdout.includes(path));
});

test('watch baselines stay private and immutable; checks suppress positive-count noise', (t) => {
  const { dir, run } = setup(t);
  const path = join(dir, 'selected.watch.json');
  success(run([...trip, '--seat', '二等座', '--save-watch', path, '--structured']));
  assert.ok(existsSync(path));
  const original = readFileSync(path, 'utf8');
  if (process.platform !== 'win32') assert.equal(statSync(path).mode & 0o777, 0o600);
  const unchanged = success(run(['watch', 'check', path, '--structured'], 'trips-count'));
  assert.deepEqual(unchanged, { state: 'unchanged', notify: false, changes: [] });
  const changed = success(run(['watch', 'check', path, '--structured'], 'trips-unavailable'));
  assert.equal(changed.state, 'changed');
  assert.equal(changed.notify, true);
  assert.equal(changed.changes.length, 2);
  assert.ok(changed.changes.every((c) => c.field === 'bookable' && c.before === true && c.after === false));
  assert.equal(success(run(['watch', 'check', path, '--structured'], 'trips-unavailable')).notify, false);
  const unavailable = run(['watch', 'check', path, '--structured'], 'trips-missing');
  assert.equal(unavailable.status, 1);
  assert.equal(JSON.parse(unavailable.stdout).error.code, 'WATCH_UNAVAILABLE');
  assert.equal(JSON.parse(unavailable.stdout).error.notify, true);
  assert.equal(JSON.parse(run(['watch', 'check', path, '--structured'], 'trips-missing').stdout).error.notify, false);
  const recovered = success(run(['watch', 'check', path, '--structured'], 'trips-count'));
  assert.equal(recovered.notify, true);
  assert.ok(recovered.changes.some((c) => c.field === 'availability' && c.before === 'unavailable'));
  assert.equal(success(run(['watch', 'check', path, '--structured'], 'trips-count')).notify, false);
  const upstreamUnavailable = run(['watch', 'check', path, '--structured'], 'malformed');
  assert.equal(JSON.parse(upstreamUnavailable.stdout).error.code, 'WATCH_UNAVAILABLE');
  assert.equal(JSON.parse(upstreamUnavailable.stdout).error.notify, true);
  assert.equal(readFileSync(path, 'utf8'), original);
});

test('invalid watch paths and malformed baselines fail before network', (t) => {
  const { dir, run } = setup(t);
  const bad = join(dir, 'bad.watch.json');
  writeFileSync(bad, '{synthetic private invalid baseline');
  for (const args of [[...trip, '--save-watch', join(dir, 'bad.json')], [...trip, '--save-watch', 'src/bad.watch.json'], ['watch', 'check', bad]]) {
    const result = run([...args, '--structured'], 'forbid');
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic private|FIXTURE_NETWORK_CALLED/);
  }
});

test('explicitly replacing a watch baseline resets corrupt deduplication state', (t) => {
  const { dir, run } = setup(t);
  const path = join(dir, 'reset.watch.json');
  const state = join(dir, 'reset.state.watch.json');
  success(run([...trip, '--save-watch', path, '--structured']));
  writeFileSync(state, '{broken synthetic state');
  const invalid = run(['watch', 'check', path, '--structured'], 'forbid');
  assert.equal(invalid.status, 1);
  assert.equal(JSON.parse(invalid.stdout).error.code, 'WATCH_INVALID');
  assert.doesNotMatch(invalid.stderr, /FIXTURE_NETWORK_CALLED/);
  success(run([...trip, '--save-watch', path, '--structured']));
  assert.deepEqual(success(run(['watch', 'check', path])), { state: 'unchanged', notify: false, changes: [] });
});
