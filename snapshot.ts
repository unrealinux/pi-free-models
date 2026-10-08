/**
 * 离线快照。
 *
 * 上游名单只能联网拿到，而 Pi 启动时默认 `allowNetwork: false`，
 * legacy 形式的 `refreshModels` 也不会自己落盘。所以名单必须自己留一份：
 * 不清空、重启后 picker 不是空的 —— 即项目里"远端目录保留一份快照以供离线启动"。
 *
 * 刻意不 import pi-ai，好让这条链路能脱离 Pi 进程直接自测。
 *
 * @module snapshot
 */
import { readFileSync, writeFileSync } from "node:fs";

export interface Snapshot {
	zen: unknown[];
	kilo: unknown[];
	verdicts: Record<string, unknown>;
	at?: number;
}

export function loadSnapshot(path: string): Snapshot | undefined {
	try {
		const saved = JSON.parse(readFileSync(path, "utf8"));
		return {
			zen: Array.isArray(saved.zen) ? saved.zen : [],
			kilo: Array.isArray(saved.kilo) ? saved.kilo : [],
			verdicts: saved.verdicts && typeof saved.verdicts === "object" ? saved.verdicts : {},
			at: saved.at,
		};
	} catch {
		// 没有快照就是第一次跑；这不是错误。
		return undefined;
	}
}

export function saveSnapshot(path: string, snapshot: Snapshot): void {
	try {
		writeFileSync(path, JSON.stringify({ ...snapshot, at: Date.now() }));
	} catch {
		// 只读环境下不影响本次会话。
	}
}
