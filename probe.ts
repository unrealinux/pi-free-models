/**
 * 可用性探测。移植自 dsh-our-free-model 的 src/probe.js。
 *
 * 网关不公布这个出口能用哪些模型：listing 是一个扁平 id 列表，排除只在请求被
 * `RegionError` 拒绝时才出现。所以可用性是"问出来"的 —— 用能产生判决的最小请求。
 *
 * @module probe
 */
import { applyFingerprint, endpointFor, fingerprintStyle, sessionForConversation, wireFor, zenHeaders, type Wire } from "./upstream.ts";
import { ZEN_BASE } from "./upstream.ts";

export const STATE = {
	available: "available",
	regionBlocked: "region-blocked",
	unavailable: "unavailable",
	throttled: "throttled",
	unknown: "unknown",
} as const;

export type ProbeState = (typeof STATE)[keyof typeof STATE];

export interface ProbeResult {
	state: ProbeState;
	detail?: string;
	latencyMs: number;
	ttftMs?: number;
	/** 上游 `Retry-After` 换算的毫秒数；429 时用来决定探测暂停多久。 */
	retryAfterMs?: number;
	at: number;
}

const PING_PROMPT = "ping";
const ROUTING_REFUSAL_STATUS = new Set([400, 404, 422]);

function pingBody(modelId: string, wire: Wire): Record<string, unknown> {
	const body: Record<string, unknown> =
		wire === "responses"
			? {
					model: modelId,
					input: [{ type: "message", role: "user", content: [{ type: "input_text", text: PING_PROMPT }] }],
					stream: true,
					store: false,
					max_output_tokens: 16,
				}
			: { model: modelId, messages: [{ role: "user", content: PING_PROMPT }], stream: true, max_tokens: 16 };
	// 探测必须和真实回合同形，否则测的不是同一件事：免费层的 FingerprintError
	// 同样拦探测，一个不带官方 read/shell 定义的 ping 会把能用的模型报成不可用。
	applyFingerprint(body, fingerprintStyle(wire));
	return body;
}

/**
 * 向网关问一个模型，一次。
 *
 * 判决的关键在于：答复是否**指名道姓地说这个模型不可路由**。只有那些来自答复
 * 本身的读数算数 —— 一条说的是模型的拒绝（`Model is unavailable`、`not supported`、
 * `no such model`），或者一个整体含义就是"我们发的那个标识符不认"的状态码
 * （400 拒绝它、404 已不再有它、422 拒绝这个组合）。这些读作不可用，picker 丢弃它。
 *
 * 其余一切都没有说模型什么，因此不得移动它：
 * - 5xx（含 503）是网关自己的麻烦，也是超载的池化账号最常说的话；
 * - 401/403/407 是池化凭证，408/425/429 是容量或传输 —— 下一个窗口可能就能答；
 * - 完全没有状态（传输失败、中止、超时、任何头之前就断掉的流）意味着没收到答复。
 */
export async function probeModel(modelId: string, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<ProbeResult> {
	const started = Date.now();
	const wire = wireFor(modelId);
	// 每个模型独立的上游 session。配额按 session 计数，整轮共用一个 session
	// 会让第一个模型吃掉配额、其余模型全部读作 429（上游 issue #561）。
	const session = sessionForConversation("probe:pi-free-models:" + modelId);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 45000);
	const onAbort = () => controller.abort();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	let firstDelta: number | undefined;
	let streamError: string | undefined;

	try {
		const response = await fetch(`${ZEN_BASE}${endpointFor(modelId)}`, {
			method: "POST",
			headers: {
				...zenHeaders(session),
				"content-type": "application/json",
				accept: "text/event-stream",
			},
			body: JSON.stringify(pingBody(modelId, wire)),
			signal: controller.signal,
		});

		if (!response.ok) {
			const text = await response.text().catch(() => "");
			return {
				state: stateOfStatus(response.status, text),
				detail: text.slice(0, 200),
				retryAfterMs: retryAfterMs(response.headers.get("retry-after")),
				latencyMs: Date.now() - started,
				at: Date.now(),
			};
		}

		const reader = response.body?.getReader();
		if (!reader) return { state: STATE.unknown, detail: "no response body", latencyMs: Date.now() - started, at: Date.now() };
		const decoder = new TextDecoder();
		let buffer = "";
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const payload = line.startsWith("data:") ? line.slice(5).trim() : "";
				if (payload === "" || payload === "[DONE]") continue;
				// 这条通道会把某些拒绝塞进 200 的流里 —— 本该是增量的位置上来了一个
				// `{"type":"error"}` 或 `{"error":…}` 帧。只看"delta 像不像 delta"会
				// 把这种流判成可用，于是每个正经回合都失败的模型带着绿色徽章留在 picker 里。
				if (streamError === undefined && /"(?:type"\s*:\s*"error"|"error"\s*:)/.test(payload)) {
					try {
						const parsed = JSON.parse(payload);
						const failure = parsed?.error ?? (parsed?.type === "error" ? parsed : undefined);
						if (failure !== undefined && failure !== null) {
							streamError = typeof failure.message === "string" ? failure.message : "upstream error";
							continue;
						}
					} catch {
						/* 不是这条通道发出的 JSON；下面的增量正则仍然会跑 */
					}
				}
				if (firstDelta !== undefined) continue;
				if (/"(delta|content|text|output_item)"|response\.(output_item|output_text|function_call)/.test(payload)) firstDelta = Date.now();
			}
			if (streamError !== undefined) break;
		}
		if (streamError !== undefined) {
			// 流内错误帧没有状态码，无法区分"网关自己在坏"与"它不要这个模型"，
			// dsh 一律读作 unknown —— 宁可在 picker 里留一条会失败一次的重试，
			// 也不要把一个能用的模型藏起来。
			return { state: STATE.unknown, detail: streamError.slice(0, 200), latencyMs: Date.now() - started, at: Date.now() };
		}
		if (firstDelta === undefined) {
			// 200 但整条流一个 delta 都没来，就是所谓"不是头说了算，是体说了算"的那个坑：
			// 头说 200，体里只有 `{"choices":[],"cost":"0"}`。这不给 available，否则
			// 一个永远答不出的模型会带着绿徽章留在 picker 里；unknown 仍可路由。
			return { state: STATE.unknown, detail: "stream ended without a single delta", latencyMs: Date.now() - started, at: Date.now() };
		}
		return {
			state: STATE.available,
			latencyMs: Date.now() - started,
			ttftMs: firstDelta === undefined ? undefined : firstDelta - started,
			at: Date.now(),
		};
	} catch (error: any) {
		return {
			state: STATE.unknown,
			detail: String(error?.message ?? error).slice(0, 200),
			latencyMs: Date.now() - started,
			at: Date.now(),
		};
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

/**
 * `Retry-After` 的秒数形式。HTTP 日期形式在这个网关上没出现过，忽略即可。
 */
export function retryAfterMs(value: string | null): number | undefined {
	const seconds = Number(value);
	return Number.isFinite(seconds) && seconds > 0 ? Math.trunc(seconds * 1000) : undefined;
}

/** 整轮全 429 时探测暂停多久：30 分钟起，连续失败翻倍，上限 120 分钟。 */
const THROTTLE_BACKOFF_START_MS = 30 * 60 * 1000;
const THROTTLE_BACKOFF_MAX_MS = 120 * 60 * 1000;

export function throttleBackoffMs(streak: number): number {
	const step = Math.max(1, Math.trunc(streak));
	return Math.min(THROTTLE_BACKOFF_START_MS * 2 ** (step - 1), THROTTLE_BACKOFF_MAX_MS);
}

/**
 * 这一轮读数是不是"车道被锁"：全部是 429 或区域限制，且至少有一个 429。
 *
 * 只看 `allThrottled` 会被稳定的区域限制模型阻止（它们永远不是 429），
 * 于是锁定时也会每轮重探。加入 available / unknown 就重置暂停：那是真的变化。
 */
export function probeRoundLocked(states: ProbeState[]): boolean {
	return states.length > 0
		&& states.some((state) => state === STATE.throttled)
		&& states.every((state) => state === STATE.throttled || state === STATE.regionBlocked);
}

/**
 * 把一个失败映射成判决。
 *
 * 不对称是刻意的：picker 里一条过期记录只让用户损失一个可以重试的失败回合，
 * 而一个因为抖动而消失的模型要用户走一遍他看不见的"重新探测再等待"周期。
 */
function stateOfStatus(status: number | undefined, body: string): ProbeState {
	const flat = String(body ?? "").toLowerCase();
	if (/region|not available in your country/.test(flat)) return STATE.regionBlocked;
	// 指纹门禁：这是请求自己没声明够（或上游把桌面客户端指纹又收紧了），
	// 不是网关在点名这个模型，所以不能把模型判死。
	if (/freetiererror|only be used from within/.test(flat)) return STATE.unknown;
	if (status === 429 || /usage limit|rate limit/.test(flat)) return STATE.throttled;
	// `type: server_error` 是网关在说它自己那段挂了，即使带的是 400，
	// 也不是在点名这个模型 —— 实测 `ling-3.0-flash-fin-free` 会以 400 + 
	// "Upstream request failed: Endpoint is unavailable" 答复，而同一个 id
	// 上一轮刚答得上来。
	if (/"type"\s*:\s*"server_error"/.test(flat)) return STATE.unknown;
	// 503 被每个反向代理拼成 "Service Unavailable"，而 `Upstream request failed:
	// Endpoint is unavailable` 说的是网关自己那一段挂了 —— 都不是在点名这个
	// 模型。把这类字词读成判决会让一个能用的模型掉出 picker 直到下一轮。
	const gatewayTrouble = Number.isInteger(status) && (status as number) >= 500;
	const named = !gatewayTrouble && /unavailable|not supported|no such model|unknown model|invalid model/.test(flat);
	if (named) return STATE.unavailable;
	if (Number.isInteger(status) && ROUTING_REFUSAL_STATUS.has(status as number)) return STATE.unavailable;
	return STATE.unknown;
}

/** 这次判决是否允许模型进入 picker。 */
export function isRoutable(state: ProbeState): boolean {
	return state === STATE.available || state === STATE.unknown || state === STATE.throttled || state === STATE.regionBlocked;
}
