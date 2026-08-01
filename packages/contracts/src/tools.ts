import { z } from "zod";
import { EntityIdSchema, Rfc3339UtcSchema } from "./common";
import {
	BookingContactsSchema,
	BookingSnapshotSchema,
	ConversationStageSchema,
	MeetingSlotSchema,
	QualificationPatchSchema,
} from "./domain";

export const IdempotencyKeySchema = z.string().min(10).max(128);

export const CreateBookingInputSchema = z
	.object({
		conversationId: EntityIdSchema,
		idempotencyKey: IdempotencyKeySchema,
		name: z.string().trim().min(1).max(120),
		contacts: BookingContactsSchema,
		company: z.string().trim().min(1).max(200),
		meetingSlot: MeetingSlotSchema,
		consentConfirmed: z.literal(true),
	})
	.strict();

export const CreateBookingResultSchema = z
	.object({
		ok: z.literal(true),
		created: z.boolean(),
		bookingId: EntityIdSchema,
		status: z.literal("booked"),
		createdAt: Rfc3339UtcSchema,
	})
	.strict();

export const AppendQualificationInputSchema = z
	.object({
		bookingId: EntityIdSchema,
		idempotencyKey: IdempotencyKeySchema,
		patch: QualificationPatchSchema,
		completion: z.enum(["partial", "complete", "skipped"]).default("partial"),
	})
	.strict()
	.superRefine((input, context) => {
		if (
			input.completion !== "skipped" &&
			Object.keys(input.patch).length === 0
		) {
			context.addIssue({
				code: "custom",
				message: "Qualification patch must update at least one field",
				path: ["patch"],
			});
		}
	});

export const AppendQualificationResultSchema = z
	.object({
		ok: z.literal(true),
		bookingId: EntityIdSchema,
		qualificationStatus: z.enum(["partial", "complete", "skipped"]),
		updatedFields: z.array(z.string().min(1)).max(12),
		updatedAt: Rfc3339UtcSchema,
	})
	.strict();

export const BrainActionNameSchema = z.enum([
	"create_booking",
	"append_booking_qualification",
]);

export const BrainActionSchema = z.discriminatedUnion("type", [
	z.object({ type: z.literal("none") }).strict(),
	z
		.object({
			type: z.literal("create_booking"),
			payload: CreateBookingInputSchema,
		})
		.strict(),
	z
		.object({
			type: z.literal("append_booking_qualification"),
			payload: AppendQualificationInputSchema,
		})
		.strict(),
]);

export const BrainEnvelopeSchema = z
	.object({
		speech: z.string().max(10_000),
		nextStage: ConversationStageSchema,
		action: BrainActionSchema,
	})
	.strict();

export const ToolRequestSchema = z.discriminatedUnion("name", [
	z
		.object({
			name: z.literal("create_booking"),
			callId: z.string().min(1).max(128),
			args: CreateBookingInputSchema,
		})
		.strict(),
	z
		.object({
			name: z.literal("append_booking_qualification"),
			callId: z.string().min(1).max(128),
			args: AppendQualificationInputSchema,
		})
		.strict(),
]);

/**
 * Server-owned policy context for tool execution. This makes it impossible to
 * validate qualification without an already committed booking snapshot.
 */
export const BookingToolExecutionSchema = z
	.discriminatedUnion("type", [
		z
			.object({
				type: z.literal("create_booking"),
				stage: z.literal("COLLECT_BOOKING"),
				sessionConversationId: EntityIdSchema,
				currentBooking: BookingSnapshotSchema.nullable(),
				candidateMeetingSlots: z.tuple([MeetingSlotSchema, MeetingSlotSchema]),
				input: CreateBookingInputSchema,
			})
			.strict(),
		z
			.object({
				type: z.literal("append_booking_qualification"),
				stage: z.enum(["BOOKED", "POST_BOOKING_QUALIFICATION"]),
				sessionConversationId: EntityIdSchema,
				currentBooking: BookingSnapshotSchema,
				input: AppendQualificationInputSchema,
			})
			.strict(),
	])
	.superRefine((command, context) => {
		if (command.type === "create_booking") {
			const candidateStarts = command.candidateMeetingSlots.map(
				(slot) => slot.startAt,
			);
			if (new Set(candidateStarts).size !== 2) {
				context.addIssue({
					code: "custom",
					message: "Candidate meeting slots must be unique",
					path: ["candidateMeetingSlots"],
				});
			}
			if (
				!command.candidateMeetingSlots.some(
					(slot) =>
						slot.startAt === command.input.meetingSlot.startAt &&
						slot.endAt === command.input.meetingSlot.endAt &&
						slot.timeZone === command.input.meetingSlot.timeZone &&
						slot.durationMinutes === command.input.meetingSlot.durationMinutes,
				)
			) {
				context.addIssue({
					code: "custom",
					message: "Booking must use a supplied candidate meeting slot",
					path: ["input", "meetingSlot"],
				});
			}
			if (command.input.conversationId !== command.sessionConversationId) {
				context.addIssue({
					code: "custom",
					message: "Booking conversation does not match the server session",
					path: ["input", "conversationId"],
				});
			}
			if (
				command.currentBooking !== null &&
				command.currentBooking.conversationId !== command.sessionConversationId
			) {
				context.addIssue({
					code: "custom",
					message: "Current booking does not belong to the server session",
					path: ["currentBooking", "conversationId"],
				});
			}
		}
		if (
			command.type === "append_booking_qualification" &&
			(command.currentBooking.conversationId !==
				command.sessionConversationId ||
				command.input.bookingId !== command.currentBooking.id)
		) {
			context.addIssue({
				code: "custom",
				message: "Qualification must target the session's committed booking",
				path: ["input", "bookingId"],
			});
		}
	});

export type AppendQualificationInput = z.input<
	typeof AppendQualificationInputSchema
>;
export type AppendQualificationResult = z.infer<
	typeof AppendQualificationResultSchema
>;
export type BrainAction = z.infer<typeof BrainActionSchema>;
export type BrainActionName = z.infer<typeof BrainActionNameSchema>;
export type BrainEnvelope = z.infer<typeof BrainEnvelopeSchema>;
export type BookingToolExecution = z.infer<typeof BookingToolExecutionSchema>;
export type CreateBookingInput = z.infer<typeof CreateBookingInputSchema>;
export type CreateBookingResult = z.infer<typeof CreateBookingResultSchema>;
export type ToolRequest = z.infer<typeof ToolRequestSchema>;
