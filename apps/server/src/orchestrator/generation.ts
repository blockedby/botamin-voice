export interface ActiveGeneration {
	generationId: string;
	turnId: string;
	signal: AbortSignal;
}

interface MutableGeneration {
	generationId: string;
	turnId: string;
	controller: AbortController;
	nextAudioSeq: number;
}

export interface SupersededGeneration {
	generationId: string;
	turnId: string;
}

/** Coordinates brain and TTS streams and fences every late provider event. */
export class GenerationCoordinator {
	#active: MutableGeneration | null = null;
	#seen = new Set<string>();

	start(
		generationId: string,
		turnId: string,
	): {
		active: ActiveGeneration;
		superseded: SupersededGeneration | null;
	} {
		if (this.#seen.has(generationId)) {
			throw new Error(`Generation ${generationId} has already been used`);
		}
		this.#seen.add(generationId);
		while (this.#seen.size > 512) {
			const oldest = this.#seen.values().next().value;
			if (!oldest) break;
			this.#seen.delete(oldest);
		}
		const superseded = this.#active
			? {
					generationId: this.#active.generationId,
					turnId: this.#active.turnId,
				}
			: null;
		this.#active?.controller.abort("superseded");
		this.#active = {
			generationId,
			turnId,
			controller: new AbortController(),
			nextAudioSeq: 0,
		};
		return { active: this.snapshot(), superseded };
	}

	interrupt(generationId: string): SupersededGeneration | null {
		if (!this.#active || this.#active.generationId !== generationId)
			return null;
		const interrupted = {
			generationId: this.#active.generationId,
			turnId: this.#active.turnId,
		};
		this.#active.controller.abort("interrupted");
		this.#active = null;
		return interrupted;
	}

	accept(generationId: string, turnId?: string): boolean {
		return (
			this.#active?.generationId === generationId &&
			(turnId === undefined || this.#active.turnId === turnId) &&
			!this.#active.controller.signal.aborted
		);
	}

	signal(generationId: string): AbortSignal {
		if (this.accept(generationId) && this.#active) {
			return this.#active.controller.signal;
		}
		const controller = new AbortController();
		controller.abort("inactive generation");
		return controller.signal;
	}

	nextAudioSeq(generationId: string): number | null {
		if (!this.accept(generationId) || !this.#active) return null;
		const value = this.#active.nextAudioSeq;
		this.#active.nextAudioSeq += 1;
		return value;
	}

	finish(generationId: string): void {
		if (this.#active?.generationId === generationId) this.#active = null;
	}

	close(): void {
		this.#active?.controller.abort("conversation closed");
		this.#active = null;
		this.#seen.clear();
	}

	current(): SupersededGeneration | null {
		return this.#active
			? {
					generationId: this.#active.generationId,
					turnId: this.#active.turnId,
				}
			: null;
	}

	private snapshot(): ActiveGeneration {
		if (!this.#active) throw new Error("No active generation");
		return {
			generationId: this.#active.generationId,
			turnId: this.#active.turnId,
			signal: this.#active.controller.signal,
		};
	}
}
