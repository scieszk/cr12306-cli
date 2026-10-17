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

let moduleId = 0;
const freshApi = () => import(`../dist/api.js?case=${moduleId++}`);
function stubFetch(t, handler) {
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, options) => handler(new URL(input), options);
  t.after(() => { globalThis.fetch = previous; });
}
const emptyTickets = { status: true, httpstatus: 200, data: { result: [], map: {} } };

test('ticket path is read from the init page without executing JavaScript', async (t) => {
  const client = await freshApi();
  const paths = [];
  stubFetch(t, (url, options) => {
    assert.equal(options.redirect, 'error');
    paths.push(url.pathname);
    if (url.pathname.endsWith('/init')) return new Response("<script>var CLeftTicketUrl = 'leftTicket/queryZ'; throw new Error('do not execute');</script>");
    return Response.json(emptyTickets);
  });
  assert.deepEqual((await client.queryLeftTickets('2030-01-01', 'AAA', 'BBB')).data.result, []);
  assert.deepEqual(paths, ['/otn/leftTicket/init', '/otn/leftTicket/queryZ']);
});

test('server relative endpoint hints are followed once and cached after success', async (t) => {
  const client = await freshApi();
  const paths = [];
  stubFetch(t, (url) => {
    paths.push(url.pathname);
    if (url.pathname.endsWith('/init')) return new Response('');
    if (url.pathname.endsWith('/queryG')) return Response.json({ status: false, c_url: 'leftTicket/queryT' });
    return Response.json(emptyTickets);
  });
  await client.queryLeftTickets('2030-01-01', 'AAA', 'BBB');
  await client.queryLeftTickets('2030-01-01', 'AAA', 'BBB');
  assert.deepEqual(paths, ['/otn/leftTicket/init', '/otn/leftTicket/queryG', '/otn/leftTicket/queryT', '/otn/leftTicket/queryT']);
});

test('unsafe and oversized path hints are ignored; only known bounded fallbacks run', async (t) => {
  for (const hint of ['https://example.invalid/leftTicket/queryZ', '//example.invalid/queryZ', '../leftTicket/queryZ', '/otn/leftTicket/queryZ', 'leftTicket/queryZ?token=synthetic', 'leftTicket/queryZ#x', 'leftTicket/query' + 'A'.repeat(100)]) {
    await t.test(hint, async (t) => {
      const client = await freshApi();
      const paths = [];
      stubFetch(t, (url) => {
        assert.equal(url.origin, 'https://kyfw.12306.cn');
        if (url.pathname.endsWith('/init')) return new Response(`var CLeftTicketUrl = '${hint}';`);
        paths.push(url.pathname);
        if (url.pathname.endsWith('/query')) return Response.json(emptyTickets);
        return Response.json({ status: false, c_url: hint });
      });
      await client.queryLeftTickets('2030-01-01', 'AAA', 'BBB');
      assert.deepEqual(paths, ['/otn/leftTicket/queryG', '/otn/leftTicket/queryA', '/otn/leftTicket/query']);
    });
  }
});

test('rotating safe hints cannot cause unbounded requests', async (t) => {
  const client = await freshApi();
  const paths = [];
  stubFetch(t, (url) => {
    if (url.pathname.endsWith('/init')) return new Response('');
    paths.push(url.pathname);
    return Response.json({ status: false, c_url: `leftTicket/query${'Z'.repeat(paths.length)}` });
  });
  await assert.rejects(() => client.queryLeftTickets('2030-01-01', 'AAA', 'BBB'), { code: 'UPSTREAM_REJECTED' });
  assert.ok(paths.length <= 5);
  assert.equal(new Set(paths).size, paths.length);
});

test('ticket errors and malformed ticket rows are never an empty success', async (t) => {
  for (const payload of [null, {}, { data: [] }, { status: false, data: { result: [] } }, { data: { result: 'bad' } }, { data: { result: ['broken|row'] } }, { data: { result: [Array(47).fill('').join('|')] } }, { data: { result: [], map: [] } }]) {
    await t.test(JSON.stringify(payload), async (t) => {
      const client = await freshApi();
      stubFetch(t, (url) => url.pathname.endsWith('/init') ? new Response('') : Response.json(payload));
      await assert.rejects(() => client.queryLeftTickets('2030-01-01', 'AAA', 'BBB'), (e) => /^UPSTREAM_/.test(e.code));
    });
  }
});

test('valid populated responses preserve normalized fields', async (t) => {
  const client = await freshApi();
  const leg = { train_no: 'test-train', station_train_code: 'G1', from_station_telecode: 'AAA', to_station_telecode: 'BBB', from_station_name: '甲站', to_station_name: '乙站', start_time: '08:00', arrive_time: '10:00', lishi: '02:00', canWebBuy: 'Y', ze_num: '有' };
  let payload = { status: true, data: { middleList: [{ all_lishi: '4小时30分钟', all_lishi_minutes: 270, start_time: '08:00', arrive_time: '12:30', from_station_name: '甲站', middle_station_name: '乙站', end_station_name: '丙站', same_station: 'Y', fullList: [leg, { ...leg, station_train_code: 'G2', from_station_telecode: 'BBB', to_station_telecode: 'CCC', start_time: '10:30', arrive_time: '12:30' }] }] } };
  stubFetch(t, (url) => url.pathname.endsWith('/leftTicket/init') ? new Response('') : Response.json(payload));
  const [plan] = await client.queryInterline('2030-01-01', 'AAA', 'CCC');
  assert.equal(plan.legs[0].seats['二等座'], '有');
  assert.equal(plan.sameStation, true);
  payload.data.middleList[0].fullList[0].dw_flag = {};
  await assert.rejects(() => client.queryInterline('2030-01-01', 'AAA', 'CCC'), { code: 'UPSTREAM_INVALID_RESPONSE' });
});

const responseCases = [
  ['search', (c) => c.searchTrainNo('G1', '2030-01-01'), { data: [] }, { data: [{ station_train_code: 'G1' }] }],
  ['route', (c) => c.queryTrainRoute('test-train', '2030-01-01'), { data: { data: [] } }, { data: { data: [{}] } }],
  ['interline', (c) => c.queryInterline('2030-01-01', 'AAA', 'BBB'), { data: { middleList: [] } }, { data: { middleList: [{}] } }],
  ['sale times', (c) => c.queryAllSaleTimes(), { data: [] }, { data: [{}] }],
  ['same-city stations', (c) => c.querySameCityStations('AAA'), { data: [] }, { data: [null] }],
  ['status', (c) => c.queryTrainStatus('test-train', '2030-01-01'), { data: { data: '' } }, { data: { data: {} } }],
  ['gate', (c) => c.queryTicketCheckGate('G1', 'AAA', '2030-01-01'), { data: { result: 'Y', trainPlatform: '' } }, { data: { result: 'Y', trainPlatform: {} } }],
  ['delay', (c) => c.queryDelay('甲站', 'G1', 1), { data: { message: '' } }, { data: { message: {} } }],
];
for (const [name, call, empty, malformed] of responseCases) {
  test(`${name} distinguishes valid empty data from malformed and rejected responses`, async (t) => {
    const client = await freshApi();
    let payload = empty;
    stubFetch(t, (url) => url.pathname.endsWith('/leftTicket/init') ? new Response('') : Response.json(payload));
    if (name === 'search') await assert.rejects(() => call(client), { code: 'TRAIN_NOT_FOUND' });
    else assert.deepEqual(await call(client), ['status', 'gate', 'delay'].includes(name) ? '' : []);
    for (payload of [{}, null, malformed, { ...empty, status: false }, { ...empty, httpstatus: 500 }]) {
      await assert.rejects(() => call(client), (e) => /^UPSTREAM_/.test(e.code), `${name}: ${JSON.stringify(payload)}`);
    }
  });
}

test('invalid JSON is a sanitized upstream error', async (t) => {
  const client = await freshApi();
  stubFetch(t, (url) => new Response(url.pathname.endsWith('/init') ? '' : '<html>synthetic-private-body</html>'));
  await assert.rejects(() => client.queryAllSaleTimes(), (e) => e.code === 'UPSTREAM_INVALID_RESPONSE' && !e.message.includes('synthetic-private-body'));
});

test('ticket identifiers and clock values are validated before returning data', async (t) => {
  const client = await freshApi();
  const fields = Array(47).fill('');
  Object.assign(fields, { 2: 'test-train', 3: 'G1', 6: 'AAA', 7: 'BBB', 8: '08:00', 9: '10:00', 10: '02:00', 11: 'Y' });
  let row = fields.join('|');
  stubFetch(t, (url) => url.pathname.endsWith('/init') ? new Response('') : Response.json({ status: true, data: { result: [row], map: {} } }));
  assert.equal((await client.queryLeftTickets('2030-01-01', 'AAA', 'BBB')).data.result.length, 1);
  for (const [index, value] of [[6, 'invalid'], [8, '24:00'], [9, '10:60'], [10, 'NaN'], [11, '']]) {
    const invalid = [...fields];
    invalid[index] = value;
    row = invalid.join('|');
    await assert.rejects(() => client.queryLeftTickets('2030-01-01', 'AAA', 'BBB'), { code: 'UPSTREAM_INVALID_RESPONSE' });
  }
});
