import { readFile, mkdir, writeFile, rename, chmod, lstat, unlink } from 'node:fs/promises';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join, resolve, relative, sep } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { CliError } from './errors.js';
import { queryOptions, transferOptions } from './cli-options.js';

export interface Preferences { seat?: string; minWait?: number; maxWait?: number; earliest?: string; latest?: string }
export const configDirectory = () => join(homedir(), '.config', 'cr12306');
export const preferencesPath = () => resolve(process.env.CR12306_PREFERENCES || join(configDirectory(), 'preferences.json'));
const keys = ['seat', 'minWait', 'maxWait', 'earliest', 'latest'];

function validatePreferences(value: unknown): asserts value is Preferences {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) throw new CliError('INVALID_ARGUMENT');
  const p = value as Preferences;
  for (const key of ['seat', 'earliest', 'latest'] as const) if (p[key] !== undefined && typeof p[key] !== 'string') throw new CliError('INVALID_ARGUMENT');
  for (const key of ['minWait', 'maxWait'] as const) if (p[key] !== undefined && typeof p[key] !== 'number') throw new CliError('INVALID_ARGUMENT');
  queryOptions({ limit: '1', sort: 'start', earliest: p.earliest, latest: p.latest });
  transferOptions({ limit: '1', waitMin: String(p.minWait ?? 15), waitMax: String(p.maxWait ?? 90), smart: true, middle: 'preference', seat: p.seat });
}

export async function readPrivateJson(path: string): Promise<unknown> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 64 * 1024) throw new CliError('PRIVATE_FILE_ERROR');
  return JSON.parse(await readFile(path, 'utf8'));
}

export async function writePrivateJson(path: string, data: unknown): Promise<void> {
  const target = resolve(path);
  const temp = `${target}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try { if (!(await lstat(target)).isFile()) throw new CliError('PRIVATE_FILE_ERROR'); }
    catch (error) { if (!(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')) throw error; }
    await writeFile(temp, JSON.stringify(data, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, target);
  } catch {
    throw new CliError('PRIVATE_FILE_ERROR');
  } finally {
    await unlink(temp).catch(() => {});
  }
}

export async function loadPreferences(): Promise<Preferences> {
  try {
    const data = await readPrivateJson(preferencesPath());
    validatePreferences(data);
    return data;
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return {};
    throw new CliError('PREFERENCES_INVALID');
  }
}

export async function setPreference(key: string, value: string): Promise<Preferences> {
  if (!keys.includes(key)) throw new CliError('INVALID_ARGUMENT');
  const previous = await loadPreferences();
  const next = { ...previous, [key]: ['minWait', 'maxWait'].includes(key) && /^\d+$/.test(value) ? Number(value) : value };
  validatePreferences(next);
  await writePrivateJson(preferencesPath(), next);
  return next;
}

export async function resetPreferences(): Promise<Preferences> {
  await writePrivateJson(preferencesPath(), {});
  return {};
}

/** Explicit paths inside a checkout must be in its ignored .private directory. */
export function watchPath(input: string | true): string {
  const path = resolve(input === true ? join(configDirectory(), 'watches', `${randomUUID()}.watch.json`) : input);
  if (!path.endsWith('.watch.json')) throw new CliError('INVALID_ARGUMENT', '监测文件必须使用 .watch.json 后缀');
  let ancestor = dirname(path);
  while (!existsSync(ancestor) && dirname(ancestor) !== ancestor) ancestor = dirname(ancestor);
  const canonical = resolve(realpathSync(ancestor), relative(ancestor, path));
  for (let directory = dirname(canonical); ; directory = dirname(directory)) {
    if (existsSync(join(directory, '.git'))) {
      if (relative(directory, canonical).split(sep)[0] !== '.private') throw new CliError('INVALID_ARGUMENT', '仓库内的监测文件必须放在 .private/ 目录');
      break;
    }
    if (dirname(directory) === directory) break;
  }
  return canonical;
}
