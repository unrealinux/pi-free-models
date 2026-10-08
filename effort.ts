/**
 * 推理强度策略。移植自 dsh-our-free-model 的 src/effort.js。
 *
 * 对这条通道的实测（2026-09-24）定下了设计：网关接受 `reasoning_effort`、
 * `thinking.budget_tokens`、`enable_thinking`、`thinking_budget` 然后全部忽略
 * —— 每个拼写各采三次，`low` 产生的思考 token 反而比 `xhigh` 更多，未知字段
 * 偶尔还会以 503 冒出来。池化账号真正执行的唯一控制量是 `max_tokens`，而思考
 * 量直接跟随它（64 token 的天花板把思考从约 397 token 压到约 63）。
 *
 * 所以这里的强度档位是真实且被执行的生成预算，不是提示词。
 * 因为天花板由思考和可见答案共用，低档会同时缩短两者 —— 这是这条通道唯一提供的
 * 调节手段，也是档位以 token 预算而非含糊形容词陈述的原因。
 *
 * 关不掉思考的模型必须先用同一个天花板支付思考，答案才开始，所以它的整条阶梯
 * 翻倍：这样每档留给答案的空间才和能关思考的模型大致相同。
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

/**
 * 解析一轮调用实际生效的生成上限。
 *
 * 档位天花板是控制项；模型自身容量只能把它压得更低，不能抬高。
 * 没有天花板的档位继承模型容量。
 *
 * @param level   harness 选择的推理强度，可能为 undefined
 * @param maxOutput 模型公布的输出上限
 * @param canDisableThinking 该模型能否关掉思考
 * @returns 将发往上游的 max_tokens
 */
export function budgetFor(level: ThinkingLevel | undefined, maxOutput: number, canDisableThinking: boolean): number {
	const capacity = Math.max(MIN_BUDGET, Math.trunc(maxOutput > 0 ? maxOutput : 32768));
	const rung = LADDER[level ?? DEFAULT_LEVEL];
	if (rung === undefined) return capacity;
	const ceiling = canDisableThinking ? rung : rung * ALWAYS_THINKING_FACTOR;
	return Math.max(MIN_BUDGET, Math.min(ceiling, capacity));
}

/** 整条阶梯套在某个模型上时的样子，给需要告诉用户真实数字的地方用。 */
export function budgetLadder(maxOutput: number, canDisableThinking: boolean): Array<{ level: ThinkingLevel; tokens: number }> {
	return (["minimal", "low", "medium", "high", "xhigh", "max"] as ThinkingLevel[]).map((level) => ({
		level,
		tokens: budgetFor(level, maxOutput, canDisableThinking),
	}));
}

/** 归一化上游或 harness 传来的任意强度拼写。 */
export function normalizeLevel(value: unknown): ThinkingLevel | undefined {
	if (typeof value !== "string") return undefined;
	const lower = value.trim().toLowerCase();
	if (lower === "light") return "low";
	if (lower === "balanced") return "medium";
	if (lower === "deep") return "max";
	const known: ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];
	return (known as string[]).includes(lower) ? (lower as ThinkingLevel) : undefined;
}
