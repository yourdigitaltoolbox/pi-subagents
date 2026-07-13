import { createJiti } from "jiti";
import { getContextLifecycleSnapshotV1 } from "@yourdigitaltoolbox/pi-context-lifecycle";

const requireTypeScript = createJiti(import.meta.url, { interopDefault: false });
const { LifecycleGate, PI_SUBAGENTS_LIFECYCLE_CONSUMER_ID } = requireTypeScript("./src/runs/background/lifecycle-gate.ts");

const CONSUMER = "pi-subagents";

function frozenReceipt(id, outcome, snapshot, notificationCount) {
	return Object.freeze({
		consumer: CONSUMER,
		id,
		outcome,
		...(snapshot.operationId === undefined ? {} : { operationId: snapshot.operationId }),
		...(snapshot.generationId === undefined ? {} : { generationId: snapshot.generationId }),
		...(notificationCount === undefined ? {} : { notificationCount }),
	});
}

function validInjection(input) {
	return input
		&& typeof input === "object"
		&& input.consumer === CONSUMER
		&& input.kind === "completion"
		&& typeof input.id === "string"
		&& input.id.length > 0
		&& (input.outcome === "success" || input.outcome === "failure");
}

/**
 * Archive-only test bridge for exact lifecycle candidates. It feeds the same
 * LifecycleGate adapter used by completion notifications, and emits through
 * AgentSession's public custom-message API. The probe deliberately has no
 * coordinator controls or payload-bearing observations.
 */
export function createExactCandidateProbe(options) {
	if (!options || typeof options !== "object" || !options.session || typeof options.session.sendCustomMessage !== "function") {
		throw new TypeError("createExactCandidateProbe requires an AgentSession with sendCustomMessage");
	}
	if (typeof options.session.sessionId !== "string" || options.session.sessionId.length === 0) {
		throw new TypeError("createExactCandidateProbe requires an AgentSession with a sessionId");
	}
	if ((typeof options.seed !== "string" || options.seed.length === 0) && (typeof options.seed !== "number" || !Number.isSafeInteger(options.seed))) {
		throw new TypeError("createExactCandidateProbe requires a string or safe-integer seed");
	}
	if (typeof options.packageDirectory !== "string" || options.packageDirectory.length === 0) {
		throw new TypeError("createExactCandidateProbe requires packageDirectory");
	}

	const receipts = [];
	const pendingDeliveries = new Set();
	let disposed = false;
	let injectionInFlight = false;

	const record = (receipt) => {
		receipts.push(receipt);
		return receipt;
	};
	const deliver = (batch) => {
		const outcome = injectionInFlight ? "accepted" : "released";
		const count = batch.items.length + batch.overflowCount;
		for (const completion of batch.items) {
			const snapshot = gateSnapshot();
			const delivery = Promise.resolve(options.session.sendCustomMessage({
				customType: "subagent-exact-candidate",
				content: "Subagent completion notification",
				display: false,
			}, { triggerTurn: false })).then(
				() => record(frozenReceipt(completion.id, outcome, snapshot, count)),
				() => record(frozenReceipt(completion.id, "rejected", snapshot, 0)),
			);
			pendingDeliveries.add(delivery);
			void delivery.finally(() => pendingDeliveries.delete(delivery));
		}
	};
	const gateSnapshot = () => authoritySnapshot();
	const authoritySnapshot = () => {
		// LifecycleGate owns admission, registration, holding, and release. This
		// probe only reads its public authority snapshot for redacted receipts.
		return getContextLifecycleSnapshotV1();
	};
	const successGate = new LifecycleGate({
		laneId: "subagent-success",
		mode: "managed",
		consumerId: PI_SUBAGENTS_LIFECYCLE_CONSUMER_ID,
		getSessionId: () => options.session.sessionId,
		emit: deliver,
		source: "pi-subagents-exact-candidate",
	});
	const failureGate = new LifecycleGate({
		laneId: "failure-attention-decision",
		mode: "managed",
		consumerId: PI_SUBAGENTS_LIFECYCLE_CONSUMER_ID,
		getSessionId: () => options.session.sessionId,
		emit: deliver,
		source: "pi-subagents-exact-candidate",
	});

	const settleDeliveries = async () => {
		while (pendingDeliveries.size > 0) await Promise.all([...pendingDeliveries]);
	};
	const inject = async (input) => {
		if (disposed) throw new Error("exact candidate probe is disposed");
		if (!validInjection(input)) throw new TypeError("pi-subagents exact candidate probe accepts completion injections only");
		const gate = input.outcome === "success" ? successGate : failureGate;
		injectionInFlight = true;
		let disposition;
		try {
			disposition = gate.receive(input.id, Object.freeze({ id: input.id, outcome: input.outcome }));
		} finally {
			injectionInFlight = false;
		}
		if (disposition === "held") return record(frozenReceipt(input.id, "held", authoritySnapshot(), 0));
		if (disposition === "blocked") return record(frozenReceipt(input.id, "rejected", authoritySnapshot(), 0));
		await settleDeliveries();
		return receipts.at(-1);
	};

	return Object.freeze({
		consumer: CONSUMER,
		inject,
		async observations() {
			await settleDeliveries();
			return Object.freeze([...receipts]);
		},
		async dispose() {
			if (disposed) return;
			disposed = true;
			successGate.dispose();
			failureGate.dispose();
			await settleDeliveries();
		},
	});
}
