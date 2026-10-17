#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { queryLeftTickets, searchTrainNo, queryTrainRoute, queryInterline, queryDelay, queryAllSaleTimes, querySameCityStations, queryTrainStatus, queryTicketCheckGate } from './api.js';

import { searchStations, resolveTelecode } from './stations.js';
import { parseTickets, joinTransfers } from './parse.js';
import { table } from './format.js';
import { emitResult, emitFailure, queryOptions, transferOptions, assertDate } from './cli-options.js';
import { CliError } from './errors.js';
import { loadPreferences } from './private-store.js';
import { registerPlanningCommands } from './planning-cli.js';

/** 上海时区的今天，yyyy-MM-dd */
export function todayShanghai(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  return parts; // en-CA 即 yyyy-MM-dd
}

const program = new Command();
program
  .name('cr12306')
  .description('12306 查询 CLI（只读接口，非官方授权，低调使用）')
  .version('0.2.0');

program
  .command('stations <keyword>')
  .description('按中文名/拼音/电报码搜索车站')
  .option('--json', '输出 JSON')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (keyword: string, opts: { json?: boolean; structured?: boolean }) => {
    const hits = await searchStations(keyword);
    if (emitResult(opts, 'stations', hits)) return;
    if (hits.length === 0) {
      console.log('未找到匹配车站');
      return;
    }
    console.log(
      table(
        ['站名', '电报码', '拼音'],
        hits.map((s) => [s.name, s.telecode, s.pinyin])
      )
    );
  });

/** "2:37"/"02:37" → 分钟数，用于历时排序 */
function durationMin(s: string): number {
  const [a, b] = s.split(':').map(Number);
  return (a || 0) * 60 + (b || 0);
}

program
  .command('query <from> <to> [date]')
  .description('查询区间车次与余票（date 缺省为今天，yyyy-MM-dd）')
  .option('--json', '输出 JSON')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .option('-t, --type <prefix>', '按车次前缀过滤，如 G / D / Z / T / K')
  .option('--fx', '只看复兴号')
  .option('--zn', '只看智能动车组')
  .option('--sort <key>', '排序：start(出发)/arrive(到达)/duration(历时)', 'start')
  .option('--earliest <hh:mm>', '出发时间下限')
  .option('--latest <hh:mm>', '出发时间上限')
  .option('-n, --limit <num>', '最多显示条数', '50')
  .action(async (from: string, to: string, date: string | undefined, opts: {
    json?: boolean; structured?: boolean; type?: string; fx?: boolean; zn?: boolean;
    sort: string; earliest?: string; latest?: string; limit: string;
  }) => {
    const d = assertDate(date ?? todayShanghai());
    const preferences = await loadPreferences();
    opts.earliest ??= preferences.earliest;
    opts.latest ??= preferences.latest;
    const limit = queryOptions(opts);
    const [f, t] = await Promise.all([resolveTelecode(from), resolveTelecode(to)]);
    const res = await queryLeftTickets(d, f.telecode, t.telecode);
    let tickets = parseTickets(res.data?.result ?? [], res.data?.map ?? {});
    if (opts.type) {
      const p = opts.type.toUpperCase();
      tickets = tickets.filter((x) => x.code.startsWith(p));
    }
    if (opts.fx) tickets = tickets.filter((x) => x.dwFlag.includes('复兴号'));
    if (opts.zn) tickets = tickets.filter((x) => x.dwFlag.includes('智能动车组'));
    if (opts.earliest) tickets = tickets.filter((x) => x.startTime.padStart(5, '0') >= opts.earliest!.padStart(5, '0'));
    if (opts.latest) tickets = tickets.filter((x) => x.startTime.padStart(5, '0') <= opts.latest!.padStart(5, '0'));
    const sorters: Record<string, (a: typeof tickets[0], b: typeof tickets[0]) => number> = {
      start: (a, b) => a.startTime.localeCompare(b.startTime),
      arrive: (a, b) => a.arriveTime.localeCompare(b.arriveTime),
      duration: (a, b) => durationMin(a.duration) - durationMin(b.duration),
    };
    tickets.sort(sorters[opts.sort] ?? sorters.start);
    tickets = tickets.slice(0, limit);
    if (emitResult(opts, 'query', tickets)) return;
    if (tickets.length === 0) {
      console.log(`${d} ${f.name} → ${t.name} 无匹配车次`);
      return;
    }
    console.log(`${d}  ${f.name} → ${t.name}  共 ${tickets.length} 趟\n`);
    console.log(
      table(
        ['车次', '发站', '到站', '出发', '到达', '历时', '余票'],
        tickets.map((x) => [
          x.code,
          x.fromStation,
          x.toStation,
          x.startTime,
          x.arriveTime,
          x.duration,
          Object.entries(x.seats)
            .map(([k, v]) => `${k}:${v}`)
            .join(' ') || '—',
        ])
      )
    );
  });

program
  .command('route <trainCode> [date]')
  .description('查询某车次的全程经停站与时刻（如 cr12306 route G8502）')
  .option('--json', '输出 JSON')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (code: string, date: string | undefined, opts: { json?: boolean; structured?: boolean }) => {
    const d = assertDate(date ?? todayShanghai());
    const trainNo = await searchTrainNo(code, d);
    const stops = await queryTrainRoute(trainNo, d);
    if (emitResult(opts, 'route', stops)) return;
    console.log(`${code.toUpperCase()}  ${d}  经停 ${stops.length} 站\n`);
    console.log(
      table(
        ['序号', '车站', '到达', '出发', '停靠'],
        stops.map((s, i) => [
          String(i + 1),
          s.station_name ?? '?',
          s.arrive_time ?? '--',
          s.start_time ?? '--',
          s.stopover_time ?? '--',
        ])
      )
    );
  });

program
  .command('transfer <from> <to> [date]')
  .description('中转联程方案查询（date 缺省为今天，yyyy-MM-dd）')
  .option('--middle <station>', '指定中转站')
  .option('--smart', '自建拼接搜索：同站当日换乘且两段有票；首段须当日到达（需配合 --middle）')
  .option('--wait-min <min>', 'smart 模式换乘等待下限（分钟）', '15')
  .option('--wait-max <min>', 'smart 模式换乘等待上限（分钟）', '90')
  .option('--seat <name>', 'smart 模式两段均须有该席别现票，如 二等座')
  .option('--max-duration <min>', 'smart 模式全程耗时上限（分钟，含等待，1~10080）')
  .option('-n, --limit <num>', '最多显示方案数', '10')
  .option('--all', '官方榜单翻页拉全（result_index 步进10，最多30页/300套方案）')
  .option('--json', '输出 JSON')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (from: string, to: string, date: string | undefined, opts: { middle?: string; smart?: boolean; all?: boolean; waitMin: string; waitMax: string; limit: string; seat?: string; maxDuration?: string; json?: boolean; structured?: boolean }, command: Command) => {
    const d = assertDate(date ?? todayShanghai());
    if (opts.smart) {
      const preferences = await loadPreferences();
      opts.seat ??= preferences.seat;
      if (command.getOptionValueSource('waitMin') !== 'cli') opts.waitMin = String(preferences.minWait ?? opts.waitMin);
      if (command.getOptionValueSource('waitMax') !== 'cli') opts.waitMax = String(preferences.maxWait ?? opts.waitMax);
    }
    const filters = transferOptions(opts);
    const [f, t] = await Promise.all([resolveTelecode(from), resolveTelecode(to)]);
    const m = opts.middle ? await resolveTelecode(opts.middle) : null;
    if (opts.smart) {
      if (!m) throw new CliError('INVALID_ARGUMENT', '--smart 需配合 --middle 指定中转站');
      const [r1, r2] = await Promise.all([
        queryLeftTickets(d, f.telecode, m.telecode),
        queryLeftTickets(d, m.telecode, t.telecode),
      ]);
      let leg1 = parseTickets(r1.data?.result ?? [], r1.data?.map ?? {});
      let leg2 = parseTickets(r2.data?.result ?? [], r2.data?.map ?? {});
      // 强制同站换乘：剔除 12306 同城车站合并导致的"广州北到、广州南发"式假方案
      leg1 = leg1.filter((x) => x.toTele === m.telecode);
      leg2 = leg2.filter((x) => x.fromStation === m.name || x.fromTele === m.telecode);
      if (d === todayShanghai()) {
        const now = new Date(Date.now() + 8 * 3600_000).toISOString().slice(11, 16);
        leg1 = leg1.filter((x) => x.startTime.padStart(5, '0') >= now);
      }
      const joined = joinTransfers(leg1, leg2, filters.minWait, filters.maxWait, filters);
      // 同车对去重（同一趟车可能同时匹配到同城多个到站，如明珠/珠海），优先保留到目标站的行
      const seen = new Map<string, (typeof joined)[0]>();
      for (const p of joined) {
        const k = `${p.leg1.code}#${p.leg2.code}`;
        const prev = seen.get(k);
        if (!prev || (p.leg2.toTele === t.telecode && prev.leg2.toTele !== t.telecode)) seen.set(k, p);
      }
      const plans = [...seen.values()].sort((a, b) => a.totalMin - b.totalMin).slice(0, filters.limit);
      if (emitResult(opts, 'transfer', plans)) return;
      if (plans.length === 0) {
        console.log(`${d} ${f.name} → ${m.name} → ${t.name}  暂无"两段都有票"的中转组合（可调大 --wait-max 再试）`);
        return;
      }
      const seatBrief = (x: typeof leg1[0]) => Object.entries(x.seats).slice(0, 3).map(([k, v]) => `${k}:${v}`).join(' ');
      const fmtDur = (min: number) => `${Math.floor(min / 60)}小时${String(min % 60).padStart(2, '0')}分`;
      console.log(`${d}  ${f.name} → ${m.name} → ${t.name}  自建中转 ${plans.length} 套（两段均有票，换乘${opts.waitMin}~${opts.waitMax}分钟）
`);
      for (const [i, p] of plans.entries()) {
        console.log(`方案${i + 1}  全程${fmtDur(p.totalMin)}  ${p.leg1.startTime}发 ${p.leg2.arriveTime}到  ${m.name}换乘 等待${p.waitMin}分钟`);
        console.log(`  ① ${p.leg1.code} ${p.leg1.fromStation}→${p.leg1.toStation} ${p.leg1.startTime}-${p.leg1.arriveTime}（${p.leg1.duration}）余 ${seatBrief(p.leg1)}`);
        console.log(`  ② ${p.leg2.code} ${p.leg2.fromStation}→${p.leg2.toStation} ${p.leg2.startTime}-${p.leg2.arriveTime}（${p.leg2.duration}）余 ${seatBrief(p.leg2)}
`);
      }
      return;
    }
    const all = await queryInterline(d, f.telecode, t.telecode, m?.telecode ?? '', opts.all ? 30 : 1);
    const plans = all.slice(0, filters.limit);
    if (emitResult(opts, 'transfer', plans)) return;
    if (plans.length === 0) {
      console.log(`${d} ${f.name} → ${t.name} 暂无中转方案`);
      return;
    }
    console.log(`${d}  ${f.name} → ${t.name}  中转方案 ${plans.length}/${all.length} 个（按全程历时排序${opts.all ? '，已翻页拉全' : '，--all 可翻页拉全'}）
`);
    for (const [i, p] of plans.entries()) {
      const [leg1, leg2] = p.legs;
      const legText = (l: typeof leg1) =>
        l ? `${l.code} ${l.fromStation}→${l.toStation} ${l.startTime}-${l.arriveTime}（${l.duration}）` : '(段信息缺失)';
      // 等待时长接口不可靠，直接用两段到发时间差计算
      const toMin = (s: string) => { const [h, m] = (s ?? '0:0').split(':').map(Number); return (h || 0) * 60 + (m || 0); };
      const waitMin = leg1 && leg2 ? (toMin(leg2.startTime) - toMin(leg1.arriveTime) + 1440) % 1440 : 0;
      console.log(
        `方案${i + 1}  全程${p.allLishi}  ${p.startTime}发 ${p.arriveTime}到  ` +
        `${p.sameStation ? '同站换乘' : '换乘'}${p.middleStation}${waitMin > 0 ? ` 等待${waitMin}分钟` : ''}`
      );
      console.log(`  ① ${legText(leg1)}`);
      console.log(`  ② ${legText(leg2)}
`);
    }
  });

program
  .command('delay <train> <station>')
  .description('官方正晚点查询（12306 zwdch 接口，仅覆盖当前前后约3小时内的列车）')
  .option('--arrive', '查到达正晚点（默认查出发正晚点）')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (train: string, station: string, opts: { arrive?: boolean; structured?: boolean }) => {
    const s = await resolveTelecode(station); // 校验车站并取规范中文名
    const msg = await queryDelay(s.name, train, opts.arrive ? 0 : 1);
    if (emitResult(opts, 'delay', { message: msg })) return;
    console.log(msg);
  });

program
  .command('sale-time <station>')
  .description('车站车票起售时间（官方全量总表接口，含同城车站）')
  .option('--json', '输出 JSON')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (station: string, opts: { json?: boolean; structured?: boolean }) => {
    const s = await resolveTelecode(station);
    const [all, sameCity] = await Promise.all([
      queryAllSaleTimes(),
      querySameCityStations(s.telecode),
    ]);
    // 优先展示同城车站组；接口为空时退化为本站
    const names = sameCity.length > 0 ? sameCity : [s.name];
    let rows = all.filter((r) => names.includes(r.stationName));
    if (rows.length === 0) {
      const one = all.find((r) => r.stationName === s.name);
      if (one) rows = [one];
    }
    if (emitResult(opts, 'sale-time', rows)) return;
    if (rows.length === 0) {
      console.log(`未查到「${s.name}」的起售时间`);
      return;
    }
    // 预售期15天（含当天），最远可买 today+14
    const maxDate = new Date(Date.now() + 14 * 864e5);
    const maxDateStr = `${maxDate.getMonth() + 1}月${maxDate.getDate()}日`;
    console.log(`起售时间（当前预售期15天，今日最远可买 ${maxDateStr} 车票）
`);
    for (const r of rows.sort((a, b) => a.stationName.localeCompare(b.stationName, 'zh'))) {
      const t = r.saleTime ? `${r.saleTime.slice(0, 2)}:${r.saleTime.slice(2)}` : '暂无';
      console.log(`  ${r.stationName.padEnd(6)} ${t} 起售`);
    }
  });

program
  .command('status <train> [date]')
  .description('列车开行/停运状态查询（查不到记录时状态未知，请以官方信息为准）')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (train: string, date: string | undefined, opts: { structured?: boolean }) => {
    const d = assertDate(date ?? todayShanghai());
    const trainNo = await searchTrainNo(train, d);
    const msg = await queryTrainStatus(trainNo, d);
    const known = Boolean(msg.trim()) && !/未查询到|无数据/.test(msg);
    if (emitResult(opts, 'status', { state: known ? 'reported' : 'unknown', message: msg })) return;
    if (!known) {
      console.log(`${train.toUpperCase()} ${d}：状态未知，接口未返回可确认的开行信息；请以 12306 或车站公告为准`);
    } else {
      console.log(`${train.toUpperCase()} ${d}：${msg}`);
    }
  });

program
  .command('gate <train> <station> [date]')
  .description('检票口查询（官方 queryTicketCheck，通常临近开车才公布）')
  .option('--structured', '输出统一 JSON 响应（含成功状态、时间和来源）')
  .action(async (train: string, station: string, date: string | undefined, opts: { structured?: boolean }) => {
    const d = assertDate(date ?? todayShanghai());
    const s = await resolveTelecode(station);
    const platform = await queryTicketCheckGate(train.toUpperCase(), s.telecode, d);
    if (emitResult(opts, 'gate', { platform: platform || null })) return;
    console.log(
      platform
        ? `${train.toUpperCase()} ${d} ${s.name}站 检票口：${platform}`
        : `${train.toUpperCase()} ${d} ${s.name}站 暂无检票口信息（一般开车前1小时内公布）`
    );
  });

registerPlanningCommands(program, todayShanghai);

export { program };

// 入口守卫：仅直接运行（node dist/cli.js / npm link 的 cr12306）时才解析参数；
// 被 scripts/check-help.mjs 等工具 import 时只导出 program，不执行。
const invokedAsScript =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedAsScript) {
  const args = process.argv.slice(2);
  const options = args.slice(0, args.indexOf('--') < 0 ? args.length : args.indexOf('--'));
  const structured = options.includes('--structured') || args[0] === 'watch';
  if (structured) {
    const configure = (command: Command) => {
      command.configureOutput({ writeErr: () => {} }).exitOverride();
      command.commands.forEach(configure);
    };
    configure(program);
  }
  program.parseAsync(process.argv).catch((e: unknown) => {
    if (e instanceof CommanderError && e.exitCode === 0) return;
    if (structured) {
      const command = program.commands.find((c) => c.name() === args[0])?.name() ?? 'unknown';
      emitFailure(command, e);
    } else console.error(e instanceof Error ? `错误：${e.message}` : e);
    process.exitCode = 1;
  });
}
