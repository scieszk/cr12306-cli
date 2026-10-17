import { fetchStationNameJs } from './api.js';
import { CliError } from './errors.js';

export interface Station {
  abbr: string; // 中文缩写，如 bjb
  name: string; // 北京北
  telecode: string; // VAP
  pinyin: string; // beijingbei
  short: string; // bjb
  index: number;
}

let cache: Station[] | null = null;

export async function loadStations(): Promise<Station[]> {
  if (cache) return cache;
  const raw = await fetchStationNameJs();
  const body = raw.match(/\bvar\s+station_names\s*=\s*(['"])([^'"\r\n]*)\1\s*;/)?.[2];
  if (!body || !body.startsWith('@')) throw new CliError('UPSTREAM_INVALID_RESPONSE');
  const stations = body
    .split('@')
    .filter(Boolean)
    .map((seg) => {
      const [abbr, name, telecode, pinyin, short, idx] = seg.split('|');
      if (!abbr || !name || !/^[A-Z]{3}$/.test(telecode ?? '') || !pinyin || !short || !/^\d+$/.test(idx ?? '')) {
        throw new CliError('UPSTREAM_INVALID_RESPONSE');
      }
      return { abbr, name, telecode, pinyin, short, index: Number(idx) } as Station;
    });
  cache = stations;
  return cache;
}

/** 模糊搜索车站：中文名 / 拼音 / 电报码 / 缩写 */
export async function searchStations(keyword: string, limit = 15): Promise<Station[]> {
  const kw = keyword.toLowerCase();
  const all = await loadStations();
  return all
    .filter(
      (s) =>
        s.name.includes(keyword) ||
        s.pinyin.startsWith(kw) ||
        s.short.startsWith(kw) ||
        s.telecode.toLowerCase() === kw
    )
    .slice(0, limit);
}

/** 把用户输入（中文站名或电报码）解析成电报码；精确站名优先 */
export async function resolveTelecode(input: string): Promise<Station> {
  const all = await loadStations();
  const byTele = all.find((s) => s.telecode.toUpperCase() === input.toUpperCase());
  if (byTele) return byTele;
  const exact = all.find((s) => s.name === input);
  if (exact) return exact;
  const fuzzy = all.filter((s) => s.name.startsWith(input));
  if (fuzzy.length === 1) return fuzzy[0];
  if (fuzzy.length > 1) {
    throw new CliError('AMBIGUOUS_STATION', `车站名称不明确：${input}（匹配：${fuzzy.slice(0, 8).map((s) => s.name).join('、')}；请使用完整站名或电报码）`);
  }
  throw new CliError('STATION_NOT_FOUND', `无法识别车站：${input}（可用 stations 子命令搜索）`);
}
