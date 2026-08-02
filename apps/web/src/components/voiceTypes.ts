import type { ConversationStage } from "@botamin/contracts";

type ActiveBookingMarker = { bookingOutcome?: "committed" };

export type VoiceUiState =
	| { kind: "idle" }
	| ({ kind: "connecting" } & ActiveBookingMarker)
	| ({ kind: "permission-denied" } & ActiveBookingMarker)
	| ({ kind: "listening" } & ActiveBookingMarker)
	| ({ kind: "processing" } & ActiveBookingMarker)
	| ({ kind: "thinking" } & ActiveBookingMarker)
	| ({ kind: "speaking" } & ActiveBookingMarker)
	| { kind: "booked" }
	| {
			kind: "qualification";
			bookingOutcome: "committed";
			questionNumber?: 1 | 2;
			questionCount?: 2;
	  }
	| {
			kind: "complete";
			bookingOutcome: "none";
	  }
	| {
			kind: "complete";
			bookingOutcome: "committed";
			qualificationStatus?: "complete" | "partial" | "skipped";
	  }
	| ({ kind: "audio-error" } & ActiveBookingMarker)
	| ({ kind: "disconnected" } & ActiveBookingMarker)
	| ({ kind: "reconnecting"; attempt?: number } & ActiveBookingMarker)
	| ({ kind: "error" } & ActiveBookingMarker);

export interface VoiceCaptureProgress {
	/** PCM16 bytes accepted by the capture budget for the current utterance. */
	acceptedPcmBytes: number;
	/** Sample-derived duration; wall-clock intervals are not the source of truth. */
	durationMs: number;
	maxUtteranceMs: number;
}

export interface FinalTranscriptEntry {
	id: string;
	speaker: "visitor" | "agent";
	/** Only committed user transcripts and visible assistant responses belong here. */
	text: string;
}

export interface VoiceConsent {
	voiceProcessing: boolean;
	contactProcessing: boolean;
}

export type TextSubmissionState =
	| { status: "idle" }
	| { status: "pending" }
	| { status: "accepted"; turnId: string }
	| { status: "rejected"; message: string };

export interface VoiceConversationProjection {
	/** Exact server-owned stage; null before session.ready. */
	conversationStage: ConversationStage | null;
	textInputAvailable: boolean;
	textSubmission: TextSubmissionState;
}
