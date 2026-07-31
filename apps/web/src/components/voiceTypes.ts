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
			questionNumber?: number;
			questionCount?: number;
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
