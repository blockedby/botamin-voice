import {
	type AppendQualificationResult,
	type BookingService,
	type BookingSnapshot,
	BookingToolExecutionSchema,
	type BrainActionName,
	type CreateBookingResult,
	type SafeErrorCode,
	type ToolRequest,
	ToolRequestSchema,
} from "@botamin/contracts";
import type { ConversationState } from "./state";

export function allowedActions(state: ConversationState): BrainActionName[] {
	if (
		state.stage === "COLLECT_BOOKING" &&
		state.booking === null &&
		state.contactConsentConfirmed
	) {
		return ["create_booking"];
	}
	if (
		state.stage === "POST_BOOKING_QUALIFICATION" &&
		state.booking?.status === "booked" &&
		state.bookingConfirmationDelivered &&
		state.qualificationEnabled &&
		state.qualificationConsent === "granted"
	) {
		return ["append_booking_qualification"];
	}
	return [];
}

export type ToolAuthorization =
	| { ok: true; request: ToolRequest }
	| {
			ok: false;
			code: SafeErrorCode;
			message: string;
	  };

/** Validates untrusted model output against server-owned session state. */
export function authorizeTool(
	state: ConversationState,
	conversationId: string,
	request: unknown,
): ToolAuthorization {
	const parsed = ToolRequestSchema.safeParse(request);
	if (!parsed.success) {
		return {
			ok: false,
			code: "BOOKING_VALIDATION_FAILED",
			message: "Tool arguments are invalid",
		};
	}
	if (!allowedActions(state).includes(parsed.data.name)) {
		return {
			ok: false,
			code: "ACTION_NOT_ALLOWED_IN_STATE",
			message: "Action is not allowed in the current state",
		};
	}
	const command =
		parsed.data.name === "create_booking"
			? {
					type: "create_booking" as const,
					stage: state.stage,
					sessionConversationId: conversationId,
					currentBooking: state.booking,
					input: parsed.data.args,
				}
			: {
					type: "append_booking_qualification" as const,
					stage: state.stage,
					sessionConversationId: conversationId,
					currentBooking: state.booking,
					input: parsed.data.args,
				};
	if (!BookingToolExecutionSchema.safeParse(command).success) {
		return {
			ok: false,
			code: "ACTION_NOT_ALLOWED_IN_STATE",
			message: "Tool request does not match the server session",
		};
	}
	return { ok: true, request: parsed.data };
}

export type SafeToolSuccess =
	| {
			name: "create_booking";
			callId: string;
			replayedCall: boolean;
			result: CreateBookingResult;
			booking: BookingSnapshot;
	  }
	| {
			name: "append_booking_qualification";
			callId: string;
			replayedCall: boolean;
			result: AppendQualificationResult;
			booking: BookingSnapshot;
	  };

export type SafeToolExecution =
	| { ok: true; value: SafeToolSuccess }
	| {
			ok: false;
			callId: string | null;
			code: SafeErrorCode;
			message: string;
	  };

interface StoredCall {
	canonicalRequest: string;
	result: SafeToolExecution;
}

function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(",")}]`;
	}
	if (value && typeof value === "object") {
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`)
			.join(",")}}`;
	}
	return JSON.stringify(value) ?? "null";
}

function providerFailure(error: unknown): SafeErrorCode {
	const code =
		error && typeof error === "object" && "code" in error
			? String(error.code)
			: "";
	if (code === "IDEMPOTENCY_CONFLICT") return "IDEMPOTENCY_CONFLICT";
	if (code === "BOOKING_VALIDATION_FAILED") {
		return "BOOKING_VALIDATION_FAILED";
	}
	return "DB_UNAVAILABLE";
}

/** Executes each model callId at most once and only returns safe contract data. */
export class BookingToolExecutor {
	#calls = new Map<string, StoredCall>();

	constructor(private readonly bookings: BookingService) {}

	clear(): void {
		this.#calls.clear();
	}

	async execute(
		state: ConversationState,
		conversationId: string,
		untrustedRequest: unknown,
	): Promise<SafeToolExecution> {
		const parsed = ToolRequestSchema.safeParse(untrustedRequest);
		const callId = parsed.success ? parsed.data.callId : null;
		const canonicalRequest = parsed.success
			? canonicalJson(parsed.data)
			: canonicalJson(untrustedRequest);
		if (callId) {
			const replay = this.#calls.get(callId);
			if (replay) {
				if (replay.canonicalRequest !== canonicalRequest) {
					return {
						ok: false,
						callId,
						code: "IDEMPOTENCY_CONFLICT",
						message: "The tool callId was reused with different arguments",
					};
				}
				if (replay.result.ok) {
					return {
						ok: true,
						value: { ...replay.result.value, replayedCall: true },
					};
				}
				return replay.result;
			}
		}

		const authorization = authorizeTool(
			state,
			conversationId,
			untrustedRequest,
		);
		if (!authorization.ok) {
			return {
				ok: false,
				callId,
				code: authorization.code,
				message: authorization.message,
			};
		}

		let execution: SafeToolExecution;
		try {
			if (authorization.request.name === "create_booking") {
				const result = await this.bookings.createBooking(
					authorization.request.args,
				);
				const booking =
					await this.bookings.findByConversationId(conversationId);
				if (
					!booking ||
					booking.id !== result.bookingId ||
					booking.conversationId !== conversationId ||
					booking.status !== "booked"
				) {
					execution = {
						ok: false,
						callId: authorization.request.callId,
						code: "DB_UNAVAILABLE",
						message: "Committed booking could not be verified",
					};
				} else {
					execution = {
						ok: true,
						value: {
							name: "create_booking",
							callId: authorization.request.callId,
							replayedCall: false,
							result,
							booking,
						},
					};
				}
			} else {
				const result = await this.bookings.appendQualification(
					authorization.request.args,
				);
				const booking =
					await this.bookings.findByConversationId(conversationId);
				if (!booking || booking.id !== result.bookingId) {
					execution = {
						ok: false,
						callId: authorization.request.callId,
						code: "DB_UNAVAILABLE",
						message: "Committed qualification could not be verified",
					};
				} else {
					execution = {
						ok: true,
						value: {
							name: "append_booking_qualification",
							callId: authorization.request.callId,
							replayedCall: false,
							result,
							booking,
						},
					};
				}
			}
		} catch (error) {
			// A notifier may fail after the booking transaction committed. Re-read
			// the durable record before reporting failure so speech never denies a
			// booking that already exists and qualification never races the commit.
			if (authorization.request.name === "create_booking") {
				const booking = await this.bookings
					.findByConversationId(conversationId)
					.catch(() => null);
				if (
					booking?.conversationId === conversationId &&
					booking.status === "booked"
				) {
					execution = {
						ok: true,
						value: {
							name: "create_booking",
							callId: authorization.request.callId,
							replayedCall: false,
							result: {
								ok: true,
								created: true,
								bookingId: booking.id,
								status: "booked",
								createdAt: booking.createdAt,
							},
							booking,
						},
					};
				} else {
					execution = {
						ok: false,
						callId: authorization.request.callId,
						code: providerFailure(error),
						message: "The booking operation could not be completed",
					};
				}
			} else {
				// The production SQLite service absorbs notifier errors in its outbox.
				// With only BookingService, a thrown qualification call has no durable
				// idempotency-result proof, so never infer success from a matching snapshot.
				execution = {
					ok: false,
					callId: authorization.request.callId,
					code: providerFailure(error),
					message: "The qualification operation could not be completed",
				};
			}
		}
		while (this.#calls.size >= 256) {
			const oldest = this.#calls.keys().next().value;
			if (!oldest) break;
			this.#calls.delete(oldest);
		}
		this.#calls.set(authorization.request.callId, {
			canonicalRequest,
			result: execution,
		});
		return execution;
	}
}
