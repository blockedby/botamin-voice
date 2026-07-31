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
	.strict()
	.refine((patch) => Object.keys(patch).length > 0, {
		message: "Qualification patch must update at least one field",
	});

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
		name: z.string().min(1).max(120),
		contacts: z.array(ContactSchema).min(1).max(3),
		company: z.string().max(200).optional(),
		preferredTimeText: z.string().max(500).optional(),
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
		name: z.string().min(1).max(120),
		contacts: z.array(ContactSchema).min(1).max(3),
		company: z.string().max(200).optional(),
		preferredTimeText: z.string().max(500).optional(),
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
export type QualificationPatch = z.infer<typeof QualificationPatchSchema>;
export type QualificationStatus = z.infer<typeof QualificationStatusSchema>;
