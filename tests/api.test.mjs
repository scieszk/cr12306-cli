import assert from 'node:assert/strict';
import test from 'node:test';
import * as api from '../dist/api.js';

test('every HTTP entry point applies a bounded timeout', async (t) => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  const timeoutValues = [];
  AbortSignal.timeout = (ms) => {
    timeoutValues.push(ms);
    return originalTimeout(5);
  };
  globalThis.fetch = (_url, options = {}) => new Promise((resolve, reject) => {
    const fallback = setTimeout(() => reject(new Error('missing bounded abort')), 80);
    options.signal?.addEventListener('abort', () => {
      clearTimeout(fallback);
      reject(options.signal.reason);
    }, { once: true });
  });
  t.after(() => { globalThis.fetch = originalFetch; AbortSignal.timeout = originalTimeout; });

  for (const [name, call] of [
    ['cookie initialization', () => api.getCookie()],
    ['station download', () => api.fetchStationNameJs()],
    ['delay query', () => api.queryDelay('甲站', 'G1', 1)],
  ]) {
    await t.test(name, async () => {
      await assert.rejects(call, { name: 'TimeoutError' });
    });
  }

  // Populate the cookie cache so the following checks reach GET/POST themselves.
  const pendingFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('', { headers: { 'set-cookie': 'test=session' } });
  await api.getCookie();
  globalThis.fetch = pendingFetch;
  await t.test('JSON GET', async () => {
    await assert.rejects(() => api.searchTrainNo('G1', '2030-01-01'), { name: 'TimeoutError' });
  });
  await t.test('form POST', async () => {
    await assert.rejects(() => api.queryTrainStatus('test-train', '2030-01-01'), { name: 'TimeoutError' });
  });
  assert.equal(timeoutValues.length, 6); // Includes successful cookie initialization.
  assert.ok(timeoutValues.every((ms) => ms > 0 && ms <= 30_000));
});

test('train search rejects unrelated prefix matches', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [{ train_no: 'wrong', station_train_code: 'G10' }] });
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(() => api.searchTrainNo('G1', '2030-01-01'), /未查询到车次 G1/);
});

test('train search accepts an exact code with an optional route suffix', async (t) => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => Response.json({ data: [
    { train_no: 'wrong', station_train_code: 'G10(甲站-乙站)' },
    { train_no: 'right', station_train_code: 'G1(甲站-乙站)' },
  ] });
  t.after(() => { globalThis.fetch = originalFetch; });
  assert.equal(await api.searchTrainNo('g1', '2030-01-01'), 'right');
});
