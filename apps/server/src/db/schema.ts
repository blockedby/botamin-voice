import { sql } from "drizzle-orm";
import {
	check,
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
	uniqueIndex,
} from "drizzle-orm/sqlite-core";

export const conversations = sqliteTable("conversations", {
	id: text("id").primaryKey(),
	status: text("status", {
		enum: ["active", "completed", "failed", "disconnected"],
	}).notNull(),
	stage: text("stage").notNull(),
	codexThreadId: text("codex_thread_id"),
	promptVersion: text("prompt_version").notNull(),
	source: text("source").notNull(),
	locale: text("locale").notNull(),
	qualificationEnabled: integer("qualification_enabled", {
		mode: "boolean",
	}).notNull(),
	consentAt: text("consent_at").notNull(),
	startedAt: text("started_at").notNull(),
	endedAt: text("ended_at"),
	lastErrorCode: text("last_error_code"),
});

export const turns = sqliteTable(
	"turns",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "cascade" }),
		userText: text("user_text").notNull(),
		assistantText: text("assistant_text").notNull(),
		stateBefore: text("state_before").notNull(),
		stateAfter: text("state_after").notNull(),
		speechFinalAt: text("speech_final_at"),
		brainStartedAt: text("brain_started_at"),
		firstTextDeltaAt: text("first_text_delta_at"),
		firstAudioAt: text("first_audio_at"),
		completedAt: text("completed_at"),
		interrupted: integer("interrupted", { mode: "boolean" })
			.notNull()
			.default(false),
		brainModel: text("brain_model"),
		usageJson: text("usage_json"),
	},
	(table) => [
		index("turns_conversation_idx").on(table.conversationId, table.completedAt),
		index("turns_completed_at_idx").on(table.completedAt),
	],
);

export const bookings = sqliteTable(
	"bookings",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id")
			.notNull()
			.references(() => conversations.id, { onDelete: "restrict" }),
		status: text("status", { enum: ["booked"] })
			.notNull()
			.default("booked"),
		name: text("name").notNull(),
		contactsJson: text("contacts_json").notNull(),
		company: text("company"),
		preferredTimeText: text("preferred_time_text"),
		qualificationJson: text("qualification_json").notNull().default("{}"),
		qualificationStatus: text("qualification_status", {
			enum: ["none", "partial", "complete", "skipped"],
		})
			.notNull()
			.default("none"),
		createdAt: text("created_at").notNull(),
		updatedAt: text("updated_at").notNull(),
	},
	(table) => [
		unique("bookings_conversation_unique").on(table.conversationId),
		check("bookings_status_booked", sql`${table.status} = 'booked'`),
	],
);

export const idempotencyKeys = sqliteTable(
	"idempotency_keys",
	{
		scope: text("scope").notNull(),
		key: text("key").notNull(),
		requestHash: text("request_hash").notNull(),
		resultJson: text("result_json").notNull(),
		conversationId: text("conversation_id"),
		bookingId: text("booking_id"),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		primaryKey({ columns: [table.scope, table.key] }),
		index("idempotency_subject_idx").on(table.conversationId, table.bookingId),
	],
);

export const domainEvents = sqliteTable(
	"domain_events",
	{
		id: text("id").primaryKey(),
		conversationId: text("conversation_id").notNull(),
		bookingId: text("booking_id"),
		type: text("type").notNull(),
		payloadJson: text("payload_json").notNull(),
		createdAt: text("created_at").notNull(),
	},
	(table) => [
		index("domain_events_conversation_idx").on(
			table.conversationId,
			table.createdAt,
		),
		index("domain_events_booking_idx").on(table.bookingId, table.createdAt),
	],
);

export const notificationOutbox = sqliteTable(
	"notification_outbox",
	{
		id: text("id").primaryKey(),
		eventId: text("event_id")
			.notNull()
			.references(() => domainEvents.id, { onDelete: "restrict" }),
		notifierKind: text("notifier_kind").notNull(),
		payloadJson: text("payload_json").notNull(),
		status: text("status", { enum: ["pending", "sent", "failed"] })
			.notNull()
			.default("pending"),
		attemptCount: integer("attempt_count").notNull().default(0),
		nextAttemptAt: text("next_attempt_at").notNull(),
		claimToken: text("claim_token"),
		lastError: text("last_error"),
		createdAt: text("created_at").notNull(),
		sentAt: text("sent_at"),
	},
	(table) => [
		uniqueIndex("notification_outbox_event_notifier_unique").on(
			table.eventId,
			table.notifierKind,
		),
		index("notification_outbox_due_idx").on(table.status, table.nextAttemptAt),
	],
);

export const schema = {
	bookings,
	conversations,
	domainEvents,
	idempotencyKeys,
	notificationOutbox,
	turns,
};
