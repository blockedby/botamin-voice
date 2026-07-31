import { describe, expect, test } from "bun:test";
import type { SttTranscriptionResult } from "@botamin/contracts";
import { AtomicSttTurnGate } from "./reliability";

const conversationId = "01J00000000000000000000000";
const turn1 = "01J00000000000000000000010";
const turn2 = "01J00000000000000000000011";

function final(turnId: string): SttTranscriptionResult {
	return { conversationId, turnId, text: "Финальная реплика", final: true };
}

describe("atomic STT turn gate", () => {
	test("accepts one commit and exactly one matching final", () => {
		const gate = new AtomicSttTurnGate();
		const accepted = gate.acceptCommit(turn1);
		expect(accepted.ok).toBe(true);
		if (!accepted.ok) return;
		expect(gate.acceptFinal(accepted.turn, final(turn1))).toBe(true);
		expect(gate.acceptFinal(accepted.turn, final(turn1))).toBe(false);
		expect(gate.acceptCommit(turn1)).toEqual({
			ok: false,
			reason: "duplicate",
		});
		expect(gate.acceptedCommits).toBe(1);
	});

	test("a newer commit aborts and fences the stale result", () => {
		const gate = new AtomicSttTurnGate();
		const first = gate.acceptCommit(turn1);
		const second = gate.acceptCommit(turn2);
		expect(first.ok).toBe(true);
		expect(second).toMatchObject({ ok: true, supersededTurnId: turn1 });
		if (!first.ok || !second.ok) return;
		expect(first.turn.signal.aborted).toBe(true);
		expect(gate.acceptFinal(first.turn, final(turn1))).toBe(false);
		expect(gate.acceptFinal(second.turn, final(turn2))).toBe(true);
	});

	test("abort and close suppress every late final", () => {
		const gate = new AtomicSttTurnGate();
		const accepted = gate.acceptCommit(turn1);
		if (!accepted.ok) return;
		gate.close();
		expect(accepted.turn.signal.aborted).toBe(true);
		expect(gate.acceptFinal(accepted.turn, final(turn1))).toBe(false);
		expect(gate.acceptCommit(turn2)).toEqual({ ok: false, reason: "closed" });
	});
});
