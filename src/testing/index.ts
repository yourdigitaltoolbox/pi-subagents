import type { AgentSession } from "@earendil-works/pi-coding-agent";

export type ExactCandidateProbeInjection = Readonly<{
	consumer: "pi-subagents";
	kind: "completion";
	id: string;
	outcome: "success" | "failure";
}>;

export interface ExactCandidateProbeReceipt {
	consumer: "pi-subagents";
	id: string;
	outcome: "accepted" | "held" | "released" | "rejected";
	/** Present only for held and released receipts from the actual lifecycle gate lane. */
	laneId?: "failure-attention-decision" | "subagent-success";
	/** Monotonic per-probe sequence allocated synchronously at completion-batch dispatch. */
	dispatchSequence?: number;
	operationId?: string;
	generationId?: string;
	notificationCount?: number;
}

export interface ExactCandidateProbeOptions {
	/** The documented public Pi session API used for notification delivery. */
	session: AgentSession;
	seed: string | number;
	packageDirectory: string;
}

export interface ExactCandidateProbe {
	readonly consumer: "pi-subagents";
	inject(input: ExactCandidateProbeInjection): Promise<Readonly<ExactCandidateProbeReceipt>>;
	observations(): Promise<readonly Readonly<ExactCandidateProbeReceipt>[]>;
	dispose(): Promise<void>;
}

/**
 * Create an archive-included bridge to pi-subagents' real completion admission
 * adapter. The runtime implementation is exported from `pi-subagents/testing`.
 */
export declare function createExactCandidateProbe(options: ExactCandidateProbeOptions): ExactCandidateProbe;
