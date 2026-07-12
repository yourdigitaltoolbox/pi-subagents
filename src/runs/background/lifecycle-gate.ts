import {
	admitWake,
	getContextLifecycleSnapshotV1,
	observeContextLifecycleV1,
	registerContextLifecycleDrainerV1,
	type DrainAck,
	type LifecycleEvent,
	type LifecycleLane,
	type ReleasePermit,
	type Snapshot,
} from "@yourdigitaltoolbox/pi-context-lifecycle";

export const MAX_HELD_COMPLETION_KEYS = 256;
export const PI_SUBAGENTS_LIFECYCLE_CONSUMER_ID = "pi-subagents";

export type LifecycleGateMode = "managed" | "compatibility";
export type LifecycleGateDisposition = "delivered" | "held" | "blocked";

export function resolveLifecycleGateMode(configured: unknown, environmentValue = process.env.PI_SUBAGENTS_CONTEXT_LIFECYCLE_MODE): LifecycleGateMode {
	if (environmentValue === "compatibility" || configured === "compatibility") return "compatibility";
	return "managed";
}

interface HeldItem<T> {
	kind: "item";
	sequence: number;
	key: string;
	value: T;
}

interface HeldRollup {
	kind: "rollup";
	sequence: number;
	count: number;
	sealed: boolean;
}

type HeldRecord<T> = HeldItem<T> | HeldRollup;

export interface LifecycleGateAuthority {
	snapshot(): Snapshot;
	observe(listener: (event: LifecycleEvent) => void): { snapshot: Snapshot; unsubscribe(): void };
	admitWake: typeof admitWake;
	registerDrainer: typeof registerContextLifecycleDrainerV1;
}

const defaultAuthority: LifecycleGateAuthority = {
	snapshot: getContextLifecycleSnapshotV1,
	observe: observeContextLifecycleV1,
	admitWake,
	registerDrainer: registerContextLifecycleDrainerV1,
};

export interface LifecycleGateBatch<T> {
	items: readonly T[];
	overflowCount: number;
}

export interface LifecycleGateOptions<T> {
	laneId: LifecycleLane;
	mode: LifecycleGateMode;
	getSessionId(): string | null;
	emit(batch: LifecycleGateBatch<T>): void;
	onBlocked?(code: string): void;
	authority?: LifecycleGateAuthority;
	consumerId?: string;
	source?: string;
}

/**
 * Consumer-owned bounded queue for one lifecycle release lane. It stores domain
 * payloads locally and exposes only counts/watermarks to the coordinator.
 */
export class LifecycleGate<T> {
	private readonly authority: LifecycleGateAuthority;
	private readonly options: LifecycleGateOptions<T>;
	private readonly consumerId: string;
	private readonly heldByKey = new Map<string, HeldItem<T>>();
	private readonly rollups: HeldRollup[] = [];
	private nextSequence = 0;
	private registeredSessionId: string | undefined;
	private registeredGenerationId: string | undefined;
	private unregister: (() => void) | undefined;
	private unsubscribe: (() => void) | undefined;
	private disposed = false;

	constructor(options: LifecycleGateOptions<T>) {
		this.options = options;
		this.authority = options.authority ?? defaultAuthority;
		this.consumerId = options.consumerId ?? PI_SUBAGENTS_LIFECYCLE_CONSUMER_ID;
		const observed = this.authority.observe((event) => this.handleSnapshot(event));
		this.unsubscribe = observed.unsubscribe;
		this.handleSnapshot(observed.snapshot);
	}

	receive(key: string, value: T): LifecycleGateDisposition {
		return this.receiveBatch([{ key, value }]);
	}

	receiveBatch(entries: readonly { key: string; value: T }[]): LifecycleGateDisposition {
		if (entries.length === 0) return "delivered";
		if (this.disposed) return this.block("gate-disposed");
		const snapshot = this.authority.snapshot();
		const admission = this.admit(snapshot, `batch:${entries[0]!.key}`);
		if (admission === "deliver") {
			this.options.emit({ items: entries.map((entry) => entry.value), overflowCount: 0 });
			return "delivered";
		}
		for (const entry of entries) this.hold(entry.key, entry.value);
		if (admission === "hold") return "held";
		return this.block("lifecycle-authority-unavailable");
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		this.unsubscribe?.();
		this.unsubscribe = undefined;
		this.unregister?.();
		this.unregister = undefined;
		this.heldByKey.clear();
		this.rollups.splice(0);
	}

	private handleSnapshot(snapshot: Snapshot): void {
		if (this.disposed) return;
		this.ensureRegistration(snapshot);
		if (snapshot.registryState === "ready" && snapshot.phase === "idle") this.flushIdle(snapshot);
	}

	private ensureRegistration(snapshot: Snapshot): void {
		const sessionId = this.options.getSessionId();
		if (snapshot.registryState !== "ready" || !sessionId || snapshot.sessionId !== sessionId || !snapshot.generationId) {
			this.unregister?.();
			this.unregister = undefined;
			this.registeredSessionId = undefined;
			this.registeredGenerationId = undefined;
			return;
		}
		if (this.registeredSessionId === sessionId && this.registeredGenerationId === snapshot.generationId) return;
		this.unregister?.();
		try {
			this.unregister = this.authority.registerDrainer({
				consumerId: this.consumerId,
				laneId: this.options.laneId,
				generationId: snapshot.generationId,
				capture: () => this.capture(),
				drain: (permit) => this.drain(permit),
			});
			this.registeredSessionId = sessionId;
			this.registeredGenerationId = snapshot.generationId;
		} catch {
			this.unregister = undefined;
			this.registeredSessionId = undefined;
			this.registeredGenerationId = undefined;
			if (this.options.mode === "managed") this.options.onBlocked?.("lifecycle-drainer-registration-failed");
		}
	}

	private admit(snapshot: Snapshot, wakeId: string, permit?: ReleasePermit): "deliver" | "hold" | "blocked" {
		const sessionId = this.options.getSessionId();
		if (snapshot.registryState !== "ready" || !sessionId || snapshot.sessionId !== sessionId || !snapshot.generationId) {
			return this.options.mode === "compatibility" ? "deliver" : "blocked";
		}
		this.ensureRegistration(snapshot);
		if (this.options.mode === "managed" && this.registeredGenerationId !== snapshot.generationId) return "blocked";
		const result = this.authority.admitWake({
			consumerId: this.consumerId,
			laneId: this.options.laneId,
			wakeId,
			sessionId,
			generationId: snapshot.generationId,
			...(this.options.source ? { source: this.options.source } : {}),
		}, permit);
		if (result.disposition === "deliver") return "deliver";
		if (result.disposition === "hold") return "hold";
		return this.options.mode === "compatibility" ? "deliver" : "blocked";
	}

	private hold(key: string, value: T): void {
		if (this.heldByKey.has(key)) return;
		const sequence = ++this.nextSequence;
		if (this.heldByKey.size < MAX_HELD_COMPLETION_KEYS) {
			this.heldByKey.set(key, { kind: "item", key, sequence, value });
			return;
		}
		const latest = this.rollups.at(-1);
		if (latest && !latest.sealed) {
			latest.count += 1;
			return;
		}
		this.rollups.push({ kind: "rollup", sequence, count: 1, sealed: false });
	}

	private capture(): { watermark: number; heldCount: number } {
		const watermark = this.nextSequence;
		const latest = this.rollups.at(-1);
		if (latest && !latest.sealed) latest.sealed = true;
		return { watermark, heldCount: this.recordsAtOrBefore(watermark).length };
	}

	private drain(permit: ReleasePermit): DrainAck {
		const records = this.recordsAtOrBefore(permit.cut.watermark);
		if (records.length !== permit.cut.heldCount) return this.blockedAck(permit);
		if (records.length === 0) return this.ack(permit, "empty", 0, 0);
		if (this.admit(this.authority.snapshot(), `release:${permit.releaseId}`, permit) !== "deliver") return this.blockedAck(permit);
		try {
			this.options.emit({
				items: records.filter((record): record is HeldItem<T> => record.kind === "item").map((record) => record.value),
				overflowCount: records.filter((record): record is HeldRollup => record.kind === "rollup").reduce((count, record) => count + record.count, 0),
			});
		} catch {
			return this.blockedAck(permit);
		}
		for (const record of records) {
			if (record.kind === "item") this.heldByKey.delete(record.key);
			else {
				const index = this.rollups.indexOf(record);
				if (index >= 0) this.rollups.splice(index, 1);
			}
		}
		return this.ack(permit, "submitted", 1, records.length);
	}

	private flushIdle(snapshot: Snapshot): void {
		const records = this.recordsAtOrBefore(this.nextSequence);
		if (records.length === 0) return;
		if (this.admit(snapshot, `idle:${this.nextSequence}`) !== "deliver") return;
		this.options.emit({
			items: records.filter((record): record is HeldItem<T> => record.kind === "item").map((record) => record.value),
			overflowCount: records.filter((record): record is HeldRollup => record.kind === "rollup").reduce((count, record) => count + record.count, 0),
		});
		for (const record of records) {
			if (record.kind === "item") this.heldByKey.delete(record.key);
			else {
				const index = this.rollups.indexOf(record);
				if (index >= 0) this.rollups.splice(index, 1);
			}
		}
	}

	private recordsAtOrBefore(watermark: number): HeldRecord<T>[] {
		return [
			...[...this.heldByKey.values()].filter((record) => record.sequence <= watermark),
			...this.rollups.filter((record) => record.sequence <= watermark),
		].sort((left, right) => left.sequence - right.sequence);
	}

	private ack(permit: ReleasePermit, disposition: DrainAck["disposition"], submittedCount: number, handledCount: number): DrainAck {
		return {
			releaseId: permit.releaseId,
			consumerId: permit.consumerId,
			laneId: permit.laneId,
			disposition,
			submittedCount,
			handledCount,
			handledThrough: permit.cut.watermark,
		};
	}

	private blockedAck(permit: ReleasePermit): DrainAck {
		return this.ack(permit, "blocked", 0, 0);
	}

	private block(code: string): "blocked" {
		if (this.options.mode === "managed") this.options.onBlocked?.(code);
		return "blocked";
	}
}
