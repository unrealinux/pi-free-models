/**
 * Pi 版 dsh-our-free-model —— 免登录、免注册、免 API Key 的免费模型通道。
 *
 * 移植自 https://github.com/Ebony-Vinyl/dsh-our-free-model 的完整逻辑：
 * 上游 wire（v2 指纹头 / 规范 session / 按模型分 endpoint / read+shell 门禁）、
 * 模型目录与能力表、可用性探测与判决、推理强度到真实预算/菜单的映射。
 *
 * 承载方式是 Pi 的 provider extension：`pi.registerProvider` + `streamSimple`
 * 委托给 pi-ai 自带的 API 实现，所以请求编码、工具调用、用量记账、取消、
 * 上下文溢出重试全部复用 Pi 自己的行为，只在这些通道特有的地方介入。
 *
 * 用法：装好后直接选 `zen-free/*` 或 `kilo-free/*` 的模型，不需要任何凭证。
 *
 * @module free-models
 */
import {
	type Api,
	type AssistantMessageEventStream,
	type Model,
	anthropicMessagesApi,
	createAssistantMessageEventStream,
	openAICompletionsApi,
	openAIResponsesApi,
	type SimpleStreamOptions,
	type TranscriptContext,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

import { loadSnapshot as loadSnapshotFile, saveSnapshot as saveSnapshotFile } from "./snapshot.ts";
import { buildCatalog, buildKiloCatalog, KILO_BASE, parseListing, type CatalogEntry, type KiloEntry } from "./catalog.ts";
import { budgetFor, budgetLadder, effortPatchFor, hasEffortMenu, normalizeLevel, thinkingLevelMapFor } from "./effort.ts";
import { isRoutable, probeModel, probeRoundLocked, throttleBackoffMs, type ProbeState } from "./probe.ts";
import {
	applyFingerprint,
	FINGERPRINT_TOOLS,
	fingerprintStyle,
	sessionForConversation,
	wireFor,
	ZEN_API_BASE,
	ZEN_BASE,
	ZEN_UA,
	zenHeaders,
	type Wire,
} from "./upstream.ts";

export const ZEN_PROVIDER = "zen-free";
export const KILO_PROVIDER = "kilo-free";

const PROBE_TIMEOUT_MS = 8000;
const LISTING_TIMEOUT_MS = 15000;

/** 探测结果与能力表：id -> 判决。picker 的成员资格由它决定。 */
const verdicts = new Map<string, { state: ProbeState; detail?: string; retryAfterMs?: number; at: number }>();
const capabilityIndex = new Map<string, CatalogEntry>();
const kiloCapabilityIndex = new Map<string, KiloEntry>();

/**
 * 车道被锁时暂停探测：一轮读数全是 429 / 区域限制就暂停 30 分钟，
 * 连续失败翻倍到 120 分钟封顶（上游 `runProbeRound` 同款）。
 * 免费池的锁定窗口常以小时计，每次打开 /model 都重探只会白烧额度。
 */
let probeBackoffUntil = 0;
let probeThrottleStreak = 0;

/** 刷新失败时保留上一轮名单，而不是把它清空。 */
let zenCache: CatalogEntry[] = [];
let kiloCache: KiloEntry[] = [];

/**
 * 离线快照。
 *
 * 上游名单只能联网拿到，而 Pi 在启动时默认 `allowNetwork: false`；legacy 形式的
 * `refreshModels` 也不落盘。所以名单必须自己留一份：不清空、重启后 picker 不是空的，
 * 也就是项目里“远端目录保留一份快照以供离线启动”那条。
 */
const SNAPSHOT = join(getAgentDir(), "free-models-catalog.json");
const VALID_STATES = new Set(["available", "region-blocked", "unavailable", "throttled", "unknown"]);

/** 快照可能来自旧版本或被写坏；字段不全的行直接丢掉，而不是让它炸在 picker 里。 */
function usableEntry(value: any): boolean {
	return value !== null && typeof value === "object"
		&& typeof value.id === "string" && value.id !== ""
		&& Number.isFinite(value.contextWindow) && Number.isFinite(value.maxOutput);
}

function loadSnapshot() {
	const saved = loadSnapshotFile(SNAPSHOT);
	if (!saved) return;
	zenCache = saved.zen.filter(usableEntry) as CatalogEntry[];
	kiloCache = saved.kilo.filter(usableEntry) as KiloEntry[];
	for (const [id, verdict] of Object.entries(saved.verdicts)) {
		const state = (verdict as any)?.state;
		if (typeof state === "string" && VALID_STATES.has(state)) verdicts.set(id, verdict as any);
	}
	if (typeof saved.probeBackoffUntil === "number") probeBackoffUntil = saved.probeBackoffUntil;
	if (typeof saved.probeThrottleStreak === "number") probeThrottleStreak = saved.probeThrottleStreak;
}
function saveSnapshot() {
	saveSnapshotFile(SNAPSHOT, {
		zen: zenCache,
		kilo: kiloCache,
		verdicts: Object.fromEntries(verdicts),
		probeBackoffUntil,
		probeThrottleStreak,
	});
}

/**
 * Provider 级 api。Pi 只在 `model.api === extension.api` 时才调用本扩展的
 * `streamSimple`，所以每个 zen 模型的 `api` 都必须填这个值；真实的 wire
 * 由 `streamZen` 按模型 id 选择。
 */
const ZEN_API = "openai-completions" as Api;

const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

/**
 * 聊天通道用 `max_tokens`，并关掉 Pi 自带的 `reasoning_effort` 注入：
 * 有思考菜单的模型由 `effortPatchFor` 精确下发声明集合里的值，
 * 没有菜单的模型只靠 `maxTokens`。
 */
const CHAT_COMPAT = {
	maxTokensField: "max_tokens" as const,
	supportsStore: false,
	supportsDeveloperRole: false,
	supportsReasoningEffort: false,
};

function apiIdFor(wire: Wire): Api {
	if (wire === "responses") return "openai-responses";
	if (wire === "messages") return "anthropic-messages";
	return "openai-completions";
}

function implFor(wire: Wire) {
	if (wire === "responses") return openAIResponsesApi();
	if (wire === "messages") return anthropicMessagesApi();
	return openAICompletionsApi();
}

function compatFor(wire: Wire): Record<string, unknown> {
	if (wire === "responses") return { supportsMaxOutputTokens: true, supportsDeveloperRole: false };
	if (wire === "chat") return { ...CHAT_COMPAT };
	return {};
}

// ---------------------------------------------------------------------------
// Zen 免密通道
// ---------------------------------------------------------------------------

async function fetchZenCatalog(signal: AbortSignal): Promise<CatalogEntry[]> {
	const response = await fetch(`${ZEN_BASE}/inference/v1/models`, {
		headers: { ...zenHeaders(sessionForConversation("listing:zen")), accept: "application/json" },
		signal,
	});
	if (!response.ok) throw new Error(`zen listing HTTP ${response.status}`);
	return buildCatalog(parseListing(await response.json()));
}

/**
 * 探测，单个失败不影响其余；判决写进 verdicts。
 *
 * 并发压到 2：这条车道按 session 计配额，一口气打完会让探测自己撞上 429，
 * 判决全部退化成 throttled，探测就失去了分辨力（上游 probeCatalog 同样如此）。
 */
async function probeAll(entries: CatalogEntry[], signal: AbortSignal): Promise<void> {
	const queue = [...entries];
	const workers = Array.from({ length: Math.min(2, queue.length) }, async () => {
		while (queue.length > 0) {
			const entry = queue.shift()!;
			const result = await probeModel(entry.id, { signal, timeoutMs: PROBE_TIMEOUT_MS });
			verdicts.set(entry.id, { state: result.state, detail: result.detail, retryAfterMs: result.retryAfterMs, at: result.at });
		}
	});
	await Promise.all(workers);
	// 被 picker 的 15s 预算切断的轮次不足以说明额度状态，不要改暂停窗口。
	if (signal.aborted) return;
	const states = entries.map((entry) => verdicts.get(entry.id)?.state);
	if (!probeRoundLocked(states.filter((state): state is ProbeState => state !== undefined))) {
		probeThrottleStreak = 0;
		probeBackoffUntil = 0;
		return;
	}
	probeThrottleStreak += 1;
	probeBackoffUntil = Date.now() + throttleBackoffMs(probeThrottleStreak);
}

/**
 * 只有判决允许的模型进名单：网关点名拒绝的（`unavailable`）留下，
 * 5xx / 429 / 区域 / 无答复一律保留 —— 那些读数没有说模型什么。
 */
function zenModels(): ProviderModelConfig[] {
	return zenCache
		.filter((entry) => {
			const verdict = verdicts.get(entry.id);
			return verdict === undefined || isRoutable(verdict.state);
		})
		.map((entry) => {
			capabilityIndex.set(entry.id, entry);
			const regionLimited = verdicts.get(entry.id)?.state === "region-blocked";
			return {
				id: entry.id,
				name: regionLimited ? `${entry.name} · region-limited` : entry.name,
				api: ZEN_API,
				reasoning: entry.reasoning,
				input: (entry.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
				cost: ZERO_COST,
				contextWindow: entry.contextWindow,
				maxTokens: entry.maxOutput,
				thinkingLevelMap: thinkingLevelMapFor(entry) as any,
				compat: compatFor(entry.wire) as any,
			};
		});
}

function streamZen(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			const wire = wireFor(model.id);
			const session = sessionForConversation(options?.sessionId);
			const entry = capabilityIndex.get(model.id);
			const canDisableThinking = entry?.canDisableThinking !== false;
			const menu = hasEffortMenu(entry) ? entry : undefined;
			const budget = budgetFor(normalizeLevel(options?.reasoning), model.maxTokens, canDisableThinking, options?.maxTokens, menu !== undefined);

			// 响应侧要还原指纹门禁改过的工具名，否则 Pi 收到一个它没有的工具名。
			const nameMap = new Map<string, string>();

			// 用 wire 自己的 api 跑实现，让产出消息记的是真正跑过的协议。
			const inner = implFor(wire).streamSimple({ ...model, api: apiIdFor(wire) }, context, {
				...options,
				apiKey: "public",
				headers: zenHeaders(session),
				maxTokens: budget,
				onPayload: async (payload, forModel) => {
					const replaced = options?.onPayload ? await options.onPayload(payload, forModel) : undefined;
					const body = (replaced ?? payload) as Record<string, unknown>;
					const patch = effortPatchFor(menu, options?.reasoning);
					if (patch !== undefined) Object.assign(body, patch);
					for (const [sent, original] of applyFingerprint(body, fingerprintStyle(wire))) nameMap.set(sent, original);
					return body;
				},
			});

			for await (const event of inner) stream.push(restoreNames(event, nameMap));
			stream.end();
		} catch (error) {
			stream.push(errorEvent(model, error));
			stream.end();
		}
	})();
	return stream;
}

// ---------------------------------------------------------------------------
// Kilo 免费池
// ---------------------------------------------------------------------------

async function fetchKiloCatalog(signal: AbortSignal): Promise<KiloEntry[]> {
	const response = await fetch(`${KILO_BASE}/models`, {
		headers: { accept: "application/json", "user-agent": "pi-free-models" },
		signal,
	});
	if (!response.ok) throw new Error(`kilo listing HTTP ${response.status}`);
	return buildKiloCatalog(await response.json());
}

function kiloModels(): ProviderModelConfig[] {
	return kiloCache.map((entry) => {
		kiloCapabilityIndex.set(entry.id, entry);
		return {
			id: entry.id,
			name: entry.name,
			api: "openai-completions" as Api,
			reasoning: entry.reasoning,
			input: (entry.vision ? ["text", "image"] : ["text"]) as ("text" | "image")[],
			cost: ZERO_COST,
			contextWindow: entry.contextWindow,
			maxTokens: entry.maxOutput,
			thinkingLevelMap: thinkingLevelMapFor(entry) as any,
			compat: { ...CHAT_COMPAT } as any,
		};
	});
}

/**
 * Kilo 是这条通道里最简单的一环：固定 base URL，每回合一个普通 POST，
 * 不需要凭证、指纹或 session 铸造。唯一要带的是预算。
 */
function streamKilo(model: Model<Api>, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			const entry = kiloCapabilityIndex.get(model.id);
			const menu = hasEffortMenu(entry) ? entry : undefined;
			const budget = budgetFor(normalizeLevel(options?.reasoning), model.maxTokens, entry?.canDisableThinking !== false, options?.maxTokens, menu !== undefined);
			const inner = openAICompletionsApi().streamSimple(model, context, {
				...options,
				// apiKey 必须在 provider 层留着，否则 Pi 视其为未配置、模型不进 picker；
				// 但这条通道不需要凭证，所以把 SDK 自动加的 Authorization 头抑制掉
				// （传 `null` 就是抑制同名默认头）—— 带上它反而 401 INVALID_TOKEN。
				headers: { Authorization: null, authorization: null, "user-agent": "pi-free-models" } as any,
				maxTokens: budget,
				onPayload: async (payload, forModel) => {
					const replaced = options?.onPayload ? await options.onPayload(payload, forModel) : undefined;
					const body = (replaced ?? payload) as Record<string, unknown>;
					// Kilo 执行 OpenRouter 的 `reasoning` 对象；菜单里的档位才是真的控制项。
					const patch = effortPatchFor(menu, options?.reasoning);
					if (patch !== undefined) Object.assign(body, patch);
					return body;
				},
			});
			for await (const event of inner) stream.push(event);
			stream.end();
		} catch (error) {
			stream.push(errorEvent(model, error));
			stream.end();
		}
	})();
	return stream;
}

// ---------------------------------------------------------------------------
// 共用
// ---------------------------------------------------------------------------

function errorEvent(model: Model<Api>, error: unknown) {
	return {
		type: "error" as const,
		reason: "error" as const,
		error: {
			role: "assistant" as const,
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...ZERO_COST, total: 0 } },
			stopReason: "error" as const,
			errorMessage: error instanceof Error ? error.message : String(error),
			timestamp: Date.now(),
		},
	};
}

/** 在工具调用事件与最终消息里还原调用方的工具拼写。 */
function restoreNames(event: any, nameMap: Map<string, string>): any {
	if (nameMap.size === 0) return event;
	const restore = (block: any) => {
		if (block && block.type === "toolCall" && typeof block.name === "string") block.name = nameMap.get(block.name) ?? block.name;
	};
	if (event.type === "toolcall_end" && event.toolCall) restore(event.toolCall);
	if (event.partial?.content) for (const block of event.partial.content) restore(block);
	if (event.type === "done" && event.message?.content) for (const block of event.message.content) restore(block);
	return event;
}

// ---------------------------------------------------------------------------
// 注册
// ---------------------------------------------------------------------------

export default async function (pi: ExtensionAPI) {
	loadSnapshot();

	pi.registerProvider(ZEN_PROVIDER, {
		name: "Zen Free",
		baseUrl: ZEN_API_BASE,
		apiKey: "public",
		api: ZEN_API,
		headers: { "user-agent": ZEN_UA },
		models: zenModels(),
		streamSimple: streamZen,
		async refreshModels(context) {
			if (!context.allowNetwork) return zenModels();
			const timer = AbortSignal.timeout(LISTING_TIMEOUT_MS);
			const signal = AbortSignal.any([context.signal, timer]);
			try {
				zenCache = await fetchZenCatalog(signal);
				// 暂停窗口内只刷新名单，不探模型；context.force（Pi 的强制刷新）除外。
				if (context.force === true || probeBackoffUntil <= Date.now()) await probeAll(zenCache, signal);
				saveSnapshot();
			} catch {
				// 拉不到就保留上一轮名单，而不是把它们清空。
			}
			return zenModels();
		},
	});

	pi.registerProvider(KILO_PROVIDER, {
		name: "Kilo Free",
		baseUrl: KILO_BASE,
		apiKey: "kilo-free",
		authHeader: false,
		api: "openai-completions" as Api,
		models: kiloModels(),
		streamSimple: streamKilo,
		async refreshModels(context) {
			if (!context.allowNetwork) return kiloModels();
			try {
				kiloCache = await fetchKiloCatalog(AbortSignal.any([context.signal, AbortSignal.timeout(LISTING_TIMEOUT_MS)]));
				saveSnapshot();
			} catch {
				// 同上：失败保留上一轮。
			}
			return kiloModels();
		},
	});

	/** 设置页 4036 行的替代品：名单、判决、真实预算数字，一行一个模型。 */
	pi.registerCommand("free-models", {
		description: "免费通道状态：模型名单、可用性判决、探测暂停、各模型真实的档位/预算",
		handler: async (args, ctx) => {
			const force = String(args ?? "").trim().toLowerCase() === "reprobe";
			if (force) {
				probeThrottleStreak = 0;
				probeBackoffUntil = 0;
				if (zenCache.length > 0) {
					await probeAll(zenCache, AbortSignal.timeout(PROBE_TIMEOUT_MS * Math.ceil(zenCache.length / 2) + 5000));
					saveSnapshot();
				}
			}
			const lines: string[] = [];
			const stamp = (state: ProbeState | undefined) => (state === undefined ? "未探测" : state);
			const minutes = (ms: number) => Math.max(1, Math.round(ms / 60000));
			if (probeBackoffUntil > Date.now()) {
				lines.push(`探测暂停：还有 ${minutes(probeBackoffUntil - Date.now())} 分钟（连续 ${probeThrottleStreak} 轮全 429；/free-models reprobe 强制重探）`);
				lines.push("");
			}
			for (const id of [ZEN_PROVIDER, KILO_PROVIDER]) {
				lines.push(`── ${id} ──`);
				const list = id === ZEN_PROVIDER ? zenCache : kiloCache;
				if (list.length === 0) {
					lines.push("  （还没拉到名单，跑一次 /reload 或重启）");
					continue;
				}
				for (const entry of list) {
					const verdict = verdicts.get(entry.id);
					const menu = (entry as CatalogEntry | KiloEntry).efforts;
					const detail = menu !== undefined && menu.length > 0
						? `menu ${menu.join("/")}`
						: budgetLadder(entry.maxOutput, (entry as CatalogEntry).canDisableThinking !== false).map((rung) => `${rung.level[0]}${rung.tokens}`).join(" ");
					const hidden = verdict !== undefined && !isRoutable(verdict.state) ? "  [不进 picker]" : "";
					const retry = verdict?.retryAfterMs ? `  retry-after ${minutes(verdict.retryAfterMs)}min` : "";
					lines.push(`  ${entry.id.padEnd(36)} ${stamp(verdict?.state).padEnd(14)} max=${entry.maxOutput}  ${detail}${hidden}${retry}`);
					if (verdict?.detail) lines.push(`      ${verdict.detail}`);
				}
			}
			lines.push("");
			lines.push(`指纹门禁要求的工具名：${FINGERPRINT_TOOLS.join(" / ")}（官方定义逐字，缺一即 403）`);
			lines.push("探测退避：整轮全 429 时暂停 30→120 分钟；/free-models reprobe 强制一轮。");
			lines.push("免费池的 prompt 可能被上游记录，别发敏感内容。");
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
