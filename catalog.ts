/**
 * 免密通道的模型目录。移植自 dsh-our-free-model 的 src/catalog.js 与 src/kilo.js。
 *
 * 两个来源，刻意分层，任何单一来源都无法让插件失效：
 *
 * 1. 上游 listing 本身（`/zen/v1/models`）—— 网关当前愿意报出的 id 集合；
 * 2. 一张人工核过的能力表（上下文窗口 / 视觉 / 推理），因为 listing 只给一个 id。
 *
 * @module catalog
 */
import { baseModelId, wireFor, type Wire } from "./upstream.ts";

/** 不带 `-free` 后缀但属于免费层的 id。 */
const ALWAYS_FREE = new Set(["union-alpha", "space-bunny-free"]);

export interface Capability {
	vision: boolean;
	reasoning: boolean;
	contextWindow: number;
	maxOutput: number;
	/** 关不掉思考的模型，思考与可见答案共用一个天花板。 */
	canDisableThinking?: boolean;
}

/**
 * 本地能力基线。`contextWindow`/`maxOutput` 是提供方公布的上限；
 * `vision` 是这条通道在直接图像输入探测下实际接受的结果，不是模型卡的自述。
 */
const CAPABILITIES: Array<Capability & { match: RegExp }> = [
	{ match: /^mimo.*v2\.6/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
	{ match: /^mimo.*v2\.5/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072, canDisableThinking: false },
	{ match: /^mimo/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 131072 },
	{ match: /^muse.?spark/, vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072 },
	{ match: /^nemotron/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
	{ match: /^ling/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 32768 },
	{ match: /^longcat/, vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 },
	{ match: /^space.?bunny/, vision: true, reasoning: true, contextWindow: 262144, maxOutput: 65536 },
	{ match: /^union/, vision: true, reasoning: false, contextWindow: 262144, maxOutput: 131072 },
	{ match: /^deepseek/, vision: false, reasoning: true, contextWindow: 128000, maxOutput: 64000 },
	{ match: /^jev/, vision: false, reasoning: false, contextWindow: 32768, maxOutput: 4096 },
	{ match: /^exo/, vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 },
	{ match: /^fledge/, vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 },
];

const DEFAULT_CAPABILITY: Capability = { vision: false, reasoning: true, contextWindow: 131072, maxOutput: 32768 };

/** 面向人的显示名，原始上游 id 不该进 picker。 */
const DISPLAY_NAMES: Record<string, string> = {
	"mimo-v2.6-flash-free": "MiMo V2.6 Flash",
	"mimo-v2.5-free": "MiMo V2.5",
	"muse-spark-1.3-contributor-free": "Muse Spark 1.3",
	"muse-spark-1.2-contributor-free": "Muse Spark 1.2",
	"nemotron-3-ultra-free": "Nemotron 3 Ultra",
	"nemotron-3.5-lightning-free": "Nemotron 3.5 Lightning",
	"ling-3.0-flash-fin-free": "Ling 3.0 Flash Fin",
	"ling-3.1-flash-free": "Ling 3.1 Flash",
	"longcat-2.5-preview-free": "LongCat 2.5 Preview",
	"space-bunny-free": "Space Bunny",
	"union-alpha": "Union Alpha",
	"deepseek-v4-flash-free": "DeepSeek V4 Flash",
	"jev-1.13-free": "Jev 1.13",
};

/** 区域可用性已知随出口变化的 id。 */
const REGION_SENSITIVE = [/^muse.?spark/];

/** 这个 id 在免密通道上吗？listing 混着付费 id，只有这些不需要每用户密钥。 */
export function isFreeLane(modelId: string): boolean {
	const base = baseModelId(modelId);
	if (ALWAYS_FREE.has(base)) return true;
	return /(?:^|[-_])free(?:$|[-_.])/.test(base);
}

export function capabilitiesFor(modelId: string): Capability {
	const base = baseModelId(modelId);
	for (const entry of CAPABILITIES) if (entry.match.test(base)) return entry;
	return DEFAULT_CAPABILITY;
}

export function isRegionSensitive(modelId: string): boolean {
	const base = baseModelId(modelId);
	return REGION_SENSITIVE.some((pattern) => pattern.test(base));
}

/** 把一个裸上游 id 变成 picker 能显示的名字。 */
export function displayModelName(modelId: string): string {
	const base = baseModelId(modelId);
	const known = DISPLAY_NAMES[base];
	if (known !== undefined) return known;
	return base
		.replace(/[-_.]+/g, " ")
		.trim()
		.split(" ")
		.map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(" ");
}

export interface CatalogEntry {
	id: string;
	name: string;
	wire: Wire;
	vision: boolean;
	reasoning: boolean;
	contextWindow: number;
	maxOutput: number;
	canDisableThinking: boolean;
	regionSensitive: boolean;
}

/**
 * 把上游 listing 与本地能力表合并。
 *
 * @param ids 原始上游模型 id
 * @returns 按 listing 顺序排列的目录条目
 */
export function buildCatalog(ids: string[]): CatalogEntry[] {
	const seen = new Set<string>();
	const entries: CatalogEntry[] = [];
	for (const raw of ids) {
		const id = String(raw ?? "").trim();
		if (id === "" || !isFreeLane(id)) continue;
		const base = baseModelId(id);
		if (seen.has(base)) continue;
		seen.add(base);
		const caps = capabilitiesFor(base);
		entries.push({
			id: base,
			name: displayModelName(base),
			wire: wireFor(base),
			vision: caps.vision === true,
			reasoning: caps.reasoning !== false,
			contextWindow: caps.contextWindow,
			maxOutput: caps.maxOutput,
			canDisableThinking: caps.canDisableThinking !== false,
			regionSensitive: isRegionSensitive(base),
		});
	}
	return entries;
}

/** 解析网关的 `{"data":[{"id":…}]}` listing。 */
export function parseListing(payload: any): string[] {
	const rows = Array.isArray(payload?.data)
		? payload.data
		: Array.isArray(payload?.models)
			? payload.models
			: Array.isArray(payload)
				? payload
				: [];
	return rows.map((row: any) => (typeof row === "string" ? row : row?.id)).filter((id: any) => typeof id === "string" && id !== "");
}

// ---------------------------------------------------------------------------
// Kilo 通道
// ---------------------------------------------------------------------------

/**
 * Kilo AI 公开网关的免费池，完全不需要凭证 —— 没有 key、没有登录、没有指纹门禁。
 * 代价写在网关自己的模型卡上：免费池的 prompt 可能被上游记录并用于改进服务，
 * 所以这条通道是给随手用的活，不是给密钥的。
 */
export const KILO_BASE = (process.env.PI_KILO_BASE ?? "https://api.kilo.ai/api/gateway").replace(/\/+$/, "");

/** 免费池上关不掉思考的 id，菜单里因此没有 Off 一档。 */
const KILO_NO_DISABLE_IDS = new Set(["kilo-auto/free", "openrouter/free"]);

/** 去掉厂商前缀与 `(free)` 限定词，得到 picker 里的名字。 */
export function kiloDisplayName(id: string, upstreamName?: string): string {
	const raw = (upstreamName ?? id.split("/").pop() ?? id).replace(/\(free\)/gi, "").trim();
	return raw
		.replace(/[-_.]+/g, " ")
		.trim()
		.split(" ")
		.map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(" ");
}

export interface KiloEntry {
	id: string;
	name: string;
	contextWindow: number;
	maxOutput: number;
	vision: boolean;
	reasoning: boolean;
	canDisableThinking: boolean;
}

/** 把 Kilo listing 里 `isFree: true` 的那一片解析成目录条目。 */
export function buildKiloCatalog(payload: any): KiloEntry[] {
	const rows = Array.isArray(payload?.data) ? payload.data : Array.isArray(payload) ? payload : [];
	const out: KiloEntry[] = [];
	const seen = new Set<string>();
	for (const row of rows) {
		if (!row || row.isFree !== true) continue;
		const id = String(row.id ?? "").trim();
		if (id === "" || seen.has(id)) continue;
		seen.add(id);
		const arch = row.architecture ?? {};
		const modalities: string[] = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
		out.push({
			id,
			name: kiloDisplayName(id, row.name),
			contextWindow: Number(row.top_provider?.context_length) || Number(row.context_length) || 131072,
			maxOutput: Number(row.top_provider?.max_completion_tokens) || 32768,
			vision: modalities.includes("image"),
			// 免费池没有公布推理开关；一律声明为可推理，-effort 阶梯交给 max_tokens。
			reasoning: true,
			canDisableThinking: !KILO_NO_DISABLE_IDS.has(id),
		});
	}
	return out;
}
