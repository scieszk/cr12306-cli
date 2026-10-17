import { Command } from 'commander';
import { emitResult, integer, queryOptions, assertDate } from './cli-options.js';
import type { OutputOptions } from './cli-options.js';
import { CliError } from './errors.js';
import { loadPreferences, setPreference, resetPreferences, watchPath } from './private-store.js';
import { queryLeftTickets } from './api.js';
import { resolveTelecode } from './stations.js';
import { parseTickets, SEAT_NAMES } from './parse.js';
import { pairRoundtrips, itineraryCard } from './roundtrip.js';
import { saveWatch, checkWatch } from './watch.js';
import { table } from './format.js';

interface RoundtripOptions extends OutputOptions {
  returnDate?: string; outboundEarliest?: string; outboundLatest?: string; returnEarliest?: string; returnLatest?: string;
  minStay: string; seat?: string; limit: string; select: string; card?: boolean; saveWatch?: string | true;
}

export function registerPlanningCommands(program: Command, today: () => string): void {
  program.command('roundtrip <from> <to> [date]')
    .description('组合直达往返车次，按实际到达时间计算目的地停留')
    .option('--return-date <date>', '返程乘车日期 yyyy-MM-dd，默认与去程相同')
    .option('--outbound-earliest <hh:mm>', '去程发车时间下限 HH:MM')
    .option('--outbound-latest <hh:mm>', '去程发车时间上限 HH:MM')
    .option('--return-earliest <hh:mm>', '返程发车时间下限 HH:MM')
    .option('--return-latest <hh:mm>', '返程发车时间上限 HH:MM')
    .option('--min-stay <min>', '目的地至少停留分钟数（0~10080）', '60')
    .option('--seat <name>', '两程均须有该席别现票，如 二等座')
    .option('-n, --limit <num>', '最多显示方案数（1~100）', '10')
    .option('--select <num>', '行程卡/监测选择第几个显示方案，从1开始', '1')
    .option('--card', '输出所选方案的 Markdown 行程卡，不能与 JSON 模式组合')
    .option('--save-watch [file]', '保存所选方案的私有监测基线，默认在用户配置目录')
    .option('--json', '输出 JSON')
    .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
    .action(async (from: string, to: string, date: string | undefined, opts: RoundtripOptions) => {
      const outboundDate = assertDate(date ?? today());
      const returnDate = assertDate(opts.returnDate ?? outboundDate);
      if (returnDate < outboundDate || (opts.card && (opts.structured || opts.json))) throw new CliError('INVALID_ARGUMENT');
      const preferences = await loadPreferences();
      const filters = {
        outboundEarliest: opts.outboundEarliest ?? preferences.earliest, outboundLatest: opts.outboundLatest ?? preferences.latest,
        returnEarliest: opts.returnEarliest ?? preferences.earliest, returnLatest: opts.returnLatest ?? preferences.latest,
        seat: opts.seat ?? preferences.seat, minStay: integer(opts.minStay, '--min-stay', 0, 10080), limit: integer(opts.limit, '--limit', 1, 100),
      };
      queryOptions({ earliest: filters.outboundEarliest, latest: filters.outboundLatest, sort: 'start', limit: '1' });
      queryOptions({ earliest: filters.returnEarliest, latest: filters.returnLatest, sort: 'start', limit: '1' });
      if (filters.seat !== undefined && !SEAT_NAMES.includes(filters.seat)) throw new CliError('INVALID_ARGUMENT');
      const selected = integer(opts.select, '--select', 1, 100);
      const target = opts.saveWatch ? watchPath(opts.saveWatch) : undefined;
      const [f, t] = await Promise.all([resolveTelecode(from), resolveTelecode(to)]);
      if (f.telecode === t.telecode) throw new CliError('INVALID_ARGUMENT', '往返起点与目的地应不同');
      const [out, back] = await Promise.all([queryLeftTickets(outboundDate, f.telecode, t.telecode), queryLeftTickets(returnDate, t.telecode, f.telecode)]);
      const exact = (r: typeof out, fromTele: string, toTele: string) => parseTickets(r.data!.result!, r.data?.map).filter((ticket) => ticket.fromTele === fromTele && ticket.toTele === toTele);
      const plans = pairRoundtrips(exact(out, f.telecode, t.telecode), exact(back, t.telecode, f.telecode), outboundDate, returnDate, filters);
      const queriedAt = new Date().toISOString();
      const selection = plans[selected - 1];
      if ((opts.card || target) && !selection) throw new CliError('INVALID_ARGUMENT', '没有可选择的方案，请调整筛选或 --select');
      if (target) await saveWatch(target, selection, filters.seat, queriedAt);
      if (opts.card) {
        console.log(itineraryCard(selection, queriedAt, filters.seat));
        if (target) console.error(`监测基线：${target}`);
        return;
      }
      if (emitResult(opts, 'roundtrip', target ? { plans, watch_file: target } : plans)) return;
      if (!plans.length) { console.log('暂无满足条件的直达往返方案'); return; }
      console.log(table(['方案', '去程', '返程', '目的地到达', '返程出发', '停留分钟', '乘车分钟'], plans.map((p, index) => [String(index + 1), p.outbound.code, p.return.code, p.destinationArrival, p.returnDeparture, String(p.stayMin), String(p.totalTravelMin)])));
      if (target) console.log(`监测基线：${target}`);
    });

  const preferences = program.command('preferences').description('显示、设置或重置私有查询偏好');
  for (const [name, description, action] of [
    ['show', '显示当前偏好', async () => loadPreferences()],
    ['reset', '清空偏好（也可修复无效的偏好文件）', async () => resetPreferences()],
  ] as const) {
    preferences.command(name).description(description).option('--structured', '输出统一 JSON 响应').action(async (opts: OutputOptions) => {
      emitResult({ json: true, ...opts }, 'preferences', await action());
    });
  }
  preferences.command('set <key> <value>').description('设置 seat/minWait/maxWait/earliest/latest 之一')
    .option('--structured', '输出统一 JSON 响应')
    .action(async (key: string, value: string, opts: OutputOptions) => { emitResult({ json: true, ...opts }, 'preferences', await setPreference(key, value)); });

  program.command('watch').description('手动检查私有基线的变化，不安排定时任务或发送消息')
    .command('check <file>').description('与已确认方案比较；输出机器数据并去重变化，基线不变')
    .option('--structured', '输出统一 JSON 响应（默认开启）')
    .action(async (file: string) => { emitResult({ structured: true }, 'watch', await checkWatch(watchPath(file))); });
}
