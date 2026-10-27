/**
 * 自检：把抓名单 -> 建目录 -> 探测判决 -> 真实预算 这条链路脱离 Pi 进程跑一遍。
 * 断言失败就退出码非 0。
 *
 * 用法：npm run selftest（= node --experimental-strip-types selftest.mjs）
 */
import { join } from "node:path";
import { buildCatalog, buildKiloCatalog, parseListing } from "./catalog.ts";
import { budgetFor, effortPatchFor, normalizeLevel, thinkingLevelMapFor } from "./effort.ts";
import { isRoutable, probeModel, STATE } from "./probe.ts";
import {
	applyFingerprint,
	canonicalizeSession,
	endpointFor,
	FINGERPRINT_TOOL_DEFINITIONS,
	fingerprintStyle,
	isCanonicalSession,
	sessionForConversation,
	SESSION_DESCENDING_RE,
	SESSION_RE,
	wireFor,
	zenHeaders,
} from "./upstream.ts";
import { loadSnapshot, saveSnapshot } from "./snapshot.ts";

const ZEN_BASE = process.env.PI_ZEN_BASE ?? "https://opencode.ai";
const KILO_BASE = process.env.PI_KILO_BASE ?? "https://api.kilo.ai/api/gateway";
const SNAPSHOT = join(process.env.HOME, ".pi/agent/free-models-catalog.json");
let failures = 0;
function check(label, ok, extra = "") {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
	if (!ok) failures += 1;
}

// --- 纯函数：session 铸造、endpoint 分流 --------------------------------

const session = sessionForConversation("selftest-session");
check("session id 形状合法", SESSION_RE.test(session), session);
check("session 时间片是降序编码", SESSION_DESCENDING_RE.test(session.slice(4, 16)), session.slice(4, 16));
check("session 被判定为规范形状", isCanonicalSession(session));
check("同一段对话映射到同一 session", sessionForConversation("selftest-session") === session);
check("不同对话映射到不同 session", sessionForConversation("other") !== session);
check("规范 session 原样转发", sessionForConversation(session) === session);
check("canonicalizeSession 是确定性的", canonicalizeSession("x") === canonicalizeSession("x"));

check("muse-spark 走 responses", wireFor("muse-spark-1.3-contributor-free") === "responses");
check("union-alpha 走 messages", wireFor("union-alpha") === "messages");
check("其余走 chat", wireFor("glm-5.3-flash-free") === "chat");
check("(level) 后缀被剥掉", endpointFor("muse-spark-1.2-contributor-free(high)") === "/inference/v1/responses");
check("聊天端点在新路径", endpointFor("glm-5.3-flash-free") === "/inference/v1/chat/completions");
check("headers 带四个同值 session 头", (() => {
	const h = zenHeaders(session);
	return ["x-opencode-session", "x-opencode-session-id", "x-session-affinity", "x-session-id"].every((k) => h[k] === session);
})());
check("headers 不带 v1 专用头", !("x-opencode-request" in zenHeaders(session)));

// --- 指纹门禁 v2 ----------------------------------------------------------

const body = {
	model: "glm-5.3-flash-free",
	messages: [
		{ role: "system", content: "sys" },
		{ role: "user", content: "hi" },
	],
	tools: [
		{ type: "function", function: { name: "bash", description: "shell", parameters: { type: "object", properties: { command: { type: "string" } } } } },
		{ type: "function", function: { name: "read", description: "pi read", parameters: { type: "object", properties: { path: { type: "string" } } } } },
		{ type: "function", function: { name: "Edit", description: "edit", parameters: { type: "object", properties: {} } } },
		{ type: "function", function: { name: "read", description: "duplicate", parameters: { type: "object", properties: {} } } },
	],
	tool_choice: "none",
};
const map = applyFingerprint(body, fingerprintStyle("chat"));
const sent = body.tools.map((t) => t.function.name);
const officialRead = body.tools.find((t) => t.function.name === "read");
const officialShell = body.tools.find((t) => t.function.name === "shell");
check("官方 read/shell 都被声明", Boolean(officialRead && officialShell));
check("官方 read 定义逐字一致", officialRead?.function.description === FINGERPRINT_TOOL_DEFINITIONS.read.description);
check("官方 shell 定义逐字一致", JSON.stringify(officialShell?.function.parameters) === JSON.stringify(FINGERPRINT_TOOL_DEFINITIONS.shell.parameters));
check("调用方的 read 被改名而不是覆盖", sent.includes("read_client") && map.get("read_client") === "read");
check("大小写变体原样保留", sent.includes("Edit"));
check("同名重复只留一个", sent.filter((n) => n === "read").length === 1);
check("工具总数未膨胀", body.tools.length === 5, `len=${body.tools.length}`);
check("绝不下发 tool_choice=none", body.tool_choice === undefined);
check("注入的 shell 还原成 Pi 的 bash", map.get("shell") === "bash");
check("系统提示告知注入工具是占位物", /placeholders that do nothing/.test(body.messages[0].content));

// 调用方已经带着官方定义时，不注入、不改名。
const exact = {
	model: "x",
	messages: [],
	tools: ["read", "shell"].map((name) => ({
		type: "function",
		function: { name, description: FINGERPRINT_TOOL_DEFINITIONS[name].description, parameters: FINGERPRINT_TOOL_DEFINITIONS[name].parameters },
	})),
};
applyFingerprint(exact, false);
check("官方定义已存在时不重复注入", exact.tools.length === 2);

// 没有工具时补两个官方定义，且不补 tool_choice。
const sparse = { model: "x", messages: [{ role: "user", content: "hi" }] };
const sparseMap = applyFingerprint(sparse, false);
check("缺工具时补至两个", sparse.tools.length === 2);
check("补的是 read 与 shell", ["read", "shell"].every((n) => sparse.tools.some((t) => t.function.name === n)));
check("无工具时不下发 tool_choice", sparse.tool_choice === undefined);
check("没有 bash 时不加 shell 供体", !sparseMap.has("shell"));

// Responses 线：扁平工具形状，无 tool_choice 时补 auto。
const flat = { model: "x", input: [], tools: [{ type: "function", name: "read", description: "pi", parameters: {} }] };
applyFingerprint(flat, true);
check("Responses 补 auto", flat.tool_choice === "auto");
check("Responses 工具是扁平形状", flat.tools.every((t) => t.name !== undefined));

// Messages 线：Claude 形状。
const claude = { model: "x", system: "s", messages: [{ role: "user", content: "hi" }], tools: [{ name: "read", description: "pi", input_schema: { type: "object", properties: {} } }] };
applyFingerprint(claude, "claude");
check("Messages 注入 input_schema", claude.tools.some((t) => t.name === "read" && t.input_schema !== undefined));
check("Messages 系统提示追加占位说明", /placeholders that do nothing/.test(claude.system));

// 历史里的旧调用也要跟着改名。
const history = {
	model: "x",
	messages: [
		{ role: "user", content: "hi" },
		{ role: "assistant", content: null, tool_calls: [{ id: "1", type: "function", function: { name: "read", arguments: "{}" } }] },
	],
	tools: [{ type: "function", function: { name: "read", description: "pi", parameters: { type: "object", properties: { path: { type: "string" } } } } }],
};
applyFingerprint(history, false);
const assistant = history.messages.find((message) => message.role === "assistant");
check("历史工具调用同步改名", assistant?.tool_calls?.[0]?.function?.name === "read_client");

// --- 预算与思考菜单 --------------------------------------------------------

const normal = budgetFor("low", 32768, true);
const normalMid = budgetFor("medium", 32768, true);
const normalMax = budgetFor("max", 32768, true);
check("low 档 = 2048", normal === 2048, String(normal));
check("medium 档 = 8192", normalMid === 8192, String(normalMid));
check("max 档 = 模型容量", normalMax === 32768, String(normalMax));
check("关不掉思考的模型整条阶梯翻倍", budgetFor("low", 32768, false) === 4096);
check("档位天花板不超过模型容量", budgetFor("medium", 4096, true) === 4096);
check("Deep 档在容量低于档位时跟着容量", budgetFor("max", 4096, true) === 4096);
check("未知档位落到默认（均衡）", budgetFor(undefined, 32768, true) === normalMid);
check("预算不低于最低值", budgetFor("low", 100, true) === 512);
check("调用方的上限只能压低预算", budgetFor("max", 32768, true, 4096) === 4096);
check("off 档落到最小预算", normalizeLevel("off") === "minimal" && budgetFor("minimal", 32768, true) === 2048);
check("有菜单的模型预算 = 容量", budgetFor("low", 384000, true, undefined, true) === 384000);

const ids = [
	"deepseek-v4.1-flash-free",
	"glm-5.3-flash-free",
	"nemotron-3.5-super-vl-free",
	"big-pickle",
	"space-bunny-free",
	"flint-40b-free",
	"some-paid-id",
];
const catalog = buildCatalog(ids);
const byId = Object.fromEntries(catalog.map((entry) => [entry.id, entry]));
check("付费 id 被排除", catalog.length === 6, `${catalog.length} 个`);
check("big-pickle 被认作免费层", byId["big-pickle"] !== undefined);
check("deepseek-v4.1 的覆盖生效", byId["deepseek-v4.1-flash-free"]?.contextWindow === 1048576 && byId["deepseek-v4.1-flash-free"]?.maxOutput === 384000);
check("deepseek-v4.1 声明了 off 档", byId["deepseek-v4.1-flash-free"]?.canDisableThinking === true);
check("glm-5.3 视觉被修正", byId["glm-5.3-flash-free"]?.vision === true);
check("nemotron VL 视觉被修正", byId["nemotron-3.5-super-vl-free"]?.vision === true);
check("没有菜单的 id 落回阶梯", byId["flint-40b-free"]?.efforts === undefined);
check("off 映射到模型的 none", JSON.stringify(effortPatchFor(byId["deepseek-v4.1-flash-free"], "off")) === JSON.stringify({ reasoning_effort: "none" }));
check("max 映射到模型自己的 max", JSON.stringify(effortPatchFor(byId["glm-5.3-flash-free"], "max")) === JSON.stringify({ reasoning_effort: "max" }));
check("菜单外的档位取最近值", JSON.stringify(effortPatchFor(byId["nemotron-3.5-super-vl-free"], "max")) === JSON.stringify({ reasoning_effort: "xhigh" }));
check("无菜单时不发 effort 字段", effortPatchFor(byId["flint-40b-free"], "high") === undefined);
check("没选档位时落到模型默认档", JSON.stringify(effortPatchFor(byId["deepseek-v4.1-flash-free"], undefined)) === JSON.stringify({ reasoning_effort: "high" }));
check("菜单模型在 Pi 里可选深思档", thinkingLevelMapFor(byId["deepseek-v4.1-flash-free"]).max !== undefined && thinkingLevelMapFor(byId["deepseek-v4.1-flash-free"]).xhigh !== undefined);
check("没有 off 档的模型隐藏 Off", thinkingLevelMapFor(byId["glm-5.3-flash-free"]).off === null);
check("无菜单模型暴露深思档", thinkingLevelMapFor(undefined).max === "max");

// --- Kilo 目录 ------------------------------------------------------------

const kiloPayload = {
	data: [
		{
			id: "nvidia/nemotron-3.5-lightning:free",
			name: "NVIDIA: Nemotron 3.5 Lightning (free)",
			isFree: true,
			context_length: 1000000,
			top_provider: { max_completion_tokens: 65536 },
			architecture: { input_modalities: ["text"] },
			supported_parameters: ["tools", "reasoning"],
		},
		{
			id: "kilo-auto/free",
			name: "Auto Free",
			isFree: true,
			context_length: 256000,
			top_provider: { max_completion_tokens: 32768 },
			architecture: { input_modalities: ["text"] },
			supported_parameters: ["reasoning"],
		},
		{ id: "paid/model", name: "Paid", isFree: false },
	],
};
const kilo = buildKiloCatalog(kiloPayload);
const lightning = kilo.find((entry) => entry.id.startsWith("nvidia/"));
const auto = kilo.find((entry) => entry.id === "kilo-auto/free");
check("Kilo 免费切片正确", kilo.length === 2, `${kilo.length} 个`);
check("Kilo 名字去掉厂商前缀", lightning?.name === "Kilo Nemotron 3.5 Lightning", lightning?.name);
check("Kilo 推理菜单来自 supported_parameters", lightning?.efforts?.includes("disabled") === true);
check("自动路由没有 off 档", auto?.efforts?.includes("disabled") === false);
check("Kilo off 走 enabled:false", JSON.stringify(effortPatchFor(lightning, "off")) === JSON.stringify({ reasoning: { enabled: false } }));

// --- 真实网络：名单 + 探测 ------------------------------------------------

const listingRes = await fetch(`${ZEN_BASE}/inference/v1/models`, {
	headers: { ...zenHeaders(sessionForConversation("listing:selftest")), accept: "application/json" },
});
check("zen listing 可达", listingRes.ok, `HTTP ${listingRes.status}`);
const liveIds = parseListing(await listingRes.json());
const liveCatalog = buildCatalog(liveIds);
check("从 listing 里筛出免费层", liveCatalog.length > 0, `${liveCatalog.length} 个`);
console.log(`      免费 id: ${liveCatalog.map((entry) => entry.id).join(", ")}`);

const zenVerdicts = {};
let available = 0;
for (const entry of liveCatalog) {
	const result = await probeModel(entry.id, { timeoutMs: 12000 });
	zenVerdicts[entry.id] = { state: result.state, detail: result.detail, at: result.at };
	if (result.state === STATE.available) available += 1;
	console.log(`      ${entry.id.padEnd(34)} ${result.state.padEnd(15)} ${result.detail ?? ""}`);
}
const validStates = new Set(Object.values(STATE));
check("每个模型都拿到合法判决", Object.values(zenVerdicts).every((v) => validStates.has(v.state)));
const hidden = liveCatalog.filter((entry) => !isRoutable(zenVerdicts[entry.id].state));
check("只有被点名拒绝的才被挡在 picker 外", hidden.every((entry) => zenVerdicts[entry.id].state === STATE.unavailable), hidden.map((entry) => entry.id).join(",") || "(无)");
check("区域受限的仍可路由", liveCatalog.filter((entry) => zenVerdicts[entry.id].state === STATE.regionBlocked).every(() => isRoutable(STATE.regionBlocked)));
// 免费池经常整体限流（0 可用是上游状态，不是实现问题），所以只报告、不判失败。

const kiloRes = await fetch(`${KILO_BASE}/models`, { headers: { accept: "application/json" } });
check("kilo listing 可达", kiloRes.ok, `HTTP ${kiloRes.status}`);
const liveKilo = buildKiloCatalog(await kiloRes.json());
check("筛出 kilo 免费池", liveKilo.length > 0, `${liveKilo.length} 个`);

saveSnapshot(SNAPSHOT, { zen: liveCatalog, kilo: liveKilo, verdicts: zenVerdicts });
const back = loadSnapshot(SNAPSHOT);
check("快照可回读", back?.zen.length === liveCatalog.length && back?.kilo.length === liveKilo.length);
check("快照保留判决", Object.keys(back?.verdicts ?? {}).length === Object.keys(zenVerdicts).length);

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`} · zen ${available}/${liveCatalog.length} 可用 · kilo ${liveKilo.length} 个免费模型`);
process.exit(failures === 0 ? 0 : 1);
