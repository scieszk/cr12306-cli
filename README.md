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

# 当前正晚点查询（接口覆盖范围有限，可能无数据）
cr12306 delay G1 北京南              # 出发正晚点
cr12306 delay G1 上海虹桥 --arrive    # 到达正晚点

# 车站起售时间
cr12306 sale-time 北京南

# 列车开行/停运信息；未查询到记录时显示“状态未知”
cr12306 status G1

# 检票口查询；临近开车仍可能无数据
cr12306 gate G1 北京南

cr12306 --help
cr12306 transfer --help
```

## 输出与限制

- `stations`、`query`、`route`、`transfer` 和 `sale-time` 支持 `--json`，成功查询但没有结果时输出 `[]`。错误写入标准错误并返回非零退出码，不承诺错误输出为 JSON。
- 查询车站时优先匹配电报码或完整站名。中文前缀只有唯一匹配时才会自动解析；多个候选会报错并提示站名。
- `route` 和 `status` 只接受精确匹配的车次搜索结果，不会把 `G1` 自动替换为 `G10`。
- `--smart` 只接受接口允许购票、且至少一种席别为“有”或正整数的组合。“候补”“0”和“无”都不算现票。余票可能在查询后变化，不保证购票成功。
- `--smart` 的两段均查询同一乘车日，因此跳过首段跨日到达和隔夜换乘；第二段可以跨日到达。总耗时由两段历时加等待时间计算。`startDate` 是接口返回的列车始发日期，不能直接视为乘车日期。
- 普通 `transfer` 默认最多显示 10 个方案。`--all` 最多请求 30 页，仍受接口结果和 `--limit` 限制，不保证覆盖全部可行线路。
- 每次 HTTP 请求最多等待 15 秒，包括响应体读取。余票接口有最多三种接口路径回退，首次请求还可能先获取会话，因此整个命令可能超过 15 秒。
- 缺少开行公告不代表正常开行。正晚点、检票口、起售时间及车种标记也都可能缺失或过期；起售时间文本中的 15 天预售期是程序内固定估算。

## 开发与验证

```bash
npm ci
npm test
```

`npm test` 先编译 TypeScript、检查 8 个命令的帮助与 README 示例，再运行 Node.js 自带测试框架。测试使用合成车站、车次和模拟 HTTP 响应，不访问 12306，也不需要个人数据。

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
| 余票 | `kyfw.12306.cn/otn/leftTicket/queryG`（带 queryA/query 回退） |
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
- 不包含车站大屏、列车实时位置或候补成功率功能。

## License

MIT
