#!/usr/bin/env node
/**
 * help 完整性强制检查（已接入 npm run build，构建即执行）：
 *   1. 每个命令必须有 .description()
 *   2. 每个选项必须有描述文本
 *   3. README.md 必须收录 `cr12306 <命令名>` 用法示例
 * 任一不满足 → 退出码 1，构建失败。
 * 新增命令时若忘记写帮助，这里会直接卡住。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const { program } = await import(new URL('../dist/cli.js', import.meta.url));

const readme = readFileSync(join(root, 'README.md'), 'utf8');
let fail = 0;
const bad = (msg) => {
  console.error(`❌ ${msg}`);
  fail = 1;
};

const commands = program.commands.filter((c) => c.name() !== 'help');

for (const cmd of commands) {
  if (!cmd.description()) bad(`命令 "${cmd.name()}" 缺少 .description()`);
  for (const opt of cmd.options) {
    if (!opt.description) bad(`命令 "${cmd.name()}" 的选项 ${opt.flags} 缺少描述`);
  }
  if (!new RegExp(`cr12306 ${cmd.name()}\\b`).test(readme)) {
    bad(`README.md 未收录用法示例：cr12306 ${cmd.name()}`);
  }
}

if (fail) {
  console.error('\nhelp 完整性检查未通过，请补齐上述缺失后重新构建。');
} else {
  console.log(`✅ help 检查通过：${commands.length} 个命令的描述与 README 示例齐全`);
}
process.exit(fail);
