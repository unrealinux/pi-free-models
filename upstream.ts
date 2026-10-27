/**
 * Zen 免密通道的 wire 层。移植自 dsh-our-free-model 的 src/upstream.js
 * （对应上游 2026-10-17 的 v2 客户端指纹）。
 *
 * 这里编码的每一条事实都来自对网关的直接测量（上游 docs/free-lane-wire.md）：
 *
 * - 聊天端点搬到 `/inference/v1`；`/zen/v1` 对免费 id 回 403。
 * - User-Agent 是 `opencode/latest/2.0.26/cli`，整串匹配。
 * - session id 的 12 位 hex 必须是 `~(ts<<12|counter)` 的降序编码；
 *   sha256 派生或升序时间戳会被 403。
 * - 免费层要求声明 `read` 与 `shell`，且定义与官方客户端逐字一致；
 *   `tool_choice: "none"` 与 v1 专用头 `x-opencode-request` 都是 403。
 *
 * @module upstream
 */
import crypto from "node:crypto";

/** 可覆盖，好让自检把适配器指向一个死端口而不消耗真实额度。 */
export const ZEN_BASE = process.env.PI_ZEN_BASE ?? "https://opencode.ai";

/** v2 指纹逐字匹配：任何前缀/后缀都不再算官方客户端。 */
export const ZEN_UA = "opencode/latest/2.0.26/cli";

/**
 * provider 的 baseUrl。
 *
 * Pi 自带的实现自己拼端点后缀（`/chat/completions`、`/responses`、`/messages`），
 * 所以 baseUrl 必须停在三种 wire 的共同父路径上。
 */
export const ZEN_API_BASE = `${ZEN_BASE}/inference/v1`;

/** 免费层 v2 门禁要求声明的两个工具名。 */
export const FINGERPRINT_TOOLS = ["read", "shell"] as const;

/** `true` 为 Responses 的扁平工具形状，`"claude"` 为 Messages，`false` 为 Chat。 */
export type FingerprintStyle = boolean | "claude";

export type Wire = "chat" | "responses" | "messages";

const RESPONSES_RE = /^muse[-_]?spark(?:$|[-_:.\s])/i;
const MESSAGES_IDS = new Set(["union-alpha"]);

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

export const SESSION_RE = /^ses_[0-9a-f]{12}[0-9A-Za-z]{14}$/;

/**
 * 上游只放行 counter 1–63 的降序时间戳：低 12 位落在 `0xfc0–0xfff`。
 * 形状对但编码不对（升序、随机、sha256）一样 403。
 */
export const SESSION_DESCENDING_RE = /^[0-9a-f]{9}f[c-f][0-9a-f]$/;

/**
 * 官方客户端的两个指纹工具，**逐字**来自 OpenCode v2.0.26 CLI。
 * 上游比对 description 与 parameters；改写措辞、精简 schema、`properties: {}`
 * 都会换来 403 FreeTierError。不要动这些字符串。
 */
export const FINGERPRINT_TOOL_DEFINITIONS: Record<string, { description: string; parameters: Record<string, unknown> }> = {
	"read": {
		"description": "Read the contents of a file or directory. Supports text files, images, and PDFs. Images and PDFs are presented directly to the model. Each text line is prefixed by its 1-based line number as <line>: <content>. The prefix is for reference and is not part of the file content. Directory entries are returned one per line. Use offset and limit to read large files or directories in sections. Prefer one larger read over many small slices, and use grep to find specific content in large files.",
		"parameters": {
			"type": "object",
			"properties": {
				"path": {
					"type": "string",
					"description": "File or directory to read"
				},
				"offset": {
					"type": "integer",
					"minimum": 0,
					"description": "The line or directory entry to start reading from (1-based)"
				},
				"limit": {
					"type": "integer",
					"minimum": 0,
					"description": "The maximum number of lines or directory entries to read (defaults to and capped at 2000)"
				}
			},
			"required": [
				"path"
			],
			"additionalProperties": false
		}
	},
	"shell": {
		"description": "Execute a shell command and return its output. Commands run on Linux using bash. Quote file paths containing spaces or special characters. Prefer dedicated tools over shell commands when possible. When output is large, the full result is saved to a file and a truncated preview is returned. Rely on automatic truncation unless filtering the output is more useful. Commands accept an optional timeout, background commands have no timeout by default. Background commands return immediately, and you will be notified when they complete.",
		"parameters": {
			"type": "object",
			"properties": {
				"command": {
					"type": "string",
					"description": "Shell command string to execute"
				},
				"workdir": {
					"type": "string",
					"description": "Working directory to execute the command in. Defaults to the current working directory. When possible, avoid changing directories in the command and set the working directory here instead."
				},
				"timeout": {
					"type": "integer",
					"minimum": 0,
					"description": "Timeout in milliseconds. Set to 0 to disable the timeout. Defaults to 120000 for foreground commands. Background commands have no timeout by default."
				},
				"background": {
					"type": "boolean",
					"description": "Run the command in the background and return immediately (useful for dev servers and long-running builds). You do not need to use '&' at the end of the command when using this parameter. You will be notified when it completes. DO NOT poll for completion."
				}
			},
			"required": [
				"command"
			],
			"additionalProperties": false
		}
	}
};

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

/** 这个模型由哪条上游路径供给。免费车道全部在 `/inference/v1` 下。 */
export function endpointFor(modelId: string): string {
	const wire = wireFor(modelId);
	if (wire === "responses") return "/inference/v1/responses";
	if (wire === "messages") return "/inference/v1/messages";
	return "/inference/v1/chat/completions";
}

/** 把 wire 映射成 `applyFingerprint` 需要的工具形状。 */
export function fingerprintStyle(wire: Wire): FingerprintStyle {
	if (wire === "responses") return true;
	if (wire === "messages") return "claude";
	return false;
}

/** 这个 id 已经是上游会接受的规范 session 吗？ */
export function isCanonicalSession(id: unknown): boolean {
	if (typeof id !== "string") return false;
	const trimmed = id.trim();
	return SESSION_RE.test(trimmed) && SESSION_DESCENDING_RE.test(trimmed.slice(4, 16));
}

/** 把 bytes 渲染成恰好 `width` 个 base62 字符（大端）。 */
function base62Fixed(bytes: Buffer, width: number): string {
	let n = 0n;
	for (const byte of bytes) n = (n << 8n) | BigInt(byte);
	const out = new Array<string>(width);
	for (let i = width - 1; i >= 0; i -= 1) {
		out[i] = BASE62[Number(n % 62n)];
		n /= 62n;
	}
	return out.join("");
}

/**
 * 把任意种子重新编码成上游接受的降序 session id。
 *
 * 摘要和参考网关一致（`ses\0<signal>` 的 sha256），所以同一段下游对话
 * 永远映射到同一个上游 session。counter 固定为 1，低 12 位落在 0xffe。
 */
export function canonicalizeSession(signal: string): string {
	const digest = crypto.createHash("sha256").update(`ses\0${signal}`).digest();
	const current = ((BigInt(digest[0]) << 28n | BigInt(digest[1]) << 20n | BigInt(digest[2]) << 12n |
		BigInt(digest[3]) << 4n | BigInt(digest[4]) >> 4n) << 12n) | 1n;
	const inverted = ~current & 0xffffffffffffn;
	const timeHex = inverted.toString(16).padStart(12, "0");
	return `ses_${timeHex}${base62Fixed(digest.subarray(6, 16), 14)}`;
}

/**
 * 把一段下游对话映射到稳定的上游 session。
 *
 * 免费层额度按 session 计，所以每次请求都铸新 id 会迅速耗光。会话 id 还带
 * 编码校验（{@link SESSION_DESCENDING_RE}），所以下游给的 id 只有在已经是
 * 规范形状时才原样转发，其余一律确定性地重编码。
 */
export function sessionForConversation(sessionId?: string): string {
	if (isCanonicalSession(sessionId)) return String(sessionId).trim();
	const seed = typeof sessionId === "string" && sessionId.trim() ? sessionId.trim() : "global";
	return canonicalizeSession(seed);
}

/**
 * 网关用来辨认正牌 v2 客户端的头。
 * `Authorization: Bearer public` 是池化免密凭证 —— 这条通道上没有每用户密钥。
 *
 * 四个 session 头必须同值；**不带** v1 专用头 `x-opencode-request`。
 */
export function zenHeaders(session: string): Record<string, string> {
	return {
		authorization: "Bearer public",
		"user-agent": ZEN_UA,
		"x-opencode-client": "cli",
		"x-opencode-session": session,
		"x-opencode-session-id": session,
		"x-session-affinity": session,
		"x-session-id": session,
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

/** 只有与门禁名逐字相等才算槽位；`Read`/`Shell` 这类变体原样透传。 */
function fingerprintKey(name: string): string {
	const trimmed = String(name ?? "").trim();
	return (FINGERPRINT_TOOLS as readonly string[]).includes(trimmed) ? trimmed : "";
}

/** Chat 形态的 `{function:{…}}` 外壳，Responses 的扁平形态返回 null。 */
function functionOf(tool: any): any {
	return tool.function && typeof tool.function === "object" && !Array.isArray(tool.function) ? tool.function : null;
}

function definitionOf(tool: any, shape: { claude: boolean; flat: boolean }): { description: unknown; schema: unknown } | null {
	const wrapper = shape.claude || shape.flat ? tool : functionOf(tool);
	if (wrapper === null || wrapper === undefined) return null;
	return { description: wrapper.description, schema: shape.claude ? wrapper.input_schema : wrapper.parameters };
}

/** 这个工具是否已经带着官方定义？ */
function carriesFingerprintDefinition(tool: any, name: string, shape: { claude: boolean; flat: boolean }): boolean {
	const own = definitionOf(tool, shape);
	if (own === null) return false;
	const want = FINGERPRINT_TOOL_DEFINITIONS[name];
	return own.description === want.description && JSON.stringify(own.schema) === JSON.stringify(want.parameters);
}

function withToolName(tool: any, name: string): any {
	const fn = functionOf(tool);
	return fn ? { ...tool, function: { ...fn, name } } : { ...tool, name };
}

/** 门禁要求的声明，按当前 wire 的工具形状生成。 */
function fingerprintTool(name: string, shape: { claude: boolean; flat: boolean }): any {
	const { description, parameters } = FINGERPRINT_TOOL_DEFINITIONS[name];
	if (shape.claude) return { name, description, input_schema: parameters };
	if (shape.flat) return { type: "function", name, description, parameters };
	return { type: "function", function: { name, description, parameters } };
}

/** `original -> alias`，用于把历史调用与 tool_choice 一起改名。 */
function aliasesByOriginal(map: Map<string, string>): Map<string, string> {
	return new Map([...map].map(([alias, original]) => [original, alias]));
}

/** 显式 `tool_choice` 指向被改名的工具时，改指到它的别名。 */
function retargetToolChoice(body: any, map: Map<string, string>): void {
	if (!body || typeof body !== "object" || map.size === 0) return;
	const choice = body.tool_choice;
	if (!choice || typeof choice !== "object" || Array.isArray(choice)) return;
	const aliases = aliasesByOriginal(map);
	if (typeof choice.name === "string") {
		const alias = aliases.get(choice.name.trim());
		if (alias !== undefined) body.tool_choice = { ...choice, name: alias };
		return;
	}
	const fn = choice.function;
	if (fn && typeof fn === "object" && !Array.isArray(fn) && typeof fn.name === "string") {
		const alias = aliases.get(fn.name.trim());
		if (alias !== undefined) body.tool_choice = { ...choice, function: { ...fn, name: alias } };
	}
}

/** 历史里对已改名工具的调用也要跟着改，否则模型会把旧调用读成门禁工具。 */
function aliasHistoryToolCalls(body: any, map: Map<string, string>): void {
	if (!body || typeof body !== "object" || map.size === 0) return;
	const aliases = aliasesByOriginal(map);
	const rename = (name: unknown) => (typeof name === "string" && aliases.has(name) ? aliases.get(name) : name);

	if (Array.isArray(body.input)) {
		body.input = body.input.map((item: any) => item?.type === "function_call" && aliases.has(item.name)
			? { ...item, name: aliases.get(item.name) }
			: item);
	}
	if (Array.isArray(body.messages)) {
		body.messages = body.messages.map((message: any) => {
			if (message === null || typeof message !== "object") return message;
			if (Array.isArray(message.content)) {
				const content = message.content.map((block: any) => block?.type === "tool_use" && aliases.has(block.name)
					? { ...block, name: aliases.get(block.name) }
					: block);
				return { ...message, content };
			}
			if (!Array.isArray(message.tool_calls)) return message;
			return {
				...message,
				tool_calls: message.tool_calls.map((call: any) => aliases.has(call?.function?.name)
					? { ...call, function: { ...call.function, name: aliases.get(call.function.name) } }
					: call),
			};
		});
	}
}

/** 注入的官方工具是占位物，提示模型别调它们。 */
function placeholderNote(names: readonly string[]): string {
	const list = names.map((name) => `\`${name}\``).join(" or ");
	return names.length > 1
		? `Do not call the ${list} tools; they are placeholders that do nothing. Use the other tools you have been given instead.`
		: `Do not call the ${list} tool; it is a placeholder that does nothing. Use the other tools you have been given instead.`;
}

function noteInjectedTools(body: any, shape: { claude: boolean; flat: boolean }, names: readonly string[]): void {
	const note = placeholderNote(names);
	if (shape.flat) {
		body.instructions = typeof body.instructions === "string" && body.instructions.trim() !== ""
			? `${body.instructions}\n\n${note}`
			: note;
		return;
	}
	if (shape.claude) {
		body.system = typeof body.system === "string" && body.system !== "" ? `${body.system}\n\n${note}` : note;
		return;
	}
	const messages = Array.isArray(body.messages) ? body.messages : [];
	const first = messages[0];
	if (first?.role === "system" && typeof first.content === "string") {
		body.messages = [{ ...first, content: `${first.content}\n\n${note}` }, ...messages.slice(1)];
		return;
	}
	body.messages = [{ role: "system", content: note }, ...messages];
}

/**
 * 满足 v2 免费层指纹门禁。
 *
 * 1. `read` 与 `shell` 必须声明，且定义与官方客户端逐字一致；
 * 2. 调用方的工具原样保留（`Read`/`Shell` 这类变体也不动）；
 * 3. 调用方正好用了 `read`/`shell` 但定义不同 → 改名为 `<name>_client[N]`，
 *    历史与 `tool_choice` 同步改名，响应侧再还原；
 * 4. 同名重复只留第一个；
 * 5. 绝不下发 `tool_choice: "none"` —— v2 见到就 403。
 *
 * @returns 发送时拼写 -> 调用方拼写（响应侧还原用；另含 `shell` -> `bash`
 *          的供体映射，让注入的 shell 调用在 Pi 里仍可执行）
 */
export function applyFingerprint(body: any, style: FingerprintStyle): Map<string, string> {
	const flat = style === true;
	const claude = style === "claude";
	const shape = { claude, flat };
	const aliasMap = new Map<string, string>();
	const tools = Array.isArray(body.tools) ? body.tools : [];
	const taken = new Set(tools.map((tool: any) => toolNameOf(tool)).filter((name: string) => name !== ""));
	const seen = new Set<string>();
	const present = new Set<string>();
	const out: any[] = [];

	for (const tool of tools) {
		const name = toolNameOf(tool);
		const key = fingerprintKey(name);
		if (key === "") {
			out.push(tool);
			continue;
		}
		if (seen.has(key)) continue;
		seen.add(key);
		if (carriesFingerprintDefinition(tool, key, shape)) {
			out.push(tool);
			present.add(key);
			continue;
		}
		// 调用方占用了门禁名但定义不同：改名后保留，官方定义另行注入。
		let alias = `${key}_client`;
		for (let i = 2; taken.has(alias); i += 1) alias = `${key}_client${i}`;
		taken.add(alias);
		aliasMap.set(alias, name);
		out.push(withToolName(tool, alias));
	}

	const injected: string[] = [];
	for (const name of FINGERPRINT_TOOLS) {
		if (present.has(name)) continue;
		out.push(fingerprintTool(name, shape));
		injected.push(name);
	}

	body.tools = out;
	retargetToolChoice(body, aliasMap);
	aliasHistoryToolCalls(body, aliasMap);
	if (injected.length > 0) noteInjectedTools(body, shape, injected);
	// v2 见到 `tool_choice: "none"` 就回 403。调用方留下的也一并清掉。
	if (body.tool_choice === "none"
		|| (body.tool_choice !== null && typeof body.tool_choice === "object" && body.tool_choice.type === "none")) {
		delete body.tool_choice;
	}
	if (flat && !body.tool_choice) body.tool_choice = "auto";

	const restore = new Map(aliasMap);
	// Pi 的 shell 工具叫 bash。注入的官方 shell 若被调用，还原成可执行的名字。
	if (injected.includes("shell") && taken.has("bash")) restore.set("shell", "bash");
	return restore;
}
