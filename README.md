# pi-free-models

免登录、免注册、免 API Key 的免费模型通道，装进 [Pi](https://github.com/earendil-works/pi) 就能用。

移植自 [dsh-our-free-model](https://github.com/Ebony-Vinyl/dsh-our-free-model)（DeepSeek Harness 插件）的完整核心逻辑，对应上游 2026-10 的 **v2 客户端指纹**：上游 wire、模型目录、可用性探测、思考档位到真实预算/菜单的映射。

```
zen-free   9 个（随 listing 变）   OpenCode 免密通道（Bearer public + v2 客户端指纹）
kilo-free  17 个（随 listing 变）  Kilo AI 公开网关免费池（完全无凭证）
```

## 装

```bash
pi install https://github.com/unrealinux/pi-free-models
```

装完重启 Pi，`/model` 里就会出现 `zen-free/*` 和 `kilo-free/*`。不需要任何凭证。

开发时直接加载：

```bash
pi -e ./index.ts --model zen-free/big-pickle -p "你好"
```

## 用

```
/model zen-free/big-pickle
/model kilo-free/nvidia/nemotron-3.5-lightning:free

/free-models      # 名单、可用性判决、各模型真实的档位/预算
```

## 免费通道的真实状态

**很挤。** 免费池会整体限流（实测 429 `FreeUsageLimitError`，retry-after 数小时），这时所有 zen 模型都答不上来；也会出现单个模型 503 / 空流 / 区域拒绝。这不是实现问题，是免费池本身的状态——所以「探测 → 只把真能答的放进 picker」才是这个项目的核心，而不是装饰。限流期间模型仍然留在 picker 里，窗口恢复后不用重新配置。

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

1. **上游 wire**（`upstream.ts`）—— `Bearer public` 池化凭证、v2 客户端指纹、规范 session 编码、按模型分流 chat / responses / messages、`read` + `shell` 门禁。
2. **模型目录**（`catalog.ts`）—— 上游 listing 只给一个 id，能力表补上下文 / 视觉 / 推理 / 思考菜单；listing 混着付费 id，`isFreeLane` 只留免费层。
3. **可用性探测**（`probe.ts`）—— 用能产生判决的最小请求去问，而不是相信 listing；每个模型一个独立 session，并发压到 2。
4. **档位 → 真实控制**（`effort.ts`）—— 两种模式：
   - 声明了 `efforts` 菜单的模型（deepseek / glm / nemotron VL / space-bunny / Kilo 的推理模型）：选中的档位作为 `reasoning_effort`（Kilo 是 `reasoning.effort`）真的发出去，网关会校验并执行，预算用模型容量。
   - 没有菜单的模型：继续走 token 阶梯。Pi 的六档映射到 2048 / 2048 / 8192 / 8192 / 容量 / 容量，关不掉思考的模型整条阶梯翻倍。

Pi 会在调用 provider 前把 `off` 折成 `undefined`，所以「关掉思考」在扩展这条路上无法表达：菜单模型落到自己声明的默认档（多为 high），没有菜单的模型落到 medium 预算。

## v2 指纹门禁

免费层要求请求里**逐字**声明官方客户端的 `read` 与 `shell`：description 和参数 schema 必须与 OpenCode v2.0.26 一致，改写措辞、精简 schema 都会换来 403 `FreeTierError`。

- 调用方的工具原样保留；名字正好是 `read` / `shell` 但定义不同的，改名为 `read_client` / `shell_client`，历史调用与 `tool_choice` 同步改名，响应侧再还原。
- 注入的官方 `shell` 在响应侧还原成 Pi 的 `bash`，让调用回来是可执行的；并在系统提示里说明注入项是占位物，别去调它。
- **绝不下发 `tool_choice: "none"`** —— v2 见到就 403；v1 的 `bash` / `glob` / `grep` / `read` 四件套与 `x-opencode-request` 头都已失效。

**这本质上是伪造客户端指纹。** 上游随时可能收紧（`/zen/v1` → `/inference/v1` 就是这么发生的），收紧后这条通道就会失效。

## 移植时修掉的上游缺陷

1. **探测没带门禁工具** → 多数模型被 `FreeTierError` 误报成不可用。
2. **`400` 带 `"type":"server_error"`** → 网关在说它自己那段挂了（`Upstream request failed: Endpoint is unavailable`），不是点名模型，却会被判死。
3. **`200` 但整条流零 delta** → 「头说 200、体里只有 `{"choices":[],"cost":"0"}`」那种谎，不该给绿徽章，降为 `unknown`（仍可路由）。
4. **所有探测共用一个 session** → 配额按 session 计，第一个模型吃掉额度、其余全部读作 429。现在每个模型一个 session。
5. **快照未校验** → 旧版本或被写坏的快照会让字段缺失的行炸进 picker。现在逐行校验，坏的丢掉。

## 与上游插件的差异

| | dsh-our-free-model | 这里 |
|---|---|---|
| 公告推送 / token 热力图 / 自升级 / EAC 协付 / vault / forward 端口 | 有（4000+ 行设置页） | 无，用 `/free-models` 一行命令替代 |
| picker 分组 | 两组 | Pi 没有分组概念，靠名字后缀 `· region-limited` |
| 门禁槽位供体 | `pwsh` → `bash`（v1） | `read` / `shell` 官方定义 + 调用方工具改名（v2） |
| 强度档位 | Light / Balanced / Deep | Pi 的六档；有菜单的模型下发真实档位，没有的走 token 阶梯 |
| 探测扇出 | 并发 2 | 并发 2，每个模型独立 session |

## 自检

```bash
npm run selftest
```

会真的打上游：验证 session 编码、endpoint 分流、v2 指纹门禁、思考菜单、预算阶梯，抓一次 listing、逐个探测、最后写快照。免费池整体限流时自检仍然通过，只记录可用数（0 可用是上游状态，不是实现问题）。需要 Node >= 22.6（`--experimental-strip-types`）。

## 免责声明

- 这两条通道都不是你与模型厂商之间的合同关系，随时可能失效或改变。
- **Kilo 免费池的 prompt 可能被上游记录并用于改进其服务**（网关自己的模型卡如此声明）。别发敏感内容。
- 你的请求直接发给 `opencode.ai` 和 `api.kilo.ai`，没有第三方中转，但请自行判断是否信任这两家。
- 仅供个人学习与技术研究。请遵守各上游的服务条款。

## 许可

MIT。原始实现 © 2026 [Ebony-Vinyl](https://github.com/Ebony-Vinyl/dsh-our-free-model)，Pi 移植版见 LICENSE。
