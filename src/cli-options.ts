import { CliError, publicError } from './errors.js';
import { SEAT_NAMES } from './parse.js';

export interface OutputOptions { json?: boolean; structured?: boolean }

function metadata(command: string) {
  return { schema_version: '1.0', command, queried_at: new Date().toISOString(), sources: [{ name: '12306', url: 'https://www.12306.cn/' }] };
}

export function emitResult(opts: OutputOptions, command: string, data: unknown): boolean {
  if (opts.structured) console.log(JSON.stringify({ ...metadata(command), ok: true, data }));
  else if (opts.json) console.log(JSON.stringify(data, null, 2));
  else return false;
  return true;
}

export function emitFailure(command: string, error: unknown): void {
  console.log(JSON.stringify({ ...metadata(command), ok: false, error: publicError(error) }));
}

export function integer(raw: string, option: string, min: number, max: number): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new CliError('INVALID_ARGUMENT', `${option} 应为 ${min}~${max} 之间的整数`);
  }
  return value;
}

export function assertDate(d: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) throw new CliError('INVALID_ARGUMENT', '日期格式应为 yyyy-MM-dd');
  const parsed = new Date(`${d}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== d) throw new CliError('INVALID_ARGUMENT', '日期不存在');
  return d;
}

export function queryOptions(opts: { limit: string; sort: string; earliest?: string; latest?: string }): number {
  const limit = integer(opts.limit, '--limit', 1, 1000);
  for (const value of [opts.earliest, opts.latest]) {
    if (value !== undefined && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) {
      throw new CliError('INVALID_ARGUMENT', '--earliest/--latest 应为有效 HH:MM（00:00~23:59）');
    }
  }
  if (opts.earliest && opts.latest && opts.earliest > opts.latest) {
    throw new CliError('INVALID_ARGUMENT', '--earliest 不能晚于 --latest');
  }
  if (!['start', 'arrive', 'duration'].includes(opts.sort)) {
    throw new CliError('INVALID_ARGUMENT', '--sort 应为 start、arrive 或 duration');
  }
  return limit;
}

export function transferOptions(opts: { limit: string; waitMin: string; waitMax: string; smart?: boolean; middle?: string; seat?: string; maxDuration?: string }) {
  const limit = integer(opts.limit, '--limit', 1, 300);
  const minWait = integer(opts.waitMin, '--wait-min', 0, 1440);
  const maxWait = integer(opts.waitMax, '--wait-max', 0, 1440);
  if (minWait > maxWait) throw new CliError('INVALID_ARGUMENT', '--wait-min 不能大于 --wait-max');
  if (opts.smart && !opts.middle) throw new CliError('INVALID_ARGUMENT', '--smart 需配合 --middle 指定中转站');
  if ((opts.seat !== undefined || opts.maxDuration !== undefined) && !opts.smart) {
    throw new CliError('INVALID_ARGUMENT', '--seat/--max-duration 仅适用于 --smart');
  }
  if (opts.seat !== undefined && !SEAT_NAMES.includes(opts.seat)) {
    throw new CliError('INVALID_ARGUMENT', `--seat 应为：${SEAT_NAMES.join('、')}`);
  }
  const maxDuration = opts.maxDuration === undefined ? undefined : integer(opts.maxDuration, '--max-duration', 1, 10080);
  return { limit, minWait, maxWait, seat: opts.seat, maxDuration };
}
