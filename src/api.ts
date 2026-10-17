/**
 * 12306 网站自用接口的只读封装。
 * 注意：这些接口非官方对第三方授权，随时可能变更/失效，低调使用。
 */

import { parseTicketObject } from './parse.js';
import type { TicketInfo } from './parse.js';

export const API_BASE = 'https://kyfw.12306.cn';
export const SEARCH_BASE = 'https://search.12306.cn';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let cachedCookie: string | null = null;

/** Abort covers both response headers and body consumption. */
function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(15_000) });
}

/** 打 leftTicket/init 拿会话 cookie（RAIL_DEVICEID / RAIL_EXPIRATION） */
export async function getCookie(): Promise<string> {
  if (cachedCookie) return cachedCookie;
  const res = await fetchWithTimeout(`${API_BASE}/otn/leftTicket/init`, {
    headers: { 'User-Agent': UA },
    redirect: 'follow',
  });
  const setCookies =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  cachedCookie = cookie || 'RAIL_DEVICEID=cr12306cli';
  return cachedCookie;
}

async function request<T>(url: string, params: Record<string, string>, useCookie = true): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'User-Agent': UA };
  if (useCookie) headers['Cookie'] = await getCookie();
  const res = await fetchWithTimeout(`${url}?${qs}`, { headers });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

/** POST 表单请求（12306 部分接口只接受 POST） */
async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: await getCookie(),
  };
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

/* ---------- 车站电报码 ---------- */

export async function fetchStationNameJs(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/otn/resources/js/framework/station_name.js`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching station_name.js`);
  return res.text();
}

/* ---------- 余票查询 ---------- */

export interface LeftTicketsResponse {
  status?: boolean;
  messages?: string;
  data?: {
    result?: string[];
    map?: Record<string, string>;
    msg?: string;
  };
}

export async function queryLeftTickets(
  date: string, // yyyy-MM-dd
  fromTele: string,
  toTele: string
): Promise<LeftTicketsResponse> {
  // 接口名在 query / queryA / queryG / queryZ 之间横跳过，逐个尝试
  const variants = ['leftTicket/queryG', 'leftTicket/queryA', 'leftTicket/query'];
  let lastErr: unknown = null;
  for (const path of variants) {
    try {
      const r = await request<LeftTicketsResponse>(`${API_BASE}/otn/${path}`, {
        'leftTicketDTO.train_date': date,
        'leftTicketDTO.from_station': fromTele,
        'leftTicketDTO.to_station': toTele,
        purpose_codes: 'ADULT',
      });
      if (r?.data?.result) return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error('所有余票接口变体均失败');
}

/* ---------- 车次号 → train_no ---------- */

export interface TrainSearchResponse {
  data?: { train_no: string; station_train_code: string }[];
}

export async function searchTrainNo(trainCode: string, date: string): Promise<string> {
  const r = await request<TrainSearchResponse>(`${SEARCH_BASE}/search/v1/train/search`, {
    keyword: trainCode,
    date: date.replaceAll('-', ''),
  });
  const hit = r.data?.find(
    (d) => d.station_train_code.replace(/\s*[（(][^()（）]*[)）]\s*$/, '').trim().toUpperCase() === trainCode.trim().toUpperCase()
  );
  if (!hit) throw new Error(`未查询到车次 ${trainCode}（${date}）`);
  return hit.train_no;
}

/* ---------- 车次经停站时刻 ---------- */

export interface TrainRouteStop {
  station_no?: string;
  station_name?: string;
  start_time?: string;
  arrive_time?: string;
  stopover_time?: string;
  isEnabled?: boolean;
}

export interface TrainRouteResponse {
  data?: { data?: TrainRouteStop[] };
}

/* ---------- 官方正晚点查询（/otn/zwdch/query，表单 POST，免登录） ---------- */

export async function queryDelay(
  stationName: string, // 车站中文名，如 "成都东"
  trainCode: string,   // 车次，如 "G3886"
  cxlx: 0 | 1          // 0=到达正晚点 1=出发正晚点
): Promise<string> {
  const body = new URLSearchParams({
    cxlx: String(cxlx),
    cz: stationName,
    cc: trainCode.toUpperCase(),
    czEn: encodeURIComponent(stationName).replace(/%/g, '-'),
    randCode: '',
  });
  const res = await fetchWithTimeout(`${API_BASE}/otn/zwdch/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'User-Agent': UA,
      Referer: `${API_BASE}/otn/zwdch/init`,
    },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} from zwdch/query`);
  const r = (await res.json()) as { status?: boolean; data?: { message?: string } };
  const msg = r.data?.message;
  if (!msg) throw new Error('正晚点接口返回异常');
  return msg; // 官方自然语言，如 "预计G3886次列车，成都东站到达时间为14:20"
}

/* ---------- 中转联程查询（/lcquery/queryG，注意：不在 /otn 下） ---------- */

export interface InterlinePlan {
  allLishi: string; // 全程历时，如 "8小时39分钟"
  allLishiMinutes: number;
  startTime: string;
  arriveTime: string;
  waitTime: string; // 换乘等待，如 "1小时13分钟"
  fromStation: string;
  middleStation: string;
  endStation: string;
  sameStation: boolean; // 是否同站换乘
  legs: TicketInfo[]; // 两段行程（复用余票行解析）
}

interface InterlineRawItem {
  all_lishi: string;
  all_lishi_minutes: number;
  start_time: string;
  arrive_time: string;
  lCWaitTime?: string;
  wait_time?: string;
  from_station_name: string;
  middle_station_name: string;
  end_station_name: string;
  same_station: string;
  fullList?: Record<string, string>[];
}

interface InterlineQueryResponse {
  status: boolean;
  data?: { middleList?: InterlineRawItem[] };
}

/**
 * 官方中转联程查询。
 * result_index 是"起始下标"（窗口 10 条/页），步进 10 即可翻页拉全；
 * 注意 sort_type=1（全程历时升序）下分页才生效，官网页面默认的 2 会忽略 result_index。
 */
export async function queryInterline(
  date: string,
  fromTele: string,
  toTele: string,
  middleTele = '',
  pages = 1
): Promise<InterlinePlan[]> {
  const seen = new Set<string>();
  const out: InterlinePlan[] = [];
  for (let i = 0; i < pages; i++) {
    const r = await request<InterlineQueryResponse>(`${API_BASE}/lcquery/queryG`, {
      train_date: date,
      from_station_telecode: fromTele,
      to_station_telecode: toTele,
      middle_station: middleTele,
      result_index: String(i * 10),
      can_query: 'Y',
      isShowWZ: 'Y',
      sort_type: '1',
      purpose_codes: '00',
      channel: 'E',
    });
    const list = r.data?.middleList ?? [];
    let added = 0;
    for (const m of list) {
      const legs = (m.fullList ?? []).map(parseTicketObject);
      const key = legs.map((l) => `${l.code}${l.startTime}`).join('#');
      if (seen.has(key)) continue;
      seen.add(key);
      added++;
      out.push({
        allLishi: m.all_lishi,
        allLishiMinutes: m.all_lishi_minutes,
        startTime: m.start_time,
        arriveTime: m.arrive_time,
        waitTime: m.lCWaitTime ?? m.wait_time ?? '',
        fromStation: m.from_station_name,
        middleStation: m.middle_station_name,
        endStation: m.end_station_name,
        sameStation: m.same_station === '1' || m.same_station === 'Y',
        legs,
      });
    }
    if (list.length < 10 || added === 0) break; // 最后一页
  }
  return out.sort((a, b) => a.allLishiMinutes - b.allLishiMinutes);
}

/* ---------- 起售时间 ---------- */

export interface SaleTimeInfo {
  stationName: string;
  telecode: string;
  saleTime: string; // "0900" 表示 09:00 起售
  bureau: string;
}

/** 全路车站起售时间总表（GET /otn/index12306/queryAllCacheSaleTime） */
export async function queryAllSaleTimes(): Promise<SaleTimeInfo[]> {
  const r = await request<{ status: boolean; data?: Record<string, string>[] }>(
    `${API_BASE}/otn/index12306/queryAllCacheSaleTime`,
    {}
  );
  return (r.data ?? []).map((d) => ({
    stationName: d.station_name,
    telecode: d.station_telecode,
    saleTime: d.sale_time ?? '',
    bureau: d.bureau_code ?? '',
  }));
}

/** 同城车站名列表（官网起售时间页同款接口，可能返回空） */
export async function querySameCityStations(telecode: string): Promise<string[]> {
  const r = await request<{ data?: string[] }>(
    `${API_BASE}/otn/index12306/queryScSname`,
    { station_telecode: telecode }
  );
  return r.data ?? [];
}

/** 列车开行/停运状态查询（POST /otn/index12306/queryTrainStatus，返回说明文本） */
export async function queryTrainStatus(trainNo: string, date: string): Promise<string> {
  const r = await postForm<{ data?: { result?: string; data?: string } }>(
    `${API_BASE}/otn/index12306/queryTrainStatus`,
    { train_no: trainNo, train_date: date }
  );
  return r.data?.data ?? '无数据';
}

/** 检票口查询（POST /otn/index12306/queryTicketCheck，临近开车才有数据） */
export async function queryTicketCheckGate(
  trainCode: string,
  fromTelecode: string,
  date: string
): Promise<string> {
  const r = await postForm<{ data?: { result?: string; trainPlatform?: string } }>(
    `${API_BASE}/otn/index12306/queryTicketCheck`,
    { trainDate: date, station_train_code: trainCode, from_station_telecode: fromTelecode }
  );
  if (r.data?.result !== 'Y') throw new Error('查询失败（可能触发了滑块校验）');
  return r.data.trainPlatform ?? '';
}

export async function queryTrainRoute(
  trainNo: string,
  date: string
): Promise<TrainRouteStop[]> {
  const r = await request<TrainRouteResponse>(`${API_BASE}/otn/queryTrainInfo/query`, {
    'leftTicketDTO.train_no': trainNo,
    'leftTicketDTO.train_date': date,
    rand_code: '',
  });
  const stops = r.data?.data;
  if (!stops) throw new Error('未获取到经停站数据');
  return stops;
}
