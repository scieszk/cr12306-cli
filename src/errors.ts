/** Stable public error categories. Never expose caught messages in structured output. */
export const ERROR_MESSAGES = {
  INVALID_ARGUMENT: '参数无效，请查看该命令的 --help。',
  STATION_NOT_FOUND: '无法识别车站，请使用完整站名或电报码。',
  AMBIGUOUS_STATION: '车站名称不明确，请使用完整站名或电报码。',
  TRAIN_NOT_FOUND: '未查询到精确匹配的车次。',
  UPSTREAM_INVALID_RESPONSE: '12306 返回的数据格式异常，请稍后重试。',
  UPSTREAM_REJECTED: '12306 未接受查询，请稍后重试。',
  UPSTREAM_HTTP_ERROR: '12306 HTTP 请求失败，请稍后重试。',
  REQUEST_TIMEOUT: '12306 请求超时，请稍后重试。',
  REQUEST_FAILED: '查询失败，请检查网络并稍后重试。',
  PREFERENCES_INVALID: '偏好文件格式无效，请修复文件或运行 preferences reset。',
  PRIVATE_FILE_ERROR: '无法读写私有文件，请检查路径与权限。',
  WATCH_INVALID: '监测基线或检查状态无效，请重新保存所选方案。',
  WATCH_UNAVAILABLE: '当前无法确认所选车次的信息；这不代表停运或无票。',
} as const;

export class CliError extends Error {
  constructor(public readonly code: keyof typeof ERROR_MESSAGES, message: string = ERROR_MESSAGES[code], public readonly notify?: boolean) {
    super(message);
  }
}

export function publicError(error: unknown) {
  const code = error instanceof CliError ? error.code
    : error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name) ? 'REQUEST_TIMEOUT'
    : error instanceof Error && 'code' in error && String(error.code).startsWith('commander.') ? 'INVALID_ARGUMENT'
    : 'REQUEST_FAILED';
  return { code, message: ERROR_MESSAGES[code], ...(error instanceof CliError && error.notify !== undefined ? { notify: error.notify } : {}) };
}
