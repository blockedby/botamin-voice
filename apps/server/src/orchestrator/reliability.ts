import type { SttTranscriptionResult } from "@botamin/contracts";

export interface AcceptedSttTurn {
	turnId: string;
	signal: AbortSignal;
	sequence: number;
}

export type SttTurnAcceptance =
	| { ok: true; turn: AcceptedSttTurn; supersededTurnId?: string }
	| { ok: false; reason: "duplicate" | "closed" };

interface MutableSttTurn {
	turnId: string;
	controller: AbortController;
	sequence: number;
	finalAccepted: boolean;
}

/**
 * Owns audio.commit/final identity. A turnId can be committed once for the
 * session and can accept at most one current atomic final result.
 */
export class AtomicSttTurnGate {
	#acceptedTurnIds = new Set<string>();
	#active: MutableSttTurn | null = null;
	#sequence = 0;
	#closed = false;

	acceptCommit(turnId: string): SttTurnAcceptance {
		if (this.#closed) return { ok: false, reason: "closed" };
		if (this.#acceptedTurnIds.has(turnId)) {
			return { ok: false, reason: "duplicate" };
		}
		this.#acceptedTurnIds.add(turnId);
		const supersededTurnId = this.#active?.turnId;
		this.#active?.controller.abort("stale turn");
		this.#sequence += 1;
		this.#active = {
			turnId,
			controller: new AbortController(),
			sequence: this.#sequence,
			finalAccepted: false,
		};
		return {
			ok: true,
			turn: this.#snapshot(),
			...(supersededTurnId ? { supersededTurnId } : {}),
		};
	}

	acceptFinal(turn: AcceptedSttTurn, result: SttTranscriptionResult): boolean {
		if (
			this.#closed ||
			!this.#active ||
			this.#active.sequence !== turn.sequence ||
			this.#active.turnId !== turn.turnId ||
			this.#active.finalAccepted ||
			this.#active.controller.signal.aborted ||
			result.turnId !== turn.turnId ||
			result.final !== true ||
			result.text.trim().length === 0
		) {
			return false;
		}
		this.#active.finalAccepted = true;
		return true;
	}

	isCurrent(turn: AcceptedSttTurn): boolean {
		return Boolean(
			!this.#closed &&
				this.#active &&
				this.#active.sequence === turn.sequence &&
				this.#active.turnId === turn.turnId &&
				!this.#active.controller.signal.aborted,
		);
	}

	finish(turn: AcceptedSttTurn): void {
		if (
			this.#active?.sequence === turn.sequence &&
			this.#active.turnId === turn.turnId
		) {
			this.#active = null;
		}
	}

	abort(turnId?: string): void {
		if (!this.#active || (turnId && this.#active.turnId !== turnId)) return;
		this.#active.controller.abort("aborted");
		this.#active = null;
	}

	close(): void {
		this.#closed = true;
		this.abort();
	}

	get acceptedCommits(): number {
		return this.#acceptedTurnIds.size;
	}

	#snapshot(): AcceptedSttTurn {
		if (!this.#active) throw new Error("No active STT turn");
		return {
			turnId: this.#active.turnId,
			signal: this.#active.controller.signal,
			sequence: this.#active.sequence,
		};
	}
}
