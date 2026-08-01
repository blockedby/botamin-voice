import { z } from "zod";
import {
	ContractVersionSchema,
	EntityIdSchema,
	Rfc3339UtcSchema,
} from "./common";

export const ConversationStageSchema = z.enum([
	"IDLE",
	"CONNECTING",
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
	"COMPLETE",
	"DECLINED",
	"DISCONNECTED",
	"ERROR",
]);

export const ConversationStatusSchema = z.enum([
	"active",
	"completed",
	"failed",
	"disconnected",
]);

export const ContactSchema = z.discriminatedUnion("channel", [
	z
		.object({
			channel: z.literal("phone"),
			value: z.string().trim().min(5).max(64),
		})
		.strict(),
	z
		.object({
			channel: z.literal("email"),
			value: z.email().max(254),
		})
		.strict(),
	z
		.object({
			channel: z.literal("telegram"),
			value: z.string().trim().min(2).max(128),
		})
		.strict(),
]);

export const BookingContactsSchema = z
	.array(ContactSchema)
	.min(2)
	.max(3)
	.superRefine((contacts, context) => {
		const channels = contacts.map((contact) => contact.channel);
		if (!channels.includes("email")) {
			context.addIssue({
				code: "custom",
				message: "A working email is required",
			});
		}
		if (
			!channels.some((channel) => channel === "phone" || channel === "telegram")
		) {
			context.addIssue({
				code: "custom",
				message: "A phone or Telegram contact is required",
			});
		}
		if (new Set(channels).size !== channels.length) {
			context.addIssue({
				code: "custom",
				message: "Contact channels must be unique",
			});
		}
	});

export const MEETING_TIME_ZONE = "Europe/Moscow" as const;
export const MEETING_DURATION_MINUTES = 20 as const;

const CanonicalRfc3339UtcSchema = Rfc3339UtcSchema.refine(
	(value) => new Date(value).toISOString() === value,
	{ message: "Expected a canonical RFC3339 UTC instant" },
);

/**
 * One concrete internal Botamin meeting slot. Moscow business-time validation
 * uses the zone's current fixed UTC+03:00 offset without the host timezone or
 * locale. Candidate generation and service validation separately enforce that
 * the slot is after the injected clock and not on today's Moscow date.
 */
export const MeetingSlotSchema = z
	.object({
		startAt: CanonicalRfc3339UtcSchema,
		endAt: CanonicalRfc3339UtcSchema,
		timeZone: z.literal(MEETING_TIME_ZONE),
		durationMinutes: z.literal(MEETING_DURATION_MINUTES),
	})
	.strict()
	.superRefine((slot, context) => {
		const start = new Date(slot.startAt);
		const end = new Date(slot.endAt);
		if (end.getTime() - start.getTime() !== MEETING_DURATION_MINUTES * 60_000) {
			context.addIssue({
				code: "custom",
				message: "Meeting end must be exactly 20 minutes after start",
				path: ["endAt"],
			});
		}

		// Future Moscow slots are UTC+03:00. Shift before UTC field access so
		// validation is independent of the process timezone and locale.
		const moscow = new Date(start.getTime() + 3 * 60 * 60_000);
		const weekday = moscow.getUTCDay();
		const hour = moscow.getUTCHours();
		const minute = moscow.getUTCMinutes();
		const onGrid = minute % MEETING_DURATION_MINUTES === 0;
		const inHours = hour >= 9 && (hour < 17 || (hour === 17 && minute === 0));
		if (weekday === 0 || weekday === 6) {
			context.addIssue({
				code: "custom",
				message: "Meeting must be Monday through Friday in Moscow",
				path: ["startAt"],
			});
		}
		if (
			!onGrid ||
			!inHours ||
			moscow.getUTCSeconds() !== 0 ||
			moscow.getUTCMilliseconds() !== 0
		) {
			context.addIssue({
				code: "custom",
				message:
					"Meeting must start on the 20-minute grid from 09:00 through 17:00 Moscow",
				path: ["startAt"],
			});
		}
	});

export const QualificationStatusSchema = z.enum([
	"none",
	"partial",
	"complete",
	"skipped",
]);

export const QualificationPatchSchema = z
	.object({
		role: z.string().trim().min(1).max(200).optional(),
		industry: z.string().trim().min(1).max(200).optional(),
		companySize: z.string().trim().min(1).max(100).optional(),
		monthlyLeadVolume: z.string().trim().min(1).max(100).optional(),
		salesManagerCount: z.number().int().min(0).max(10_000).optional(),
		currentChannels: z
			.array(z.string().trim().min(1).max(80))
			.max(10)
			.optional(),
		crm: z.string().trim().min(1).max(120).optional(),
		currentProcess: z.string().trim().min(1).max(1000).optional(),
		pains: z.array(z.string().trim().min(1).max(300)).max(10).optional(),
		desiredUseCase: z.string().trim().min(1).max(500).optional(),
		timeline: z.string().trim().min(1).max(200).optional(),
		notes: z.string().trim().min(1).max(1500).optional(),
	})
	.strict();

export const KnownFactsSchema = z
	.object({
		company: z.string().max(200).optional(),
		role: z.string().max(200).optional(),
		useCases: z.array(z.string().max(300)).max(10).default([]),
		painPoints: z.array(z.string().max(300)).max(10).default([]),
		objections: z.array(z.string().max(300)).max(10).default([]),
	})
	.strict();

export const BookingSnapshotSchema = z
	.object({
		id: EntityIdSchema,
		conversationId: EntityIdSchema,
		status: z.literal("booked"),
		name: z.string().trim().min(1).max(120),
		contacts: BookingContactsSchema,
		company: z.string().trim().min(1).max(200),
		meetingSlot: MeetingSlotSchema,
		qualification: QualificationPatchSchema.optional(),
		qualificationStatus: QualificationStatusSchema,
		createdAt: Rfc3339UtcSchema,
		updatedAt: Rfc3339UtcSchema,
	})
	.strict();

const BookingCreatedDataSchema = z
	.object({
		bookingId: EntityIdSchema,
		conversationId: EntityIdSchema,
		name: z.string().trim().min(1).max(120),
		contacts: BookingContactsSchema,
		company: z.string().trim().min(1).max(200),
		meetingSlot: MeetingSlotSchema,
		status: z.literal("booked"),
		qualificationStatus: z.literal("none"),
	})
	.strict();

export const BookingCreatedEventSchema = z
	.object({
		v: ContractVersionSchema,
		type: z.literal("booking.created"),
		eventId: EntityIdSchema,
		occurredAt: Rfc3339UtcSchema,
		data: BookingCreatedDataSchema,
	})
	.strict();

const BookingUpdatedDataSchema = z
	.object({
		bookingId: EntityIdSchema,
		conversationId: EntityIdSchema,
		qualificationStatus: z.enum(["partial", "complete", "skipped"]),
		qualification: QualificationPatchSchema.optional(),
	})
	.strict();

export const BookingUpdatedEventSchema = z
	.object({
		v: ContractVersionSchema,
		type: z.literal("booking.updated"),
		eventId: EntityIdSchema,
		occurredAt: Rfc3339UtcSchema,
		data: BookingUpdatedDataSchema,
	})
	.strict();

export const BookingDomainEventSchema = z.discriminatedUnion("type", [
	BookingCreatedEventSchema,
	BookingUpdatedEventSchema,
]);

export type BookingCreatedEvent = z.infer<typeof BookingCreatedEventSchema>;
export type BookingDomainEvent = z.infer<typeof BookingDomainEventSchema>;
export type BookingSnapshot = z.infer<typeof BookingSnapshotSchema>;
export type BookingUpdatedEvent = z.infer<typeof BookingUpdatedEventSchema>;
export type Contact = z.infer<typeof ContactSchema>;
export type ConversationStage = z.infer<typeof ConversationStageSchema>;
export type ConversationStatus = z.infer<typeof ConversationStatusSchema>;
export type KnownFacts = z.infer<typeof KnownFactsSchema>;
export type MeetingSlot = z.infer<typeof MeetingSlotSchema>;
export type QualificationPatch = z.infer<typeof QualificationPatchSchema>;
export type QualificationStatus = z.infer<typeof QualificationStatusSchema>;
