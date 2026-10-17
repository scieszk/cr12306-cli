import { createHash } from 'node:crypto';
import { CliError } from './errors.js';
import { queryLeftTickets } from './api.js';
import { hasBookableSeat, parseTickets, SEAT_NAMES } from './parse.js';
import type { TicketInfo } from './parse.js';
import type { RoundtripPlan } from './roundtrip.js';
import { readPrivateJson, writePrivateJson } from './private-store.js';
import { assertDate } from './cli-options.js';

interface WatchLeg {
  date: string; fromTele: string; toTele: string; trainNo: string; code: string;
  startTime: string; arriveTime: string; duration: string; bookable: boolean;
}
interface WatchBaseline { schema_version: '1.0'; kind: 'roundtrip'; created_at: string; seat?: string; outbound: WatchLeg; return: WatchLeg }
interface LastCheck { baseline: string; signature: string; unavailable: boolean }
interface Change { leg?: 'outbound' | 'return'; field: string; before: boolean | string; after: boolean | string }
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function saveWatch(path: string, plan: RoundtripPlan, seat: string | undefined, queriedAt: string): Promise<void> {
  const leg = (t: TicketInfo, date: string): WatchLeg => ({ date, fromTele: t.fromTele, toTele: t.toTele, trainNo: t.trainNo, code: t.code, startTime: t.startTime, arriveTime: t.arriveTime, duration: t.duration, bookable: hasBookableSeat(t, seat) });
  const baseline: WatchBaseline = { schema_version: '1.0', kind: 'roundtrip', created_at: queriedAt, ...(seat ? { seat } : {}), outbound: leg(plan.outbound, plan.outboundDate), return: leg(plan.return, plan.returnDate) };
  await writePrivateJson(path, baseline);
  // Saving is an explicit confirmation, so discard stale or corrupt notification state.
  await writePrivateJson(path.replace(/\.watch\.json$/, '.state.watch.json'), { baseline: digest(baseline), signature: digest([]), unavailable: false });
}

async function readBaseline(path: string): Promise<WatchBaseline> {
  try {
    const value = await readPrivateJson(path);
    if (!object(value) || value.schema_version !== '1.0' || value.kind !== 'roundtrip' || typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at)) || (value.seat !== undefined && (typeof value.seat !== 'string' || !SEAT_NAMES.includes(value.seat)))) throw new Error();
    for (const leg of [value.outbound, value.return]) {
      if (!object(leg) || !['date', 'fromTele', 'toTele', 'trainNo', 'code', 'startTime', 'arriveTime', 'duration'].every((key) => typeof leg[key] === 'string' && leg[key]) || typeof leg.bookable !== 'boolean') throw new Error();
      assertDate(leg.date as string);
      if (!/^[A-Z]{3}$/.test(leg.fromTele as string) || !/^[A-Z]{3}$/.test(leg.toTele as string)) throw new Error();
      for (const time of [leg.startTime, leg.arriveTime]) if (!/^(?:[01]?\d|2[0-3]):[0-5]\d$/.test(time as string)) throw new Error();
      if (!/^\d{1,3}:[0-5]\d$/.test(leg.duration as string)) throw new Error();
    }
    const baseline = value as unknown as WatchBaseline;
    if (baseline.return.date < baseline.outbound.date || baseline.outbound.fromTele !== baseline.return.toTele || baseline.outbound.toTele !== baseline.return.fromTele) throw new Error();
    return baseline;
  } catch { throw new CliError('WATCH_INVALID'); }
}

async function readState(path: string, baselineHash: string): Promise<LastCheck | undefined> {
  try {
    const value = await readPrivateJson(path);
    if (!object(value) || typeof value.baseline !== 'string' || typeof value.signature !== 'string' || typeof value.unavailable !== 'boolean') throw new Error();
    return value.baseline === baselineHash ? value as unknown as LastCheck : undefined;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
    throw new CliError('WATCH_INVALID');
  }
}

export async function checkWatch(path: string): Promise<{ state: 'changed' | 'unchanged'; notify: boolean; changes: Change[] }> {
  const baseline = await readBaseline(path);
  const baselineHash = digest(baseline);
  const statePath = path.replace(/\.watch\.json$/, '.state.watch.json');
  const previous = await readState(statePath, baselineHash);
  const changes: Change[] = [];
  let unavailable = false;
  try {
    for (const direction of ['outbound', 'return'] as const) {
      const leg = baseline[direction];
      // A departed service cannot be meaningfully watched through the future-ticket endpoint.
      if (Date.parse(`${leg.date}T${leg.startTime.padStart(5, '0')}:00+08:00`) <= Date.now()) throw new Error();
      const result = await queryLeftTickets(leg.date, leg.fromTele, leg.toTele);
      const ticket = parseTickets(result.data!.result!, result.data?.map).find((t) => t.trainNo === leg.trainNo && t.code === leg.code && t.fromTele === leg.fromTele && t.toTele === leg.toTele);
      if (!ticket) throw new Error();
      const current = { bookable: hasBookableSeat(ticket, baseline.seat), startTime: ticket.startTime, arriveTime: ticket.arriveTime, duration: ticket.duration };
      for (const field of ['bookable', 'startTime', 'arriveTime', 'duration'] as const) {
        if (leg[field] !== current[field]) changes.push({ leg: direction, field, before: leg[field], after: current[field] });
      }
    }
  } catch { unavailable = true; }
  // One unavailable signature avoids notification storms from varying upstream errors.
  const signature = digest(unavailable ? 'unavailable' : changes);
  const notify = signature !== previous?.signature && (unavailable || changes.length > 0 || previous?.unavailable === true || (previous !== undefined && signature !== previous.signature));
  await writePrivateJson(statePath, { baseline: baselineHash, signature, unavailable });
  if (unavailable) throw new CliError('WATCH_UNAVAILABLE', undefined, notify);
  if (previous?.unavailable) changes.push({ field: 'availability', before: 'unavailable', after: 'available' });
  return { state: changes.some((c) => c.leg) ? 'changed' : 'unchanged', notify, changes };
}
