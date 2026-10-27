/**
 * 推理强度策略。移植自 dsh-our-free-model 的 src/effort.js（2026-10 版）。
 *
 * 两个时代叠在一起，因为网关的行为变了两次：
 *
 * 1. 2026-09-24 的实测：网关接受 `reasoning_effort` / `thinking.budget_tokens`
 *    后全部忽略，唯一被执行的只有 `max_tokens`。没有思考菜单的模型仍然走
 *    这一套：档位 = 真实生成预算，关不掉思考的模型整条阶梯翻倍。
 * 2. 2026-10-17 的复测：网关开始**校验并执行** `reasoning_effort`（集合外的
 *    值回 400 `invalid_value`），档位真实改变思考量。声明了 `efforts` 菜单的
 *    模型走这一套：档位作为 `effortPatch` 打到请求体上，预算直接用模型容量。
 *
 * @module effort
 */
import type { ThinkingLevel } from "@earendil-works/pi-ai";

/** 低于此值答案本身无法落地，任何档位都不许再低。 */
const MIN_BUDGET = 512;

/** 关不掉思考的模型，整条阶梯按此系数放宽。 */
const ALWAYS_THINKING_FACTOR = 2;

/**
 * 档位绑定到 Pi 的思考等级。dsh 的 Light/Balanced/Deep 三档在这里展开成 Pi
 * 的六档，保持同一套语义：minimal/low = 精简，medium/high = 均衡（默认），
 * xhigh/max = 深思（模型全部输出能力）。
 */
const LADDER: Partial<Record<ThinkingLevel, number>> = {
	minimal: 2048,
	low: 2048,
	medium: 8192,
	high: 8192,
	// xhigh / max 不在表里：它们继承模型容量，这就是"深思"是顶端那一行的原因。
};

export const DEFAULT_LEVEL: ThinkingLevel = "medium";

/** 一次请求真正要发出的预算。 */
export function budgetFor(
	level: ThinkingLevel | undefined,
	maxOutput: number,
	canDisableThinking: boolean,
	requested?: number,
	hasEffortMenu = false,
): number {
	const modelCapacity = Math.trunc(maxOutput > 0 ? maxOutput : 32768);
	const capacity = Math.max(MIN_BUDGET, Math.min(modelCapacity, usableTokens(requested)));
	// 声明了菜单的模型，档位才是线上的控制项；阶梯会替它砍掉本可用的答案空间。
	if (hasEffortMenu) return capacity;
	const rung = LADDER[level ?? DEFAULT_LEVEL];
	if (rung === undefined) return capacity;
	const ceiling = canDisableThinking ? rung : rung * ALWAYS_THINKING_FACTOR;
	return Math.max(MIN_BUDGET, Math.min(ceiling, capacity));
}

/** 调用方给的 token 上限；不是正数就当没给。 */
function usableTokens(value: number | undefined): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : Number.POSITIVE_INFINITY;
}

/** 整条阶梯套在某个模型上时的样子，给需要告诉用户真实数字的地方用。 */
export function budgetLadder(maxOutput: number, canDisableThinking: boolean, requested?: number): Array<{ level: ThinkingLevel; tokens: number }> {
	return (["minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]).map((level) => ({
		level,
		tokens: budgetFor(level, maxOutput, canDisableThinking, requested),
	}));
}

/** 归一化上游或 harness 传来的任意强度拼写。 */
export function normalizeLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "light") return "low";
	if (lower === "balanced") return "medium";
	if (lower === "deep") return "max";
	if (lower === "off" || lower === "none" || lower === "disabled") return "minimal";
	const known: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
	return (known as string[]).includes(lower) ? (lower as ThinkingLevel) : undefined;
}

/** 目录条目里声明思考菜单的那部分。 */
export interface EffortCapable {
	efforts?: string[];
	effortDefault?: string;
	effortPatch?: Record<string, unknown>;
	effortOffPatch?: Record<string, unknown>;
}

/** 这个模型声明了自己的思考菜单吗？ */
export function hasEffortMenu(entry: EffortCapable | undefined): entry is EffortCapable & { efforts: string[] } {
	return Array.isArray(entry?.efforts) && entry.efforts.length > 0;
}

/**
 * Pi 的等级落到模型自己的菜单上。菜单外的值会被上游 400 拒掉，所以只能
 * 取声明集合里最近的档位；`off` 优先匹配模型的 `disabled` 档。
 */
const PREFERRED: Record<string, string[]> = {
	off: ["disabled", "low", "minimal", "medium"],
	minimal: ["minimal", "low", "disabled", "medium"],
	low: ["low", "minimal", "medium", "high"],
	medium: ["medium", "high", "low", "max"],
	high: ["high", "medium", "max", "xhigh"],
	xhigh: ["xhigh", "max", "high"],
	max: ["max", "xhigh", "high"],
};

function menuKey(level: unknown): string {
	if (typeof level !== "string") return DEFAULT_LEVEL;
	const lower = level.trim().toLowerCase();
	if (lower === "off" || lower === "none" || lower === "disabled") return "off";
	if (lower === "light") return "low";
	if (lower === "balanced") return "medium";
	if (lower === "deep") return "max";
	return lower;
}

function instantiate(patch: Record<string, unknown>, effort: string): Record<string, unknown> {
	const walk = (value: unknown): unknown => {
		if (typeof value === "string") return value === "$effort" ? effort : value;
		if (Array.isArray(value)) return value.map(walk);
		if (value !== null && typeof value === "object") {
			const out: Record<string, unknown> = {};
			for (const [key, inner] of Object.entries(value as Record<string, unknown>)) out[key] = walk(inner);
			return out;
		}
		return value;
	};
	return walk(patch) as Record<string, unknown>;
}

/**
 * 选中档位要打到请求体上的补丁，没有菜单时返回 undefined。
 *
 * `disabled` 用 `effortOffPatch`（例如 `{reasoning_effort:"none"}`），
 * 其余档位把 `$effort` 替换成菜单里的名字。
 */
export function effortPatchFor(entry: EffortCapable | undefined, level: unknown): Record<string, unknown> | undefined {
	if (!hasEffortMenu(entry)) return undefined;
	const declaredDefault = typeof entry.effortDefault === "string" && entry.efforts.includes(entry.effortDefault)
		? entry.effortDefault
		: entry.efforts[0];
	// Pi 把 off 折成 undefined 再交给 provider，所以 undefined 只能读作"没选"，
	// 落到模型自己声明的默认档。
	const chosen = typeof level === "string"
		? (PREFERRED[menuKey(level)] ?? PREFERRED[DEFAULT_LEVEL]).find((name) => entry.efforts.includes(name)) ?? declaredDefault
		: declaredDefault;
	if (chosen === undefined) return undefined;
	const patch = chosen === "disabled" ? entry.effortOffPatch ?? entry.effortPatch : entry.effortPatch;
	if (patch === undefined) return undefined;
	return instantiate(patch, chosen === "disabled" ? "none" : chosen);
}

/**
 * Pi 用 `thinkingLevelMap` 决定 `/thinking` 里哪些档位可选。没有这张表时
 * xhigh / max 会被 clamp 到 high，"深思" 永远走不到。
 *
 * 有菜单的模型把每一档映到最近的声明值；没菜单的模型保留完整六档，
 * 预算阶梯本来就用到了容量档。
 */
export function thinkingLevelMapFor(entry: EffortCapable | undefined): Record<string, string | null> {
	if (!hasEffortMenu(entry)) {
		return { off: "minimal", minimal: "minimal", low: "low", medium: "medium", high: "high", xhigh: "max", max: "max" };
	}
	const map: Record<string, string | null> = {};
	for (const pi of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
		const wants = PREFERRED[menuKey(pi)] ?? PREFERRED[DEFAULT_LEVEL];
		const chosen = wants.find((name) => entry.efforts.includes(name))
			?? (typeof entry.effortDefault === "string" && entry.efforts.includes(entry.effortDefault) ? entry.effortDefault : entry.efforts[0]);
		map[pi] = chosen === "disabled" ? "none" : chosen ?? null;
	}
	// 菜单里没有 Off 的模型不要在 picker 里承诺一个它不执行的关档。
	if (!entry.efforts.includes("disabled")) map.off = null;
	return map;
}
