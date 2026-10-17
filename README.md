# cr12306-cli

12306 查询命令行工具（TypeScript / Node.js）。使用 12306 网站的只读接口，参考 [Joooook/12306-mcp](https://github.com/Joooook/12306-mcp) 的接口用法。

这些接口并非官方对第三方开放的 API，可能变更、限流或失效。本项目仅查询公开信息，不提供登录、购票或下单功能。结果仅供参考，请以 12306 与车站公告为准，并避免高频请求。

## 安装

需要 Node.js 20 或更高版本及 npm。以下是从源码安装的方式；仓库访问需要相应权限。

```bash
git clone https://github.com/scieszk/cr12306-cli.git
cd cr12306-cli
npm ci
npm run build
npm link        # 可选：注册 cr12306 到 PATH
```

不执行 `npm link` 也可以直接运行 `node dist/cli.js --help` 或 `npm start -- --help`。
修改源码后运行 `npm run dev -- --help` 会先构建，再启动 CLI，兼容 Node.js 20。
不需要 API key、登录 cookie 或其他凭据；程序只在进程内缓存查询所需的会话 cookie。

## 用法

日期使用 `yyyy-MM-dd`，省略时按上海时区取今天。以下示例均省略日期，避免复制过期日期。

```bash
# 搜索车站电报码（中文/拼音/电报码）
cr12306 stations 北京

# 查区间余票
cr12306 query 北京南 上海虹桥
cr12306 query 北京南 上海虹桥 --type G        # 车次前缀过滤
cr12306 query 北京南 上海虹桥 --fx            # 复兴号标记
cr12306 query 北京南 上海虹桥 --zn            # 智能动车组标记
cr12306 query 北京南 上海虹桥 --sort duration # 按历时排序
cr12306 query 北京南 上海虹桥 --json

# 查某车次的全程经停站与时刻
cr12306 route G1

# 网站中转方案：默认请求一页，不过滤余票
cr12306 transfer 北京南 上海虹桥
cr12306 transfer 北京南 上海虹桥 --all -n 30

# 自建中转：同站当日换乘，首段当日到达，两段均有可购余票
cr12306 transfer 北京南 上海虹桥 --middle 南京南 --smart
cr12306 transfer 北京南 上海虹桥 --middle 南京南 --smart --wait-max 120 -n 20
cr12306 transfer 北京南 上海虹桥 --middle 南京南 --smart --seat 二等座 --max-duration 480 --structured

# 当前正晚点查询（接口覆盖范围有限，可能无数据）
cr12306 delay G1 北京南              # 出发正晚点
cr12306 delay G1 上海虹桥 --arrive    # 到达正晚点

# 车站起售时间
cr12306 sale-time 北京南

# 列车开行/停运信息；未查询到记录时显示“状态未知”
cr12306 status G1

# 检票口查询；临近开车仍可能无数据
cr12306 gate G1 北京南

# 直达往返，目的地至少停留6小时；也可 --return-date 指定返程日
cr12306 roundtrip 北京南 上海虹桥 --min-stay 360 --seat 二等座 --structured
cr12306 roundtrip 北京南 上海虹桥 --min-stay 360 --card

# 私有偏好，显式命令行参数优先
cr12306 preferences set seat 二等座
cr12306 preferences show
cr12306 preferences reset

# 显式保存所选方案（需要有匹配方案），再手动检查变化
cr12306 roundtrip 北京南 上海虹桥 --save-watch .private/example.watch.json --structured
cr12306 watch check .private/example.watch.json

cr12306 --help
cr12306 transfer --help
```

## 输出与限制

- `stations`、`query`、`route`、`transfer`、`sale-time` 和 `roundtrip` 支持 `--json`，成功查询但没有结果时输出 `[]`。原有 `--json` 数组格式保持不变；该模式的错误写入标准错误并返回非零退出码。
- 所有查询命令及 `preferences` 的子命令支持 `--structured`；`watch check` 默认就是结构化模式。该模式的 stdout 恰好一个单行 JSON 对象，成功退出码为 0，失败为 1，stderr 不重复输出错误。`--structured` 优先于 `--json`。`--help`、`--version` 仍是人类可读输出。
- 成功返回空数组与 API 故障明确区分。响应格式异常、HTTP 错误、拒绝查询不会被当作“无车次”。起售时间依赖的同城车站接口异常也会报告失败，不静默掩盖。
- 查询车站时优先匹配电报码或完整站名。中文前缀只有唯一匹配时才会自动解析；多个候选会报错并提示站名。
- `route` 和 `status` 只接受精确匹配的车次搜索结果，不会把 `G1` 自动替换为 `G10`。
- `--smart` 只接受接口允许购票、且至少一种席别为“有”或正整数的组合。“候补”“0”和“无”都不算现票。指定 `--seat` 时两段都须有该席别现票；`--max-duration` 包含两段乘车与等待时间。余票可能在查询后变化，不保证购票成功。
- `--smart` 的两段均查询同一乘车日，因此跳过首段跨日到达和隔夜换乘；第二段可以跨日到达。总耗时由两段历时加等待时间计算。`startDate` 是接口返回的列车始发日期，不能直接视为乘车日期。
- 普通 `transfer` 默认最多显示 10 个方案。`--all` 最多请求 30 页，仍受接口结果和 `--limit` 限制，不保证覆盖全部可行线路。
- 每次 HTTP 请求最多等待 15 秒，包括响应体读取。余票接口先从官方 init 页面读取字符串路径，并接受最多一次服务端相对路径提示，再回退到已知路径。每次余票查询最多尝试 5 个不重复路径，首次还需要会话初始化，整个命令可能超过 15 秒。
- 缺少开行公告不代表正常开行。正晚点、检票口、起售时间及车种标记也都可能缺失或过期；起售时间文本中的 15 天预售期是程序内固定估算。

### 机器人响应协议

成功示例（合成空结果，不是实时查询）：

```json
{"schema_version":"1.0","ok":true,"command":"query","queried_at":"2030-01-01T00:00:00.000Z","sources":[{"name":"12306","url":"https://www.12306.cn/"}],"data":[]}
```

失败示例：

```json
{"schema_version":"1.0","ok":false,"command":"query","queried_at":"2030-01-01T00:00:00.000Z","sources":[{"name":"12306","url":"https://www.12306.cn/"}],"error":{"code":"INVALID_ARGUMENT","message":"参数无效，请查看该命令的 --help。"}}
```

`queried_at` 是命令生成响应的 UTC 时间，不是上游数据更新时间；`sources` 表示数据来源，不代表官方授权。错误消息使用固定文本，不包含用户查询、cookie、请求 URL 参数或上游原始响应体。机器人应依据 `ok` 与 `error.code` 处理失败，不解析中文提示。

| 命令 | `data` |
|---|---|
| stations / query / route / transfer / sale-time | 与各命令原有 JSON 相同的数组 |
| delay | `{ "message": "上游说明文本" }`；空字符串表示没有说明 |
| status | `{ "state": "unknown或reported", "message": "上游说明文本" }`；reported 不等于正常开行 |
| gate | `{ "platform": "检票口或null" }` |
| roundtrip | 往返方案数组；保存监测时为 `{ "plans": [...], "watch_file": "私有文件路径" }` |
| preferences show / set / reset | 当前偏好对象 |
| watch check | `{ "state": "changed或unchanged", "notify": false, "changes": [] }` |

错误码包括 `INVALID_ARGUMENT`、`STATION_NOT_FOUND`、`AMBIGUOUS_STATION`、`TRAIN_NOT_FOUND`、`UPSTREAM_INVALID_RESPONSE`、`UPSTREAM_REJECTED`、`UPSTREAM_HTTP_ERROR`、`REQUEST_TIMEOUT`、`REQUEST_FAILED`、`PREFERENCES_INVALID`、`PRIVATE_FILE_ERROR`、`WATCH_INVALID`、`WATCH_UNAVAILABLE`。

### 参数边界

所有以下参数在任何网络请求前校验。数字只能使用十进制整数，拒绝小数、负号、指数、NaN；时刻必须是两位 `HH:MM`，从 `00:00` 到 `23:59`，下限不能晚于上限。

| 参数 | 范围 |
|---|---|
| query --limit | 1~1000 |
| transfer --limit | 1~300 |
| --wait-min / --wait-max | 0~1440 分钟，下限不大于上限 |
| transfer --max-duration | 1~10080 分钟，仅 smart 模式 |
| roundtrip --limit / --select | 1~100；select 从 1 开始，指向最终显示的方案 |
| roundtrip --min-stay | 0~10080 分钟，默认 60 |

`--seat` 接受：商务座、特等座、一等座、二等座、高级软卧、软卧、动卧、硬卧、软座、硬座、无座。`transfer --seat` 仅用于 smart 模式。

### 往返与行程卡

`roundtrip` 只组合两个方向的直达车，并严格匹配指定车站，不自动替换为同城其他站。日期是各程的乘车日期；返程默认同日，也可用 `--return-date yyyy-MM-dd` 指定后续日期。双方都须有可购余票，且返程发车时间须在去程实际到达之后，并满足 `--min-stay`。跨午夜到达按历时计算；接口的列车始发日期不会被误当成乘车日期。已经发车的去程会被跳过。

可分别使用 `--outbound-earliest`、`--outbound-latest`、`--return-earliest`、`--return-latest` 约束各程发车时间。方案按两程乘车总时长升序、目的地停留时间降序排序，再按去程时间排序与截断。不会搜索中转往返、跨站接驳、住宿或景点。

`--card` 输出 `--select` 选中的方案（默认第 1 套）为 Markdown，包括实际日期、目的地停留时间、席别筛选、查询时间与来源。它不能与 `--json` 或 `--structured` 同用；没有可选方案会报错。与 `--save-watch` 同用时，私有保存路径写到 stderr，不放入可分享的卡片正文。卡片不是车票，导出或分享前应自行检查行程信息。

### 私有偏好

偏好默认保存在 `~/.config/cr12306/preferences.json`，可用 `CR12306_PREFERENCES` 指定其他路径。文件只接受 `seat`、`minWait`、`maxWait`、`earliest`、`latest`，不保存路线、身份或凭据。

```bash
cr12306 preferences set seat 二等座
cr12306 preferences set maxWait 120
cr12306 preferences set minWait 30
cr12306 preferences set earliest 08:00
cr12306 preferences set latest 22:00
cr12306 preferences show --structured
```

`earliest/latest` 用于 query，以及 roundtrip 两个方向的默认发车窗口；`seat` 用于 smart transfer 与 roundtrip；`minWait/maxWait` 用于 smart transfer。显式命令行参数始终覆盖相应偏好。设置会校验合并后的上下限，失败不改动原文件。`preferences reset` 清空所有偏好，也可修复格式错误的文件。

私有文件使用临时文件加重命名写入，并请求 `0600` 文件权限、新建目录请求 `0700`。Unix 系统按权限位限制访问；Windows 仍受目录继承的 ACL 控制，应放在个人用户目录。偏好与监测文件不要提交或包含在分享卡片里。

### 手动监测

`roundtrip --save-watch [file]` 保存 `--select` 所选方案。省略路径时保存到用户配置目录下 `watches/`，结构化结果中的 `watch_file` 返回实际路径。显式路径必须使用 `.watch.json` 后缀；位于 Git 仓库内时必须放在 `.private/`。没有满足条件的方案不会保存文件。

`watch check <file>` 只检查一次，始终输出结构化数据，不创建定时任务，不发送消息。它严格寻找相同车次、内部车次号和起终点，比较指定席别（未指定则任意席别）的可购状态以及出发时间、到达时间、历时。正整数余票之间或正整数与“有”之间的变化不触发通知；可购状态不是列车开行状态。

原始方案基线不变。相邻的 `.state.watch.json` 文件只保存基线摘要、最近变化摘要及可用性，用于去重：第一次有意义的变化 `notify:true`，重复相同变化 `notify:false`；首次无变化为 `false`。当接口失败、所选车次缺失或已发车时，返回非零退出码及 `WATCH_UNAVAILABLE`，错误对象也有 `notify`，同一不可用状态不会反复通知。恢复可查询时允许 `notify:true` 并给出可用性恢复变化。调用方可依据 `notify` 决定是否提醒，但本工具不会代为通知。

重新运行往返查询并显式 `--save-watch` 到同一路径可替换已确认的基线，同时重置去重状态，也能修复损坏的状态文件。检查不要并行运行在同一个基线文件上；去重状态是本地文件，不是多进程协调服务。

## 开发与验证

```bash
npm ci
npm test
```

`npm test` 先编译 TypeScript、检查 11 个顶层命令的帮助与 README 示例，再运行 Node.js 自带测试框架。测试使用合成车站、车次、模拟 HTTP 响应和临时私有文件，不访问 12306，也不需要个人数据。这些离线测试不证明实时接口当前可用。

首次克隆后启用提交检查：

```sh
git config core.hooksPath .githooks
python scripts/check_private.py --all
python -m unittest discover -s tests -p 'test_privacy_guard.py' -v
```

钩子需要 Python 3。提交检查读取暂存区，推送检查读取可达提交历史；CI 也会运行。密钥、聊天记录、个人行程和运行时输出不应进入仓库。检查只覆盖常见泄漏模式，提交前仍需检查 `git diff --cached`。

## 实现要点

| 功能 | 接口 |
|---|---|
| 车站电报码 | `kyfw.12306.cn/otn/resources/js/framework/station_name.js` |
| 余票 | 官方 init 中的 `CLeftTicketUrl` 或服务端 `c_url`，带 queryG/queryA/query 回退 |
| 车次 → train_no | `search.12306.cn/search/v1/train/search` |
| 经停站时刻 | `kyfw.12306.cn/otn/queryTrainInfo/query` |
| 中转联程 | `kyfw.12306.cn/lcquery/queryG` |
| 正晚点 | `kyfw.12306.cn/otn/zwdch/query`（表单 POST，`cxlx` 0=到达/1=出发） |
| 起售时间 | `kyfw.12306.cn/otn/index12306/queryAllCacheSaleTime` |
| 开行/停运状态 | `kyfw.12306.cn/otn/index12306/queryTrainStatus`（表单 POST） |
| 检票口 | `kyfw.12306.cn/otn/index12306/queryTicketCheck`（表单 POST，临近开车才有数据） |

备注：

- 余票接口的 `dw_flag` 字段（`f[46]`）已从中文文本改为 `#` 分隔编码，解码规则按官方页面 JS（`queryLeftTicket_end_js.js`）：`[0]=='5'`→智能动车组、`[1]=='1'`→复兴号、`[2]` 以 Q/R 开头→静音车厢/温馨动卧、`[5]=='D'`→动感号。
- 会话 cookie 通过先请求 `otn/leftTicket/init` 获得，不保存到磁盘。
- 动态路径仅接受 `leftTicket/query` 后跟 0~8 个 ASCII 字母，固定拼接到 `https://kyfw.12306.cn/otn/`。不执行上游 JavaScript，不接受完整 URL、路径穿越、查询参数或片段；HTTP 重定向会失败而不是访问新地址。
- 不包含车站大屏、列车实时位置或候补成功率功能。

动态接口发现与定序字段方案参考 [12306-mcp 的固定版本源码](https://github.com/Joooook/12306-mcp/blob/ff6439da6f63d7d72181abea4568abd69878c600/src/index.ts)，于 2026-10-18 核对其 `getTicketQueryPath` 从 init 页面读取 `CLeftTicketUrl` 的做法；本项目增加路径白名单、请求上限及响应校验。上游采用 [MIT License，Copyright (c) 2025 Jok](https://github.com/Joooook/12306-mcp/blob/ff6439da6f63d7d72181abea4568abd69878c600/LICENSE)。

## License

MIT
