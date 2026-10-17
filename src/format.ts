/** 终端表格输出，处理 CJK 全角字符宽度 */

export function wcwidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    // 粗略但够用：CJK 区间按 2 计
    w += /[⺀-鿿豈-﫿︰-﹏＀-｠￠-￦\u20000-\u2FA1F]/.test(ch) ? 2 : 1;
  }
  return w;
}

export function pad(s: string, width: number): string {
  const diff = width - wcwidth(s);
  return diff > 0 ? s + ' '.repeat(diff) : s;
}

export function table(headers: string[], rows: string[][]): string {
  const cols = headers.length;
  const widths = new Array(cols).fill(0);
  for (let i = 0; i < cols; i++) widths[i] = wcwidth(headers[i]);
  for (const row of rows) {
    for (let i = 0; i < cols; i++) {
      const w = wcwidth(row[i] ?? '');
      if (w > widths[i]) widths[i] = w;
    }
  }
  const line = (cells: string[]) =>
    cells.map((c, i) => pad(c ?? '', widths[i])).join('  ').trimEnd();
  const sep = widths.map((w) => '─'.repeat(w)).join('──');
  return [line(headers), sep, ...rows.map(line)].join('\n');
}
