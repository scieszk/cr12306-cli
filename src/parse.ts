/**
 * leftTicket 返回的 result 行是 '|' 分隔的定序字段串，索引含义来自社区多年验证。
 * 接口方随时可能调整，挂了先查这里。
 */

export interface TicketInfo {
  trainNo: string;
  code: string; // 车次，如 G8502
  fromTele: string;
  toTele: string;
  fromStation: string;
  toStation: string;
  startTime: string;
  arriveTime: string;
  duration: string;
  startDate: string;
  canBuy: boolean;
  dwFlag: string; // 动车组标记（可能含"复兴号"/"智能动车组"）
  seats: Record<string, string>; // 席别 -> 余票
}

const SEAT_FIELDS: Array<[number, string]> = [
  [21, '高级软卧'],
  [23, '软卧'],
  [24, '软座'],
  [25, '特等座'],
  [26, '无座'],
  [28, '硬卧'],
  [29, '硬座'],
  [30, '二等座'],
  [31, '一等座'],
  [32, '商务座'],
  [33, '动卧'],
];

/** 中转联程 fullList 的席别字段（对象键名，与左票定序串不同体系） */
const SEAT_KEYS: Array<[string, string]> = [
  ['swz_num', '商务座'],
  ['tz_num', '特等座'],
  ['zy_num', '一等座'],
  ['ze_num', '二等座'],
  ['gr_num', '高级软卧'],
  ['rw_num', '软卧'],
  ['srrb_num', '动卧'],
  ['yw_num', '硬卧'],
  ['rz_num', '软座'],
  ['yz_num', '硬座'],
  ['wz_num', '无座'],
];

/** 中转联程 fullList 元素是已解析好的对象（非 '|' 定序串），单独解析 */
export function parseTicketObject(o: Record<string, string>): TicketInfo {
  const seats: Record<string, string> = {};
  for (const [key, label] of SEAT_KEYS) {
    const v = o[key];
    if (v && v !== '' && v !== '--') seats[label] = v;
  }
  return {
    trainNo: o.train_no ?? '',
    code: o.station_train_code ?? '',
    fromTele: o.from_station_telecode ?? '',
    toTele: o.to_station_telecode ?? '',
    fromStation: o.from_station_name ?? '',
    toStation: o.to_station_name ?? '',
    startTime: o.start_time ?? '',
    arriveTime: o.arrive_time ?? '',
    duration: o.lishi ?? '',
    startDate: o.start_train_date ?? '',
    canBuy: o.canWebBuy === 'Y',
    dwFlag: decodeDwFlag(o.dw_flag ?? ''),
    seats,
  };
}

/**
 * 解码 dw_flag（f[46]）。12306 已将该字段从中文文本改为 "#" 分隔编码，
 * 官方页面解析逻辑（queryLeftTicket_end_js.js）：
 *   [0]=='5' → 智能动车组；[1]=='1' → 复兴号；
 *   [2] 以 'Q' 开头 → 静音车厢；以 'R' 开头 → 温馨动卧；[5]=='D' → 动感号
 * 兼容旧格式：若已含中文则原样返回。
 */
export function decodeDwFlag(raw: string): string {
  if (!raw) return '';
  if (/[一-龥]/.test(raw)) return raw; // 旧格式已是中文
  const p = raw.split('#');
  const tags: string[] = [];
  if (p[0] === '5') tags.push('智能动车组');
  if (p.length > 1 && p[1] === '1') tags.push('复兴号');
  if (p.length > 2 && p[2].startsWith('Q')) tags.push('静音车厢');
  if (p.length > 2 && p[2].startsWith('R')) tags.push('温馨动卧');
  if (p.length > 5 && p[5] === 'D') tags.push('动感号');
  return tags.join(' ');
}

export interface SmartTransfer {
  leg1: TicketInfo;
  leg2: TicketInfo;
  waitMin: number; // 换乘等待（分钟）
  totalMin: number; // 全程（分钟）
}

function hhmmToMin(s: string, duration = false): number {
  if (!/^\d{1,3}:[0-5]\d$/.test(s)) return NaN;
  const [h, m] = s.split(':').map(Number);
  if (!duration && h > 23) return NaN;
  return h * 60 + m;
}

/** 是否有任意席别可订（余票为"有"或数字） */
export function hasBookableSeat(t: TicketInfo): boolean {
  return t.canBuy && Object.values(t.seats).some((v) => v === '有' || (/^\d+$/.test(v) && Number(v) > 0));
}

/**
 * 自建中转拼接（绕开官方 lcquery 的"前10条按历时精选"限制）：
 * 两段查询日期必须相同；只支持首段当日到达、同站当日换乘。
 * 第二段可以跨日到达。startDate 是列车始发日期，不能当作乘车日期。
 */
export function joinTransfers(
  leg1List: TicketInfo[],
  leg2List: TicketInfo[],
  minWait = 15,
  maxWait = 90,
): SmartTransfer[] {
  const out: SmartTransfer[] = [];
  for (const a of leg1List) {
    if (!hasBookableSeat(a)) continue;
    const firstDuration = hhmmToMin(a.duration, true);
    const firstArrival = hhmmToMin(a.startTime) + firstDuration;
    // Both API queries use the same boarding date. An overnight first leg
    // would need a separate next-day query before it can safely be paired.
    if (!Number.isFinite(firstArrival) || firstDuration <= 0 || firstArrival >= 1440 || firstArrival !== hhmmToMin(a.arriveTime)) continue;
    for (const b of leg2List) {
      if (!hasBookableSeat(b)) continue;
      if (!a.toTele || a.toTele !== b.fromTele) continue;
      const secondStart = hhmmToMin(b.startTime);
      const secondDuration = hhmmToMin(b.duration, true);
      if (!Number.isFinite(secondDuration) || secondDuration <= 0 || (secondStart + secondDuration) % 1440 !== hhmmToMin(b.arriveTime)) continue;
      const wait = secondStart - firstArrival;
      if (wait < 0 || wait < minWait || wait > maxWait) continue;
      out.push({ leg1: a, leg2: b, waitMin: wait, totalMin: firstDuration + wait + secondDuration });
    }
  }
  return out.sort((x, y) => x.totalMin - y.totalMin);
}

export function parseTickets(result: string[], stationMap: Record<string, string> = {}): TicketInfo[] {
  const out: TicketInfo[] = [];
  for (const row of result) {
    const f = row.split('|');
    if (f.length < 34) continue;
    const seats: Record<string, string> = {};
    for (const [idx, label] of SEAT_FIELDS) {
      const v = f[idx];
      if (v && v !== '') seats[label] = v;
    }
    out.push({
      trainNo: f[2],
      code: f[3],
      fromTele: f[6],
      toTele: f[7],
      fromStation: stationMap[f[6]] ?? f[6],
      toStation: stationMap[f[7]] ?? f[7],
      startTime: f[8],
      arriveTime: f[9],
      duration: f[10],
      startDate: f[13],
      canBuy: f[11] === 'Y',
      dwFlag: decodeDwFlag(f[46] ?? ''),
      seats,
    });
  }
  return out;
}
