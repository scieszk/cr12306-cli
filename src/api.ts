/**
 * 12306 网站自用接口的只读封装。
 * 注意：这些接口非官方对第三方授权，随时可能变更/失效，低调使用。
 */

import { parseTicketObject } from './parse.js';
import type { TicketInfo } from './parse.js';
import { CliError } from './errors.js';

export const API_BASE = 'https://kyfw.12306.cn';
export const SEARCH_BASE = 'https://search.12306.cn';

const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

let cachedCookie: string | null = null;
let cookieRequest: Promise<string> | null = null;
let cachedTicketPath: string | null = null;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function ensure(condition: unknown): asserts condition {
  if (!condition) throw new CliError('UPSTREAM_INVALID_RESPONSE');
}

function validateEnvelope(value: unknown): void {
  ensure(record(value));
  if (value.status !== undefined) ensure(typeof value.status === 'boolean');
  if (value.status === false || (value.httpstatus !== undefined && String(value.httpstatus) !== '200') || value.errorMsg) {
    throw new CliError('UPSTREAM_REJECTED');
  }
}

async function readJson<T>(response: Response, validate = true): Promise<T> {
  let value: unknown;
  try { value = await response.json(); }
  catch (error) {
    if (error instanceof SyntaxError) throw new CliError('UPSTREAM_INVALID_RESPONSE');
    throw error;
  }
  if (validate) validateEnvelope(value);
  return value as T;
}

/** Only these relative endpoint names may be appended to our fixed official origin. */
function ticketPath(value: unknown): string | null {
  return typeof value === 'string' && /^leftTicket\/query[A-Za-z]{0,8}$/.test(value) ? value : null;
}

/** Abort covers both response headers and body consumption. */
function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(15_000) });
}

/** 打 leftTicket/init 拿会话 cookie（RAIL_DEVICEID / RAIL_EXPIRATION） */
export async function getCookie(): Promise<string> {
  if (cachedCookie !== null) return cachedCookie;
  if (!cookieRequest) cookieRequest = initializeSession();
  try { return await cookieRequest; }
  finally { cookieRequest = null; }
}

async function initializeSession(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/otn/leftTicket/init`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new CliError('UPSTREAM_HTTP_ERROR');
  const setCookies =
    (res.headers as unknown as { getSetCookie?: () => string[] }).getSetCookie?.() ??
    [];
  const cookie = setCookies.map((c) => c.split(';')[0]).join('; ');
  // Parse the string assignment, never execute the upstream script.
  const html = await res.text();
  const hint = html.match(/\bCLeftTicketUrl\s*=\s*(['"])([^'"\r\n]{1,64})\1/)?.[2];
  cachedTicketPath = ticketPath(hint);
  cachedCookie = cookie;
  return cachedCookie;
}

async function request<T>(url: string, params: Record<string, string>, validate = true): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const headers: Record<string, string> = { 'User-Agent': UA };
  headers['Cookie'] = await getCookie();
  const res = await fetchWithTimeout(`${url}?${qs}`, { headers });
  if (!res.ok) throw new CliError('UPSTREAM_HTTP_ERROR');
  return readJson<T>(res, validate);
}

/** POST 表单请求（12306 部分接口只接受 POST） */
async function postForm<T>(url: string, params: Record<string, string>): Promise<T> {
  const headers: Record<string, string> = {
    'User-Agent': UA,
    'Content-Type': 'application/x-www-form-urlencoded',
    Cookie: await getCookie(),
  };
  const res = await fetchWithTimeout(url, { method: 'POST', headers, body: new URLSearchParams(params).toString() });
  if (!res.ok) throw new CliError('UPSTREAM_HTTP_ERROR');
  return readJson<T>(res);
}

/* ---------- 车站电报码 ---------- */

export async function fetchStationNameJs(): Promise<string> {
  const res = await fetchWithTimeout(`${API_BASE}/otn/resources/js/framework/station_name.js`, {
    headers: { 'User-Agent': UA },
  });
  if (!res.ok) throw new CliError('UPSTREAM_HTTP_ERROR');
  return res.text();
}

/* ---------- 余票查询 ---------- */

export interface LeftTicketsResponse {
  status?: boolean;
  messages?: string;
  c_url?: string;
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
  await getCookie();
  const variants = [...(cachedTicketPath ? [cachedTicketPath] : []), 'leftTicket/queryG', 'leftTicket/queryA', 'leftTicket/query'];
  const tried = new Set<string>();
  let acceptedHint = false;
  let lastErr: unknown = new CliError('UPSTREAM_INVALID_RESPONSE');
  while (variants.length && tried.size < 5) {
    const path = variants.shift()!;
    if (tried.has(path)) continue;
    tried.add(path);
    try {
      const r = await request<LeftTicketsResponse>(`${API_BASE}/otn/${path}`, {
        'leftTicketDTO.train_date': date,
        'leftTicketDTO.from_station': fromTele,
        'leftTicketDTO.to_station': toTele,
        purpose_codes: 'ADULT',
      }, false);
      const hint = record(r) ? ticketPath(r.c_url) : null;
      if (!acceptedHint && hint && !tried.has(hint)) {
        acceptedHint = true;
        variants.unshift(hint);
      }
      validateEnvelope(r);
      ensure(record(r.data) && Array.isArray(r.data.result));
      ensure(r.data.map === undefined || (record(r.data.map) && Object.values(r.data.map).every((v) => typeof v === 'string')));
      ensure(r.data.result.every((row) => {
        if (typeof row !== 'string') return false;
        const fields = row.split('|');
        return fields.length >= 34 && [2, 3, 11].every((index) => fields[index])
          && [6, 7].every((index) => /^[A-Z]{3}$/.test(fields[index]))
          && [8, 9].every((index) => /^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(fields[index]))
          && /^\d{1,3}:[0-5]\d$/.test(fields[10]);
      }));
      cachedTicketPath = path;
      return r;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr;
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
  ensure(Array.isArray(r.data) && r.data.every((d) => record(d) && typeof d.train_no === 'string' && d.train_no && typeof d.station_train_code === 'string' && d.station_train_code));
  const hit = r.data.find(
    (d) => d.station_train_code.replace(/\s*[（(][^()（）]*[)）]\s*$/, '').trim().toUpperCase() === trainCode.trim().toUpperCase()
  );
  if (!hit) throw new CliError('TRAIN_NOT_FOUND', `未查询到车次 ${trainCode}（${date}）`);
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
  if (!res.ok) throw new CliError('UPSTREAM_HTTP_ERROR');
  const r = await readJson<{ status?: boolean; data?: { message?: string } }>(res);
  const msg = r.data?.message;
  ensure(typeof msg === 'string');
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
    const list = r.data?.middleList;
    ensure(Array.isArray(list));
    let added = 0;
    for (const m of list) {
      ensure(record(m) && ['all_lishi', 'start_time', 'arrive_time', 'from_station_name', 'middle_station_name', 'end_station_name', 'same_station'].every((key) => typeof m[key] === 'string'));
      ensure(Number.isFinite(m.all_lishi_minutes) && m.all_lishi_minutes > 0);
      ensure(Array.isArray(m.fullList) && m.fullList.length === 2 && m.fullList.every((leg) => record(leg) && ['station_train_code', 'from_station_telecode', 'to_station_telecode', 'start_time', 'arrive_time', 'lishi'].every((key) => typeof leg[key] === 'string' && leg[key])));
      ensure(m.fullList.every((leg) => ['train_no', 'from_station_name', 'to_station_name', 'start_train_date', 'canWebBuy', 'dw_flag', 'swz_num', 'tz_num', 'zy_num', 'ze_num', 'gr_num', 'rw_num', 'srrb_num', 'yw_num', 'rz_num', 'yz_num', 'wz_num'].every((key) => leg[key] === undefined || typeof leg[key] === 'string')));
      const legs = m.fullList.map(parseTicketObject);
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
  ensure(Array.isArray(r.data) && r.data.every((d) => record(d) && typeof d.station_name === 'string' && d.station_name && typeof d.station_telecode === 'string' && d.station_telecode && (d.sale_time === undefined || typeof d.sale_time === 'string') && (d.bureau_code === undefined || typeof d.bureau_code === 'string')));
  return r.data.map((d) => ({
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
  ensure(Array.isArray(r.data) && r.data.every((name) => typeof name === 'string' && name));
  return r.data;
}

/** 列车开行/停运状态查询（POST /otn/index12306/queryTrainStatus，返回说明文本） */
export async function queryTrainStatus(trainNo: string, date: string): Promise<string> {
  const r = await postForm<{ data?: { result?: string; data?: string } }>(
    `${API_BASE}/otn/index12306/queryTrainStatus`,
    { train_no: trainNo, train_date: date }
  );
  ensure(record(r.data));
  if (r.data.result !== undefined && r.data.result !== 'Y') throw new CliError('UPSTREAM_REJECTED');
  ensure(typeof r.data.data === 'string');
  return r.data.data;
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
  ensure(record(r.data) && typeof r.data.result === 'string');
  if (r.data.result !== 'Y') throw new CliError('UPSTREAM_REJECTED');
  ensure(r.data.trainPlatform === undefined || typeof r.data.trainPlatform === 'string');
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
  ensure(Array.isArray(stops) && stops.every((s) => record(s) && typeof s.station_name === 'string' && s.station_name && ['station_no', 'start_time', 'arrive_time', 'stopover_time'].every((key) => s[key] === undefined || typeof s[key] === 'string')));
  return stops;
}
