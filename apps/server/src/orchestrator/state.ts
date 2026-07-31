import type { BookingSnapshot, ConversationStage } from "@botamin/contracts";

export type QualificationConsent = "unknown" | "granted" | "declined";

export interface ConversationState {
	stage: ConversationStage;
	booking: BookingSnapshot | null;
	contactConsentConfirmed: boolean;
	qualificationEnabled: boolean;
	qualificationConsent: QualificationConsent;
	bookingConfirmationDelivered: boolean;
	/** Stage restored after a transport reconnect. */
	resumeStage: ConversationStage | null;
}

export type ConversationEvent =
	| { type: "start" }
	| { type: "connected" }
	| { type: "discovery_requested" }
	| { type: "value_ready" }
	| { type: "objection_raised" }
	| { type: "objection_resolved" }
	| { type: "booking_offered" }
	| { type: "booking_accepted" }
	| { type: "contact_consent_confirmed" }
	| { type: "booking_committed"; booking: BookingSnapshot }
	| { type: "booking_confirmation_delivered" }
	| { type: "qualification_consent_granted" }
	| { type: "qualification_consent_declined" }
	| { type: "qualification_updated"; booking: BookingSnapshot }
	| { type: "qualification_completed" }
	| { type: "complete" }
	| { type: "clear_refusal" }
	| { type: "disconnect" }
	| { type: "reconnect" }
	| { type: "provider_failed" };

export type ConversationEventType = ConversationEvent["type"];

export interface TransitionError {
	ok: false;
	code:
		| "INVALID_TRANSITION"
		| "BOOKING_REQUIRED"
		| "BOOKING_MISMATCH"
		| "CONSENT_REQUIRED"
		| "CONFIRMATION_REQUIRED"
		| "QUALIFICATION_DISABLED";
	message: string;
}

export type TransitionResult =
	| { ok: true; state: ConversationState }
	| TransitionError;

/** Static stage edges. Guarded lifecycle edges are handled below this table. */
export const TRANSITION_TABLE = [
	["IDLE", "start", "CONNECTING"],
	["CONNECTING", "connected", "GREETING"],
	["GREETING", "discovery_requested", "DISCOVERY"],
	["GREETING", "booking_offered", "BOOKING_OFFER"],
	["DISCOVERY", "value_ready", "VALUE"],
	["DISCOVERY", "booking_offered", "BOOKING_OFFER"],
	["VALUE", "objection_raised", "OBJECTION"],
	["VALUE", "booking_offered", "BOOKING_OFFER"],
	["OBJECTION", "objection_resolved", "VALUE"],
	["OBJECTION", "booking_offered", "BOOKING_OFFER"],
	["BOOKING_OFFER", "booking_accepted", "COLLECT_BOOKING"],
	["POST_BOOKING_QUALIFICATION", "qualification_completed", "COMPLETE"],
	["POST_BOOKING_QUALIFICATION", "complete", "COMPLETE"],
	["BOOKED", "complete", "COMPLETE"],
] as const satisfies ReadonlyArray<
	readonly [ConversationStage, ConversationEventType, ConversationStage]
>;

const TERMINAL_STAGES = new Set<ConversationStage>([
	"COMPLETE",
	"DECLINED",
	"ERROR",
]);
const DISCONNECTABLE_STAGES = new Set<ConversationStage>([
	"CONNECTING",
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
]);

function failure(
	code: TransitionError["code"],
	message: string,
): TransitionError {
	return { ok: false, code, message };
}

function withStage(
	state: ConversationState,
	stage: ConversationStage,
): TransitionResult {
	return { ok: true, state: { ...state, stage } };
}

export function createInitialConversationState(options?: {
	qualificationEnabled?: boolean;
}): ConversationState {
	return {
		stage: "IDLE",
		booking: null,
		contactConsentConfirmed: false,
		qualificationEnabled: options?.qualificationEnabled ?? true,
		qualificationConsent: "unknown",
		bookingConfirmationDelivered: false,
		resumeStage: null,
	};
}

/**
 * Pure server-owned conversation reducer. It never removes a committed booking.
 * Invalid model/user suggestions return an error instead of changing state.
 */
export function transition(
	state: ConversationState,
	event: ConversationEvent,
): TransitionResult {
	if (event.type === "disconnect") {
		if (!DISCONNECTABLE_STAGES.has(state.stage)) {
			return failure(
				"INVALID_TRANSITION",
				`disconnect is not allowed from ${state.stage}`,
			);
		}
		return {
			ok: true,
			state: { ...state, stage: "DISCONNECTED", resumeStage: state.stage },
		};
	}

	if (event.type === "reconnect") {
		if (state.stage !== "DISCONNECTED" || state.resumeStage === null) {
			return failure(
				"INVALID_TRANSITION",
				`reconnect is not allowed from ${state.stage}`,
			);
		}
		const restored =
			state.booking && state.resumeStage === "COLLECT_BOOKING"
				? "BOOKED"
				: state.resumeStage;
		return {
			ok: true,
			state: { ...state, stage: restored, resumeStage: null },
		};
	}

	if (event.type === "clear_refusal") {
		if (TERMINAL_STAGES.has(state.stage) || state.stage === "DISCONNECTED") {
			return failure(
				"INVALID_TRANSITION",
				`clear_refusal is not allowed from ${state.stage}`,
			);
		}
		return withStage(state, state.booking ? "COMPLETE" : "DECLINED");
	}

	if (event.type === "provider_failed") {
		if (TERMINAL_STAGES.has(state.stage)) {
			return failure(
				"INVALID_TRANSITION",
				`provider_failed is not allowed from ${state.stage}`,
			);
		}
		// Provider failure is observably terminal ERROR even when a previously
		// committed booking remains authoritative and untouched.
		return withStage(state, "ERROR");
	}

	if (event.type === "contact_consent_confirmed") {
		if (state.stage !== "COLLECT_BOOKING") {
			return failure(
				"INVALID_TRANSITION",
				`contact consent is not accepted in ${state.stage}`,
			);
		}
		return {
			ok: true,
			state: { ...state, contactConsentConfirmed: true },
		};
	}

	if (event.type === "booking_committed") {
		if (state.stage !== "COLLECT_BOOKING") {
			return failure(
				"INVALID_TRANSITION",
				`booking_committed is not allowed from ${state.stage}`,
			);
		}
		if (!state.contactConsentConfirmed) {
			return failure(
				"CONSENT_REQUIRED",
				"Contact consent is required before committing a booking",
			);
		}
		if (event.booking.status !== "booked") {
			return failure("BOOKING_REQUIRED", "Only a booked snapshot can commit");
		}
		if (state.booking !== null && state.booking.id !== event.booking.id) {
			return failure(
				"BOOKING_MISMATCH",
				"A conversation cannot replace its committed booking",
			);
		}
		return {
			ok: true,
			state: {
				...state,
				stage: "BOOKED",
				booking: event.booking,
				bookingConfirmationDelivered: false,
			},
		};
	}

	if (event.type === "booking_confirmation_delivered") {
		if (state.stage !== "BOOKED" || !state.booking) {
			return failure(
				"BOOKING_REQUIRED",
				"Booking confirmation requires a committed booking",
			);
		}
		return {
			ok: true,
			state: { ...state, bookingConfirmationDelivered: true },
		};
	}

	if (event.type === "qualification_consent_granted") {
		if (!state.qualificationEnabled) {
			return failure(
				"QUALIFICATION_DISABLED",
				"Post-booking qualification is disabled",
			);
		}
		if (state.stage !== "BOOKED" || !state.booking) {
			return failure(
				"BOOKING_REQUIRED",
				"Qualification requires a committed booking",
			);
		}
		if (!state.bookingConfirmationDelivered) {
			return failure(
				"CONFIRMATION_REQUIRED",
				"Booking must be confirmed before qualification consent",
			);
		}
		return {
			ok: true,
			state: {
				...state,
				stage: "POST_BOOKING_QUALIFICATION",
				qualificationConsent: "granted",
			},
		};
	}

	if (event.type === "qualification_updated") {
		if (
			state.stage !== "POST_BOOKING_QUALIFICATION" ||
			!state.booking ||
			event.booking.id !== state.booking.id ||
			event.booking.conversationId !== state.booking.conversationId
		) {
			return failure(
				"BOOKING_MISMATCH",
				"Qualification update must preserve the committed booking identity",
			);
		}
		return { ok: true, state: { ...state, booking: event.booking } };
	}

	if (event.type === "qualification_consent_declined") {
		if (state.stage !== "BOOKED" || !state.booking) {
			return failure(
				"BOOKING_REQUIRED",
				"Qualification decline requires a committed booking",
			);
		}
		if (!state.bookingConfirmationDelivered) {
			return failure(
				"CONFIRMATION_REQUIRED",
				"Booking must be confirmed before qualification refusal",
			);
		}
		return {
			ok: true,
			state: {
				...state,
				stage: "COMPLETE",
				qualificationConsent: "declined",
			},
		};
	}

	const edge = TRANSITION_TABLE.find(
		([from, type]) => from === state.stage && type === event.type,
	);
	if (edge) return withStage(state, edge[2]);

	return failure(
		"INVALID_TRANSITION",
		`${event.type} is not allowed from ${state.stage}`,
	);
}
