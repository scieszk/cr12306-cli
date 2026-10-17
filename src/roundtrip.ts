import { hasBookableSeat } from './parse.js';
import type { TicketInfo } from './parse.js';

export interface RoundtripPlan {
  outbound: TicketInfo;
  return: TicketInfo;
  outboundDate: string;
  returnDate: string;
  outboundDeparture: string;
  destinationArrival: string;
  returnDeparture: string;
  homeArrival: string;
  stayMin: number;
  totalTravelMin: number;
  totalElapsedMin: number;
}

function shanghai(ms: number): string {
  return new Date(ms + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00';
}

function times(ticket: TicketInfo, date: string) {
  if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(ticket.startTime) || !/^\d{1,3}:[0-5]\d$/.test(ticket.duration)) return null;
  const [hour, min] = ticket.duration.split(':').map(Number);
  const duration = hour * 60 + min;
  const departure = Date.parse(`${date}T${ticket.startTime.padStart(5, '0')}:00+08:00`);
  const arrival = departure + duration * 60_000;
  if (!Number.isFinite(arrival) || duration <= 0 || shanghai(arrival).slice(11, 16) !== ticket.arriveTime.padStart(5, '0')) return null;
  return { departure, arrival, duration };
}

export function pairRoundtrips(outbound: TicketInfo[], inbound: TicketInfo[], outboundDate: string, returnDate: string,
  options: { minStay: number; limit: number; seat?: string; outboundEarliest?: string; outboundLatest?: string; returnEarliest?: string; returnLatest?: string }): RoundtripPlan[] {
  const inWindow = (t: TicketInfo, earliest?: string, latest?: string) => (!earliest || t.startTime.padStart(5, '0') >= earliest) && (!latest || t.startTime.padStart(5, '0') <= latest);
  const plans: RoundtripPlan[] = [];
  for (const a of outbound) {
    if (!hasBookableSeat(a, options.seat) || !inWindow(a, options.outboundEarliest, options.outboundLatest)) continue;
    const first = times(a, outboundDate);
    if (!first || first.departure < Date.now()) continue;
    for (const b of inbound) {
      if (!hasBookableSeat(b, options.seat) || !inWindow(b, options.returnEarliest, options.returnLatest)) continue;
      if (a.fromTele !== b.toTele || a.toTele !== b.fromTele) continue;
      const second = times(b, returnDate);
      if (!second) continue;
      const stayMin = (second.departure - first.arrival) / 60_000;
      if (stayMin < options.minStay) continue;
      plans.push({ outbound: a, return: b, outboundDate, returnDate,
        outboundDeparture: shanghai(first.departure), destinationArrival: shanghai(first.arrival), returnDeparture: shanghai(second.departure), homeArrival: shanghai(second.arrival),
        stayMin, totalTravelMin: first.duration + second.duration, totalElapsedMin: (second.arrival - first.departure) / 60_000 });
    }
  }
  return plans.sort((a, b) => a.totalTravelMin - b.totalTravelMin || b.stayMin - a.stayMin || a.outboundDeparture.localeCompare(b.outboundDeparture)).slice(0, options.limit);
}

export function itineraryCard(plan: RoundtripPlan, queriedAt: string, seat?: string): string {
  const safe = (value: string) => value.replace(/[\\`*_{}\[\]<>#|\r\n]/g, ' ');
  const leg = (label: string, ticket: TicketInfo, departure: string, arrival: string) =>
    `- ${label}：${safe(ticket.code)} ${safe(ticket.fromStation)} → ${safe(ticket.toStation)}，${departure} 出发，${arrival} 到达。`;
  return ['# 往返行程卡', '', leg('去程', plan.outbound, plan.outboundDeparture, plan.destinationArrival), leg('返程', plan.return, plan.returnDeparture, plan.homeArrival),
    `- 目的地停留：${plan.stayMin} 分钟；乘车共 ${plan.totalTravelMin} 分钟。`, `- 席别：${seat ? safe(seat) : '任意可购席别（两程可能不同）'}。`, '',
    `查询时间：${queriedAt}。来源：[12306](https://www.12306.cn/)。`, '余票可能变化；本卡不是车票，也不保证购票成功。请以 12306 与车站公告为准。'].join('\n');
}
