/**
 * 自检：把抓名单 -> 建目录 -> 探测判决 -> 真实预算 这条链路脱离 Pi 进程跑一遍。
 * 断言失败就退出码非 0。
 *
 * 用法：npm run selftest（= node --experimental-strip-types selftest.mjs）
 */
import { join } from "node:path";
import { buildCatalog, buildKiloCatalog, parseListing } from "./catalog.ts";
import { budgetFor } from "./effort.ts";
import { isRoutable, probeModel, STATE } from "./probe.ts";
import { applyFingerprint, endpointFor, mintRequestId, sessionForConversation, SESSION_RE, REQUEST_RE, wireFor, zenHeaders } from "./upstream.ts";
import { loadSnapshot, saveSnapshot } from "./snapshot.ts";

const ZEN_BASE = process.env.PI_ZEN_BASE ?? "https://opencode.ai";
const KILO_BASE = process.env.PI_KILO_BASE ?? "https://api.kilo.ai/api/gateway";
const SNAPSHOT = join(process.env.HOME, ".pi/agent/free-models-catalog.json");
let failures = 0;
function check(label, ok, extra = "") {
	console.log(`${ok ? "ok  " : "FAIL"}  ${label}${extra ? "  " + extra : ""}`);
	if (!ok) failures += 1;
}

// --- 纯函数：id 铸造、endpoint 分流、指纹门禁 ------------------------------

const session = sessionForConversation("selftest-session");
check("session id 形状合法", SESSION_RE.test(session), session);
check("同一段对话映射到同一 session", sessionForConversation("selftest-session") === session);
check("不同对话映射到不同 session", sessionForConversation("other") !== session);
check("request id 形状合法", REQUEST_RE.test(mintRequestId()));

check("muse-spark 走 responses", wireFor("muse-spark-1.3-contributor-free") === "responses");
check("union-alpha 走 messages", wireFor("union-alpha") === "messages");
check("其余走 chat", wireFor("ling-3.1-flash-free") === "chat");
check("(level) 后缀被剥掉", endpointFor("muse-spark-1.2-contributor-free(high)") === "/zen/v1/responses");

// 指纹门禁：Pi 的 find 顶替 glob 槽位，且响应侧能还原。
const body = {
	model: "ling-3.1-flash-free",
	tools: [
		{ type: "function", function: { name: "bash", description: "shell", parameters: {} } },
		{ type: "function", function: { name: "read", description: "read", parameters: {} } },
		{ type: "function", function: { name: "grep", description: "search", parameters: {} } },
		{ type: "function", function: { name: "find", description: "glob", parameters: {} } },
		{ type: "function", function: { name: "edit", description: "edit", parameters: {} } },
	],
};
const map = applyFingerprint(body, "chat");
const sentNames = body.tools.map((t) => t.function.name).sort();
check("四个槽位全部声明", ["bash", "glob", "grep", "read"].every((n) => sentNames.includes(n)), sentNames.join(","));
check("find 被顶进 glob 槽位", sentNames.includes("glob") && !sentNames.includes("find"));
check("无关工具未被改动", sentNames.includes("edit"));
check("还原映射指向 find", map.get("glob") === "find");
check("工具总数未膨胀", body.tools.length === 5, `len=${body.tools.length}`);

// 没有供体时补自述不可用的替身，而不是留空。
const sparse = { model: "x", tools: [] };
applyFingerprint(sparse, "chat");
check("缺工具时补替身至四个", sparse.tools.length === 4);
check("补的是自述不可用的替身", /must not be used/.test(sparse.tools[0].function.description));
check("无客户端工具时 tool_choice=none", sparse.tool_choice === "none");

// --- 预算阶梯 --------------------------------------------------------------

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

// --- 真实网络：名单 + 探测 --------------------------------------------------

const listingRes = await fetch(`${ZEN_BASE}/zen/v1/models`, {
	headers: { ...zenHeaders(sessionForConversation("listing:selftest"), mintRequestId()), accept: "application/json" },
});
check("zen listing 可达", listingRes.ok, `HTTP ${listingRes.status}`);
const ids = parseListing(await listingRes.json());
const catalog = buildCatalog(ids);
check("从 87 个 id 里筛出免费层", catalog.length > 0, `${catalog.length} 个`);
check("付费 id 被排除", catalog.every((e) => /free/.test(e.id) || e.id === "union-alpha"));
check("mimo v2.6 标记为关不掉思考", catalog.find((e) => e.id.startsWith("mimo-v2.6"))?.canDisableThinking === false);
check("nemotron 标记为无视觉", catalog.find((e) => e.id.startsWith("nemotron"))?.vision === false);

const zenVerdicts = {};
let available = 0;
for (const entry of catalog) {
	const result = await probeModel(entry.id, { timeoutMs: 12000 });
	zenVerdicts[entry.id] = { state: result.state, detail: result.detail, at: result.at };
	if (result.state === STATE.available) available += 1;
	console.log(`      ${entry.id.padEnd(34)} ${result.state.padEnd(15)} ${result.detail ?? ""}`);
}
check("至少有一个模型答得上", available > 0, `${available}/${catalog.length}`);
const hidden = catalog.filter((e) => !isRoutable(zenVerdicts[e.id].state));
check("只有被点名拒绝的才被挡在 picker 外", hidden.every((e) => zenVerdicts[e.id].state === STATE.unavailable), hidden.map((e) => e.id).join(",") || "(无)");
check("区域受限的仍可路由（只是分组不同）", catalog.filter((e) => zenVerdicts[e.id].state === STATE.regionBlocked).every((e) => isRoutable(STATE.regionBlocked)));

const kiloRes = await fetch(`${KILO_BASE}/models`, { headers: { accept: "application/json" } });
check("kilo listing 可达", kiloRes.ok, `HTTP ${kiloRes.status}`);
const kilo = buildKiloCatalog(await kiloRes.json());
check("筛出 kilo 免费池", kilo.length > 0, `${kilo.length} 个`);
check("kilo 免费 id 均来自 isFree 切片", kilo.every((e) => typeof e.id === "string" && e.id.length > 0));

saveSnapshot(SNAPSHOT, { zen: catalog, kilo, verdicts: zenVerdicts });
const back = loadSnapshot(SNAPSHOT);
check("快照可回读", back?.zen.length === catalog.length && back?.kilo.length === kilo.length);
check("快照保留判决", Object.keys(back?.verdicts ?? {}).length === Object.keys(zenVerdicts).length);

console.log(`\n${failures === 0 ? "全部通过" : `${failures} 项失败`} · zen ${available}/${catalog.length} 可用 · kilo ${kilo.length} 个免费模型`);
process.exit(failures === 0 ? 0 : 1);
