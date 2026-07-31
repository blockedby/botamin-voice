import type { ServerWsEvent } from "@botamin/contracts";

export type VoiceStatus =
	| "idle"
	| "connecting"
	| "listening"
	| "processing"
	| "speaking"
	| "error"
	| "stopped";

export interface FinalTranscript {
	turnId: string;
	text: string;
}

export interface VoiceState {
	status: VoiceStatus;
	transcript: FinalTranscript | null;
	assistantText: string;
	generationId: string | null;
	muted: boolean;
	audioError: string | null;
	fatalError: string | null;
}

export const initialVoiceState: VoiceState = {
	status: "idle",
	transcript: null,
	assistantText: "",
	generationId: null,
	muted: false,
	audioError: null,
	fatalError: null,
};

export type VoiceAction =
	| { type: "connecting" }
	| { type: "listening" }
	| { type: "processing" }
	| { type: "transcript.final"; transcript: FinalTranscript }
	| { type: "assistant.delta"; generationId: string; text: string }
	| { type: "assistant.done"; generationId: string; fullText: string }
	| { type: "speaking"; generationId: string }
	| { type: "playback.complete" }
	| { type: "interrupted" }
	| { type: "audio.error"; message: string }
	| { type: "fatal.error"; message: string }
	| { type: "mute"; muted: boolean }
	| { type: "stop" };

export function voiceReducer(
	state: VoiceState,
	action: VoiceAction,
): VoiceState {
	switch (action.type) {
		case "connecting":
			return { ...state, status: "connecting", fatalError: null };
		case "listening":
			return {
				...state,
				status: "listening",
				audioError: null,
				fatalError: null,
			};
		case "processing":
			return { ...state, status: "processing", fatalError: null };
		case "transcript.final":
			return {
				...state,
				status: "processing",
				transcript: action.transcript,
				fatalError: null,
			};
		case "assistant.delta":
			return {
				...state,
				status: "processing",
				generationId: action.generationId,
				assistantText:
					state.generationId === action.generationId
						? state.assistantText + action.text
						: action.text,
			};
		case "assistant.done":
			return {
				...state,
				generationId: action.generationId,
				assistantText: action.fullText,
			};
		case "speaking":
			return {
				...state,
				status: "speaking",
				generationId: action.generationId,
				audioError: null,
			};
		case "playback.complete":
		case "interrupted":
			return { ...state, status: "listening", generationId: null };
		case "audio.error":
			return {
				...state,
				status: state.status === "speaking" ? "processing" : state.status,
				audioError: action.message,
			};
		case "fatal.error":
			return { ...state, status: "error", fatalError: action.message };
		case "mute":
			return { ...state, muted: action.muted };
		case "stop":
			return { ...initialVoiceState, status: "stopped" };
	}
}

export interface BargeInEffects {
	/** Must synchronously stop the source and clear its queue. */
	stopLocalPlayback(): void;
	sendInterruption?(
		generationId: string,
		reason: "barge_in" | "user_stop" | "new_generation",
	): void;
}

/**
 * Final-only voice state coordinator. A commit transition happens only when
 * transport accepts it; one current transcript.final then closes that commit.
 */
export class VoiceSessionController {
	private awaitingFinal = false;
	private stopped = false;
	private readonly finalTurns = new Set<string>();
	private readonly staleGenerations = new Set<string>();

	constructor(
		public state: VoiceState = initialVoiceState,
		private readonly onState?: (state: VoiceState) => void,
	) {}

	setConnecting(): void {
		if (!this.stopped) this.apply({ type: "connecting" });
	}

	beginListening(): void {
		if (!this.stopped) this.apply({ type: "listening" });
	}

	/** Duplicate calls are suppressed even if a caller races the UI handler. */
	commit(sendCommit: () => boolean): boolean {
		if (
			this.stopped ||
			this.awaitingFinal ||
			this.state.status !== "listening"
		) {
			return false;
		}
		if (!sendCommit()) return false;
		this.awaitingFinal = true;
		this.apply({ type: "processing" });
		return true;
	}

	acceptEvent(event: ServerWsEvent): boolean {
		if (this.stopped) return false;
		switch (event.type) {
			case "session.ready":
				this.beginListening();
				return true;
			case "transcript.final":
				return this.acceptFinal(event.payload.turnId, event.payload.text);
			case "assistant.text.delta":
				if (!this.acceptGeneration(event.payload.generationId)) return false;
				this.apply({
					type: "assistant.delta",
					generationId: event.payload.generationId,
					text: event.payload.text,
				});
				return true;
			case "assistant.text.done":
				if (!this.acceptGeneration(event.payload.generationId)) return false;
				this.apply({
					type: "assistant.done",
					generationId: event.payload.generationId,
					fullText: event.payload.fullText,
				});
				return true;
			case "audio.segment":
				if (!this.acceptGeneration(event.payload.generationId)) return false;
				this.apply({
					type: "speaking",
					generationId: event.payload.generationId,
				});
				return true;
			case "assistant.interrupted":
				this.markGenerationStale(event.payload.generationId);
				if (this.state.generationId === event.payload.generationId) {
					this.apply({ type: "interrupted" });
				}
				return true;
			case "error":
				if (event.payload.code === "TTS_UNAVAILABLE") {
					this.setAudioError(event.payload.message);
				} else {
					this.apply({ type: "fatal.error", message: event.payload.message });
				}
				return true;
			default:
				return false;
		}
	}

	bargeIn(
		effects: BargeInEffects,
		reason: "barge_in" | "user_stop" | "new_generation" = "barge_in",
	): string | null {
		const generationId = this.state.generationId;
		// Local cancellation intentionally precedes any fallible network action.
		effects.stopLocalPlayback();
		if (generationId) {
			this.markGenerationStale(generationId);
			effects.sendInterruption?.(generationId, reason);
		}
		this.apply({ type: "interrupted" });
		return generationId;
	}

	completePlayback(generationId: string): boolean {
		if (this.state.generationId !== generationId) return false;
		this.markGenerationStale(generationId);
		this.apply({ type: "playback.complete" });
		return true;
	}

	setAudioError(message: string): void {
		this.apply({ type: "audio.error", message });
	}

	setMuted(muted: boolean): void {
		this.apply({ type: "mute", muted });
	}

	stop(cleanup: () => void): void {
		cleanup();
		if (this.state.generationId) {
			this.markGenerationStale(this.state.generationId);
		}
		this.awaitingFinal = false;
		this.stopped = true;
		this.apply({ type: "stop" });
	}

	get hasPendingCommit(): boolean {
		return this.awaitingFinal;
	}

	private acceptFinal(turnId: string, text: string): boolean {
		if (!this.awaitingFinal || this.finalTurns.has(turnId)) return false;
		this.awaitingFinal = false;
		rememberBounded(this.finalTurns, turnId);
		this.apply({
			type: "transcript.final",
			transcript: { turnId, text },
		});
		return true;
	}

	private acceptGeneration(generationId: string): boolean {
		if (this.staleGenerations.has(generationId)) return false;
		const current = this.state.generationId;
		if (current !== null && current !== generationId) return false;
		return true;
	}

	private markGenerationStale(generationId: string): void {
		rememberBounded(this.staleGenerations, generationId);
	}

	private apply(action: VoiceAction): void {
		this.state = voiceReducer(this.state, action);
		this.onState?.(this.state);
	}
}

function rememberBounded(values: Set<string>, value: string): void {
	values.add(value);
	if (values.size <= 256) return;
	const oldest = values.values().next().value;
	if (oldest !== undefined) values.delete(oldest);
}
