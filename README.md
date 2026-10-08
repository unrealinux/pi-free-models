# pi-free-models

免登录、免注册、免 API Key 的免费模型通道，装进 [Pi](https://github.com/earendil-works/pi) 就能用。

移植自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（DeepSeek Harness 插件）的完整核心逻辑：上游 wire、模型目录、可用性探测、推理强度到真实 token 预算的映射。

```
zen-free   12 个    OpenCode Zen 免密通道（Bearer public + 客户端指纹）
kilo-free  16 个    Kilo AI 公开网关免费池（完全无凭证）
```

## 装

```bash
pi install https://github.com/unrealinux/pi-free-models
```

装完重启 Pi，`/model` 里就会出现 `zen-free/*` 和 `kilo-free/*`。不需要任何凭证。

开发时直接加载：

```bash
pi -e ./index.ts --model zen-free/space-bunny-free -p "你好"
```

## 用

```
/model zen-free/space-bunny-free
/model kilo-free/inclusionai/ling-3.1-flash

/free-models      # 名单、可用性判决、各档真实 token 数
```

## 免费通道的真实状态

**很挤。** 实测 12 个 zen 模型里通常只有 5–7 个答得上，其余是上游 429 / 503 / 空流。这不是实现问题，是免费池本身的状态——所以「探测 → 只把真能答的放进 picker」才是这个项目的核心，而不是装饰。

判决分五档，只有**网关点名拒绝**的模型才踢出 picker：

| 判决 | 含义 | 进 picker |
|---|---|---|
| `available` | 答得出 | ✅ |
| `region-blocked` | 区域受限，名字带 `· region-limited` | ✅ |
| `throttled` | 429，下一个窗口可能就通 | ✅ |
| `unknown` | 5xx / 超时 / 无答复 / 指纹门禁 —— 没有说模型什么 | ✅ |
| `unavailable` | 网关点名拒绝这个模型 | ❌ |

不对称是刻意的：picker 里一条过期记录只让用户损失一个可以重试的回合，而一个因为抖动消失的模型要用户走一遍他看不见的「重新探测再等待」周期。

## 移植过来的四条逻辑

1. **上游 wire**（`upstream.ts`）—— `Bearer public` 池化凭证、客户端指纹头、session/request id 铸造、按模型分流 chat / responses / messages、tool quartet 门禁。
2. **模型目录**（`catalog.ts`）—— 上游 listing 只给一个 id，能力表补上下文 / 视觉 / 推理；listing 混着付费 id，`isFreeLane` 只留免费层。
3. **可用性探测**（`probe.ts`）—— 用能产生判决的最小请求去问，而不是相信 listing。
4. **强度 → 真实预算**（`effort.ts`）—— 网关接受 `reasoning_effort` / `thinking.budget_tokens` / `enable_thinking` 然后**全部忽略**（实测 `low` 产生的思考 token 比 `xhigh` 还多），唯一被执行的只有 `max_tokens`。Pi 的六档思考等级映射到 2048 / 2048 / 8192 / 8192 / 容量 / 容量，关不掉思考的模型整条阶梯翻倍。

## tool quartet 指纹门禁

Zen 免费层要求请求里声明 `bash` / `glob` / `grep` / `read` 四个工具名。Pi 自带 `bash` / `grep` / `read`，缺的 `glob` 由真实工具 `find` 顶替——门禁只看声明的名字，而响应侧会把名字还原回 `find`，让调用回来是可执行的而不是一个死诱饵。只有实在没有供体的会话才补一个自述不可用的替身。

**这本质上是伪造客户端指纹。** 上游随时可能收紧（实测已经出现过 `FreeTierError: OpenCode's free tier can only be used from within OpenCode`），收紧后这条通道就会失效。

## 移植时修掉的上游缺陷

1. **探测没带 quartet** → 12 个模型里 11 个被 `FreeTierError` 误报。带上后可用数从 1 涨到 7。
2. **`400` 带 `"type":"server_error"`** → 网关在说它自己那段挂了（`Upstream request failed: Endpoint is unavailable`），不是点名模型，却会被判死。
3. **`200` 但整条流零 delta** → 「头说 200、体里只有 `{"choices":[],"cost":"0"}`」那种谎，不该给绿徽章，降为 `unknown`（仍可路由）。

## 与上游插件的差异

| | dsh-our-free-model | 这里 |
|---|---|---|
| 公告推送 / token 热力图 / 自升级 / EAC 协付 / vault / forward 端口 | 有（4000+ 行设置页） | 无，用 `/free-models` 一行命令替代 |
| picker 分组 | 两组 | Pi 没有分组概念，靠名字后缀 `· region-limited` |
| `glob` 槽位供体 | `pwsh` → `bash` | `find` → `glob` |
| 强度档位 | Light / Balanced / Deep | Pi 的六档思考等级，同一套 token 预算 |

## 自检

```bash
npm run selftest
```

会真的打上游：验证 id 铸造、endpoint 分流、指纹门禁、预算阶梯，抓一次 listing、逐个探测、最后写快照。需要 Node >= 22.6（`--experimental-strip-types`）。

## 免责声明

- 这两条通道都不是你与模型厂商之间的合同关系，随时可能失效或改变。
- **Kilo 免费池的 prompt 可能被上游记录并用于改进其服务**（网关自己的模型卡如此声明）。别发敏感内容。
- 你的请求直接发给 `opencode.ai` 和 `api.kilo.ai`，没有第三方中转，但请自行判断是否信任这两家。
- 仅供个人学习与技术研究。请遵守各上游的服务条款。

## 许可

MIT。原始实现 © 2026 [Ebony-Vinyl](https://github.com/Ebony-Vinyl/dsh-our-free-model)，Pi 移植版见 LICENSE。
