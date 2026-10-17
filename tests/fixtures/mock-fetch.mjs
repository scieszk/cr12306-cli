// Offline CLI fixture: never delegates to the real network.
globalThis.fetch = async (input) => {
  const url = new URL(input);
  if (url.pathname.endsWith('/station_name.js')) {
    return new Response("var station_names ='@ja|甲站|AAA|jiazhan|ja|0@jb|甲南|AAB|jianan|jb|1@jc|乙站|BBB|yizhan|jc|2@jd|丙站|CCC|bingzhan|jd|3';");
  }
  if (url.pathname.endsWith('/leftTicket/init')) return new Response('');
  if (/\/leftTicket\/query/.test(url.pathname)) return Response.json({ data: { result: [], map: {} } });
  if (url.pathname === '/lcquery/queryG') return Response.json({ status: true, data: { middleList: [] } });
  if (url.pathname.endsWith('/queryAllCacheSaleTime') || url.pathname.endsWith('/queryScSname')) return Response.json({ data: [] });
  if (url.pathname === '/search/v1/train/search') return Response.json({ data: [{ train_no: 'test-train', station_train_code: 'G1' }] });
  if (url.pathname.endsWith('/queryTrainStatus')) return Response.json({ data: { data: '未查询到相关记录' } });
  if (url.pathname.endsWith('/queryTrainInfo/query')) return Response.json({ data: { data: [] } });
  throw new Error(`Unexpected fixture request: ${url.pathname}`);
};
