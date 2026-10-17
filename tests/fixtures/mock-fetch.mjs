// Offline CLI fixture: never delegates to the real network.
import { join } from 'node:path';
import { tmpdir } from 'node:os';
process.env.CR12306_PREFERENCES ||= join(tmpdir(), 'cr12306-test-no-preferences', 'preferences.json');

const row = (code, from, to, start, arrive, duration, seat = '有', business = '0') => {
  const f = Array(47).fill('');
  Object.assign(f, { 2: `test-${code}`, 3: code, 6: from, 7: to, 8: start, 9: arrive, 10: duration, 11: 'Y', 13: '20291231', 30: seat, 32: business });
  return f.join('|');
};
globalThis.fetch = async (input) => {
  if (process.env.CR12306_TEST_FETCH === 'forbid') {
    process.stderr.write('FIXTURE_NETWORK_CALLED\n');
    throw new Error('synthetic query and cookie contents must stay private');
  }
  const url = new URL(input);
  if (process.env.CR12306_TEST_FETCH === 'malformed') return Response.json({ status: false, messages: ['synthetic-secret-body'] });
  if (url.pathname.endsWith('/station_name.js')) {
    return new Response("var station_names ='@ja|甲站|AAA|jiazhan|ja|0@jb|甲南|AAB|jianan|jb|1@jc|乙站|BBB|yizhan|jc|2@jd|丙站|CCC|bingzhan|jd|3';");
  }
  if (url.pathname.endsWith('/leftTicket/init')) return new Response('');
  if (/\/leftTicket\/query/.test(url.pathname) && process.env.CR12306_TEST_FETCH?.startsWith('trips')) {
    const mode = process.env.CR12306_TEST_FETCH;
    const from = url.searchParams.get('leftTicketDTO.from_station');
    const to = url.searchParams.get('leftTicketDTO.to_station');
    const seat = mode === 'trips-unavailable' ? '无' : mode === 'trips-count' ? '8' : '有';
    const result = from === 'AAA' && to === 'BBB'
      ? [row('G1', 'AAA', 'BBB', '08:00', '10:00', '02:00', seat), row('G3', 'AAA', 'BBB', '23:00', '01:00', '02:00', seat, '有')]
      : from === 'BBB' && to === 'AAA'
      ? [row('G2', 'BBB', 'AAA', '18:00', '20:00', '02:00', seat), row('G4', 'BBB', 'AAA', '02:00', '04:00', '02:00', seat, '有')]
      : from === 'AAA' && to === 'CCC'
      ? [row('G5', 'AAA', 'CCC', '08:00', '10:00', '02:00', seat)]
      : [row('G6', 'CCC', 'BBB', '10:30', '12:30', '02:00', seat)];
    return Response.json({ status: true, data: { result: mode === 'trips-missing' ? [] : result, map: { AAA: '甲站', BBB: '乙站', CCC: '丙站' } } });
  }
  if (/\/leftTicket\/query/.test(url.pathname)) return Response.json({ data: { result: [], map: {} } });
  if (url.pathname === '/lcquery/queryG') return Response.json({ status: true, data: { middleList: [] } });
  if (url.pathname.endsWith('/queryAllCacheSaleTime') || url.pathname.endsWith('/queryScSname')) return Response.json({ data: [] });
  if (url.pathname === '/search/v1/train/search') return Response.json({ data: [{ train_no: 'test-train', station_train_code: 'G1' }] });
  if (url.pathname.endsWith('/queryTrainStatus')) return Response.json({ data: { data: '未查询到相关记录' } });
  if (url.pathname.endsWith('/queryTrainInfo/query')) return Response.json({ data: { data: [] } });
  if (url.pathname.endsWith('/zwdch/query')) return Response.json({ status: true, data: { message: '暂无正晚点信息' } });
  if (url.pathname.endsWith('/queryTicketCheck')) return Response.json({ status: true, data: { result: 'Y', trainPlatform: '' } });
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};
