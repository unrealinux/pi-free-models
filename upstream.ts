/**
 * Zen 免密通道的 wire 层。移植自 dsh-our-free-model 的 src/upstream.js。
 *
 * 这里编码的每一条事实都来自对网关的直接测量：公共池化凭证 `Bearer public`、
 * 客户端指纹头、按模型分流的 endpoint、免费层的 tool quartet 门禁
 * (缺一个名字就 403 FreeTierError)、按 session 计的额度、区域门禁。
 *
 * @module upstream
 */
import crypto from "node:crypto";

/** 可覆盖，好让自检把适配器指向一个死端口而不消耗真实额度。 */
export const ZEN_BASE = process.env.PI_ZEN_BASE ?? "https://opencode.ai";

/** 网关的 User-Agent 检查要求版本号 >= 1.17。 */
export const ZEN_UA = "opencode/1.18.31";

/**
 * provider 的 baseUrl。
 *
 * Pi 自带的实现自己拼端点后缀（`/chat/completions`、`/responses`、`/messages`），
 * 所以 baseUrl 必须停在三种 wire 的共同父路径上，而不是网关根。
 */
export const ZEN_API_BASE = `${ZEN_BASE}/zen/v1`;

/** 免费层要求声明的四个小写工具名。 */
export const QUARTET = ["bash", "glob", "grep", "read"] as const;

export type Wire = "chat" | "responses" | "messages";

/**
 * 能替某个 quartet 槽位出面的真实工具，按所需拼写索引。
 * dsh 在 Windows 上把 shell 叫 `pwsh`，所以 `bash` 槽位有供体。
 * Pi 把 glob 工具叫 `find`，所以 `glob` 槽位有供体 —— 这一条是移植时唯一
 * 需要改写的地方，其余照原样。
 */
const DONORS: Record<string, string[]> = {
	bash: ["powershell", "pwsh"],
	glob: ["find"],
};

const RESPONSES_RE = /^muse[-_]?spark/;
const MESSAGES_IDS = new Set(["union-alpha"]);

const MAX_SESSION_LENGTH = 256;
const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;
export const REQUEST_RE = /^msg_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

function base62From(bytes: Buffer): string {
	let out = "";
	for (const byte of bytes) out += BASE62[byte % 62];
	return out;
}

/** 剥掉结尾的 `(level)` 思考后缀，让查表落在基础 id 上。 */
export function baseModelId(model: unknown): string {
	return String(model ?? "")
		.replace(/\([^()]+\)\s*$/, "")
		.trim();
}

function isMuseSpark(modelId: string): boolean {
	const clean = baseModelId(modelId);
	const base = clean.includes("/") ? clean.split("/").pop()! : clean;
	return RESPONSES_RE.test(base);
}

export function wireFor(modelId: string): Wire {
	if (isMuseSpark(modelId)) return "responses";
	if (MESSAGES_IDS.has(baseModelId(modelId))) return "messages";
	return "chat";
}

/** 这个模型由哪条上游路径供给。 */
export function endpointFor(modelId: string): string {
	const wire = wireFor(modelId);
	if (wire === "responses") return "/zen/v1/responses";
	if (wire === "messages") return "/zen/v1/messages";
	return "/zen/v1/chat/completions";
}

let lastStamp = 0;
let seq = 0;

/** 铸造网关形态的规范 session id（时间前缀 + 单调计数器）。 */
export function mintSessionId(timestamp = Date.now()): string {
	if (timestamp !== lastStamp) {
		lastStamp = timestamp;
		seq = 0;
	}
	seq += 1;
	const value = ~(BigInt(timestamp) * 0x1000n + BigInt(seq));
	let hex = "";
	for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
	return `ses_${hex}${base62From(crypto.randomBytes(14))}`;
}

/** 为一轮请求铸造网关形态的 request id。 */
export function mintRequestId(timestamp = Date.now()): string {
	const value = BigInt(timestamp) * 0x1000n + 1n;
	let hex = "";
	for (let i = 0; i < 6; i += 1) hex += Number((value >> BigInt(40 - 8 * i)) & 0xffn).toString(16).padStart(2, "0");
	return `msg_${hex}${base62From(crypto.randomBytes(14))}`;
}

/**
 * 把一段下游对话映射到稳定的上游 session。
 *
 * 免费层额度按 session 计，所以每次请求都铸新 id 会迅速耗光，表现为 429 且
 * retry-after 不断增长。对 harness session id 取摘要，让同一段对话在重启后
 * 仍然是同一个规范 session —— 真实客户端就是这么做的。
 */
export function sessionForConversation(sessionId?: string): string {
	if (typeof sessionId === "string" && SESSION_RE.test(sessionId.trim())) return sessionId.trim();
	const seed = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "global";
	const digest = crypto.createHash("sha256").update(`pi-free-models\0${seed}`).digest();
	return `ses_${digest.subarray(0, 6).toString("hex")}${base62From(digest.subarray(6, 20))}`;
}

/** 稳定的一轮 request id：同一轮的重试共用它。 */
export function requestIdFor(sessionId: string, turnSeed?: string): string {
	if (typeof turnSeed !== "string" || turnSeed === "") return mintRequestId();
	const digest = crypto.createHash("sha256").update(`pi-free-models-req\0${sessionId}\0${turnSeed}`).digest();
	const id = `msg_${digest.subarray(0, 6).toString("hex")}${base62From(digest.subarray(6, 20))}`;
	return REQUEST_RE.test(id) ? id : mintRequestId();
}

export function truncateSession(value: unknown): string {
	if (typeof value !== "string") return "";
	const trimmed = value.trim();
	return trimmed.length > MAX_SESSION_LENGTH ? trimmed.slice(0, MAX_SESSION_LENGTH) : trimmed;
}

/**
 * 网关用来辨认正牌桌面客户端的头。
 * `Authorization: Bearer public` 是池化免密凭证 —— 这条通道上没有每用户密钥。
 */
export function zenHeaders(session: string, requestId: string): Record<string, string> {
	return {
		authorization: "Bearer public",
		"user-agent": ZEN_UA,
		"x-opencode-client": "desktop",
		"x-opencode-session": session,
		"x-opencode-request": requestId,
		"x-opencode-project": "global",
	};
}

function toolNameOf(tool: any): string {
	if (!tool || typeof tool !== "object" || Array.isArray(tool)) return "";
	if (typeof tool.name === "string" && tool.name.trim()) return tool.name.trim();
	const fn = tool.function;
	if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") return fn.name.trim();
	return "";
}

function quartetKey(name: string): string {
	const lower = String(name ?? "").trim().toLowerCase();
	return (QUARTET as readonly string[]).includes(lower) ? lower : "";
}

/** Chat 形态的 `{function:{…}}` 外壳，Responses 的扁平形态返回 null。 */
function functionOf(tool: any): any {
	return tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
}

/**
 * 满足 `body.tools` 上的免费层指纹门禁。
 *
 * 门禁要求四个小写名字全部被声明。Pi 自己的 `bash`/`grep`/`read` 已经答得上，
 * 缺的 `glob` 由真实工具 `find` 顶替，让调用回来是可执行的而不是一个死诱饵。
 * 只有实在没有供体的槽位才补一个自述不可用的替身。大小写变体会被规范化而不是
 * 重复（上游把 `Bash` + `bash` 判为重复），重命名映射让响应侧能还原调用方拼写
 * —— 这才让被顶替的工具真正可调用。
 *
 * @returns 发送时拼写 -> 调用方拼写
 */
export function applyFingerprint(body: any, wire: Wire): Map<string, string> {
	const flat = wire === "responses";
	const claude = wire === "messages";
	const map = new Map<string, string>();
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const hadClientTools = tools.length > 0;
	const seen = new Set<string>();
	const out: any[] = [];

	for (const tool of tools) {
		const current = toolNameOf(tool);
		const key = quartetKey(current);
		if (!key) {
			out.push(tool);
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		if (current !== key) {
			map.set(key, current);
			const fn = functionOf(tool);
			out.push(fn ? { ...tool, function: { ...fn, name: key } } : { ...tool, name: key });
		} else {
			out.push(tool);
		}
	}

	// 诱饵是模型真会去调用的名字：只有 `powershell` 的会话里，`bash` 诱饵被记录到
	// 一轮内被调用 24 次，每次都是未知工具。把真实工具提升进槽位对门禁零成本
	// —— 门禁只看声明的名字 —— 而调用回来是可执行的。
	const promoted = new Set<string>();
	for (const name of QUARTET) {
		if (seen.has(name)) continue;
		const donors = DONORS[name] ?? [];
		const index = out.findIndex((tool) => {
			const original = toolNameOf(tool);
			if (original === "" || quartetKey(original) !== "") return false;
			const lower = original.toLowerCase();
			return !promoted.has(lower) && donors.includes(lower);
		});
		if (index === -1) continue;
		const tool = out[index];
		const original = toolNameOf(tool);
		promoted.add(original.toLowerCase());
		map.set(name, original);
		const fn = functionOf(tool);
		out[index] = fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
		seen.add(name);
	}

	for (const name of QUARTET) {
		if (seen.has(name)) continue;
		out.push(
			claude
				? { name, description: "This tool is currently unavailable and must not be used.", input_schema: { type: "object", properties: {} } }
				: flat
					? { type: "function", name, description: "This tool is currently unavailable and must not be used.", parameters: { type: "object", properties: {} } }
					: { type: "function", function: { name, description: "This tool is currently unavailable and must not be used.", parameters: { type: "object", properties: {} } } },
		);
	}

	body.tools = out;
	if (!body.tool_choice) {
		if (flat) body.tool_choice = "auto";
		else if (!hadClientTools) body.tool_choice = claude ? { type: "none" } : "none";
	}
	return map;
}

/** 在流式增量或最终载荷里还原调用方的工具拼写。 */
export function restoreToolName(name: string, map: Map<string, string>): string {
	return map.get(name) ?? name;
}
