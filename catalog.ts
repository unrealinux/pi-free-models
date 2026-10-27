/**
 * 免密通道的模型目录。移植自 dsh-our-free-model 的 src/catalog.js（2026-10 版）。
 *
 * 两个来源，刻意分层，任何单一来源都无法让插件失效：
 *
 * 1. 上游 listing 本身（`/inference/v1/models`）—— 网关当前愿意报出的 id 集合；
 * 2. 一张人工核过的能力表（上下文窗口 / 视觉 / 推理 / 思考菜单），因为 listing
 *    只给一个 id。
 *
 * @module catalog
 */
import { baseModelId, wireFor, type Wire } from "./upstream.ts";

/** 不带 `-free` 后缀但属于免费层的 id。 */
const ALWAYS_FREE = new Set(["union-alpha", "space-bunny-free", "big-pickle"]);

/**
 * 一个模型声明的思考菜单。有菜单时，选中的档位会作为 `effortPatch`
 * 打到请求体上（网关会校验并执行），预算直接用模型容量；没有菜单时
 * 沿用免费层的 token 阶梯。
 */
export interface EffortMenu {
	efforts?: string[];
	effortDefault?: string;
	effortPatch?: Record<string, unknown>;
	effortOffPatch?: Record<string, unknown>;
}

export interface Capability extends EffortMenu {
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

/**
 * 当前线上 id 的逐项覆盖，优先于家族模式。
 *
 * 上游在 2026-10-17 重新探测后发现免费车道**开始校验并执行**
 * `reasoning_effort`：菜单里的档位会真实改变思考量。菜单只列模型自己声明的
 * 集合（models.dev 的 `reasoning_options`），因为集合外的值会被上游 400 拒掉。
 */
const FREE_ID_OVERRIDES: Record<string, Capability> = {
	"deepseek-v4.1-flash-free": {
		vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 384000,
		efforts: ["disabled", "low", "high", "max"], effortDefault: "high",
		effortPatch: { reasoning_effort: "$effort" },
		effortOffPatch: { reasoning_effort: "none" },
	},
	"glm-5.3-flash-free": {
		vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072,
		efforts: ["low", "high", "max"], effortDefault: "high",
		effortPatch: { reasoning_effort: "$effort" },
	},
	"nemotron-3.5-super-vl-free": {
		vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 131072,
		efforts: ["disabled", "minimal", "low", "medium", "high", "xhigh"], effortDefault: "high",
		effortPatch: { reasoning_effort: "$effort" },
		effortOffPatch: { reasoning_effort: "none" },
	},
	"space-bunny-free": {
		vision: true, reasoning: true, contextWindow: 1048576, maxOutput: 524288,
		efforts: ["low", "medium", "high", "xhigh", "max"], effortDefault: "high",
		effortPatch: { reasoning_effort: "$effort" },
	},
	"longcat-2.5-preview-free": {
		vision: false, reasoning: true, contextWindow: 1048576, maxOutput: 131072,
	},
	"big-pickle": {
		vision: true, reasoning: true, contextWindow: 262144, maxOutput: 131072,
	},
};

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
	"deepseek-v4.1-flash-free": "DeepSeek V4.1 Flash",
	"glm-5.3-flash-free": "GLM 5.3 Flash",
	"jev-1.13-free": "Jev 1.13",
	"big-pickle": "Big Pickle",
};

/** 区域可用性已知随出口变化的 id。 */
const REGION_SENSITIVE = [/^muse.?spark/];

/** 这个 id 在免密通道上吗？listing 混着付费 id，只有这些不需要每用户密钥。 */
export function isFreeLane(modelId: string): boolean {
	const base = baseModelId(modelId);
	if (ALWAYS_FREE.has(base)) return true;
	return /(?:^|[-_])free(?:$|[-_.])/.test(base);
}

/** 精确 id 覆盖优先，其次家族模式。 */
export function capabilitiesFor(modelId: string): Capability {
	const base = baseModelId(modelId);
	const override = FREE_ID_OVERRIDES[base];
	if (override !== undefined) return override;
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
		.replace(/(\d)\s+/g, "$1 ")
		.trim()
		.split(" ")
		.map((word) => (/^\d/.test(word) ? word : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(" ");
}

export interface CatalogEntry extends EffortMenu {
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

/** 把菜单字段从能力表搬到目录条目上，没有菜单就不留空字段。 */
function menuOf(caps: Capability): EffortMenu {
	if (!Array.isArray(caps.efforts) || caps.efforts.length === 0) return {};
	return {
		efforts: [...caps.efforts],
		effortDefault: caps.effortDefault,
		effortPatch: caps.effortPatch,
		effortOffPatch: caps.effortOffPatch,
	};
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
		const menu = menuOf(caps);
		entries.push({
			id: base,
			name: displayModelName(base),
			wire: wireFor(base),
			vision: caps.vision === true,
			reasoning: caps.reasoning !== false,
			contextWindow: caps.contextWindow,
			maxOutput: caps.maxOutput,
			canDisableThinking: menu.efforts === undefined ? caps.canDisableThinking !== false : menu.efforts.includes("disabled"),
			regionSensitive: isRegionSensitive(base),
			...menu,
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

/**
 * Kilo 执行 OpenRouter 统一的 `reasoning` 对象：`effort` 选档，
 * `enabled: false` 关掉思考。实测 `reasoning_tokens` 从 off 的 0 到
 * low/medium 的数百，所以这里的档位是真的控制项，不是换了名字的 token 阶梯。
 */
const KILO_EFFORT_PATCH = { reasoning: { effort: "$effort" } };
const KILO_EFFORT_OFF_PATCH = { reasoning: { enabled: false } };

/** 思考关不掉的家族：会直接 400。 */
const KILO_REASONING_MANDATORY = [/^stepfun\//, /^liquid\//, /^thinkingmachines\//];

/** 接受参数但仍会思考的自动路由。 */
const KILO_NO_DISABLE_IDS = new Set(["kilo-auto/free", "openrouter/free"]);

/** 这一行的思考菜单；`supported_parameters` 里没有 reasoning 就返回空。 */
function kiloEffortMenuFor(row: any): EffortMenu & { canDisableThinking?: boolean } {
	const params: string[] = Array.isArray(row?.supported_parameters) ? row.supported_parameters : [];
	if (!params.includes("reasoning")) return {};
	const id = String(row?.id ?? "");
	const canDisable = !KILO_REASONING_MANDATORY.some((pattern) => pattern.test(id)) && !KILO_NO_DISABLE_IDS.has(id);
	return {
		efforts: canDisable ? ["disabled", "low", "medium", "high"] : ["low", "medium", "high"],
		effortDefault: "high",
		effortPatch: KILO_EFFORT_PATCH,
		...(canDisable ? { effortOffPatch: KILO_EFFORT_OFF_PATCH } : {}),
		canDisableThinking: canDisable,
	};
}

/**
 * picker 里的名字：去掉厂商前缀与 `(free)` 限定词，再加通道前缀。
 * `NVIDIA: Nemotron 3 Ultra (free)` → `Kilo Nemotron 3 Ultra`。
 */
export function kiloDisplayName(id: string, upstreamName?: string): string {
	const raw = typeof upstreamName === "string" ? upstreamName.trim() : "";
	if (raw !== "") {
		const bare = raw
			.replace(/^[^:]{1,40}:\s+/, "")
			.replace(/\s*\(free\)\s*$/i, "")
			.trim();
		return `Kilo ${bare !== "" ? bare : raw}`;
	}
	// 没有展示名时才从 id 推。只按 `-`/`_` 切，保住 `3.5` 这类版本号。
	const pretty = (id.split("/").pop() ?? id)
		.replace(/:free$/i, "")
		.replace(/[-_]+/g, " ")
		.trim()
		.split(" ")
		.map((word) => (/^\d/.test(word) ? word : word.toUpperCase() === word ? word.toUpperCase() : word.charAt(0).toUpperCase() + word.slice(1)))
		.join(" ");
	return `Kilo ${pretty}`;
}

export interface KiloEntry extends EffortMenu {
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
		const menu = kiloEffortMenuFor(row);
		out.push({
			id,
			name: kiloDisplayName(id, row.name),
			contextWindow: Number(row.context_length) || Number(row.top_provider?.context_length) || 131072,
			maxOutput: Number(row.top_provider?.max_completion_tokens) || 32768,
			vision: modalities.includes("image"),
			// 免费池没有逐模型公布推理开关；listing 的 supported_parameters 是唯一信号。
			reasoning: true,
			canDisableThinking: menu.canDisableThinking === true,
			...(menu.efforts === undefined ? {} : {
				efforts: menu.efforts,
				effortDefault: menu.effortDefault,
				effortPatch: menu.effortPatch,
				effortOffPatch: menu.effortOffPatch,
			}),
		});
	}
	return out;
}
