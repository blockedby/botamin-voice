PRAGMA foreign_keys = ON;
--> statement-breakpoint
CREATE TABLE `conversations` (
  `id` text PRIMARY KEY NOT NULL,
  `status` text NOT NULL CHECK (`status` IN ('active', 'completed', 'failed', 'disconnected')),
  `stage` text NOT NULL,
  `codex_thread_id` text,
  `prompt_version` text NOT NULL,
  `source` text NOT NULL,
  `locale` text NOT NULL,
  `qualification_enabled` integer NOT NULL CHECK (`qualification_enabled` IN (0, 1)),
  `consent_at` text NOT NULL,
  `started_at` text NOT NULL,
  `ended_at` text,
  `last_error_code` text
);
--> statement-breakpoint
CREATE TABLE `turns` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
  `user_text` text NOT NULL,
  `assistant_text` text NOT NULL,
  `state_before` text NOT NULL,
  `state_after` text NOT NULL,
  `speech_final_at` text,
  `brain_started_at` text,
  `first_text_delta_at` text,
  `first_audio_at` text,
  `completed_at` text,
  `interrupted` integer NOT NULL DEFAULT 0 CHECK (`interrupted` IN (0, 1)),
  `brain_model` text,
  `usage_json` text
);
--> statement-breakpoint
CREATE INDEX `turns_conversation_idx` ON `turns` (`conversation_id`, `completed_at`);
--> statement-breakpoint
CREATE TABLE `bookings` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL REFERENCES `conversations`(`id`) ON DELETE RESTRICT,
  `status` text NOT NULL DEFAULT 'booked' CHECK (`status` = 'booked'),
  `name` text NOT NULL,
  `contacts_json` text NOT NULL,
  `company` text,
  `preferred_time_text` text,
  `qualification_json` text NOT NULL DEFAULT '{}',
  `qualification_status` text NOT NULL DEFAULT 'none' CHECK (`qualification_status` IN ('none', 'partial', 'complete', 'skipped')),
  `created_at` text NOT NULL,
  `updated_at` text NOT NULL,
  UNIQUE (`conversation_id`)
);
--> statement-breakpoint
CREATE TABLE `idempotency_keys` (
  `scope` text NOT NULL,
  `key` text NOT NULL,
  `request_hash` text NOT NULL,
  `result_json` text NOT NULL,
  `conversation_id` text,
  `booking_id` text,
  `created_at` text NOT NULL,
  PRIMARY KEY (`scope`, `key`)
);
--> statement-breakpoint
CREATE INDEX `idempotency_subject_idx` ON `idempotency_keys` (`conversation_id`, `booking_id`);
--> statement-breakpoint
CREATE TABLE `domain_events` (
  `id` text PRIMARY KEY NOT NULL,
  `conversation_id` text NOT NULL,
  `booking_id` text,
  `type` text NOT NULL,
  `payload_json` text NOT NULL,
  `created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `domain_events_conversation_idx` ON `domain_events` (`conversation_id`, `created_at`);
--> statement-breakpoint
CREATE INDEX `domain_events_booking_idx` ON `domain_events` (`booking_id`, `created_at`);
--> statement-breakpoint
CREATE TABLE `notification_outbox` (
  `id` text PRIMARY KEY NOT NULL,
  `event_id` text NOT NULL REFERENCES `domain_events`(`id`) ON DELETE RESTRICT,
  `notifier_kind` text NOT NULL,
  `payload_json` text NOT NULL,
  `status` text NOT NULL DEFAULT 'pending' CHECK (`status` IN ('pending', 'sent', 'failed')),
  `attempt_count` integer NOT NULL DEFAULT 0 CHECK (`attempt_count` >= 0),
  `next_attempt_at` text NOT NULL,
  `last_error` text,
  `created_at` text NOT NULL,
  `sent_at` text,
  UNIQUE (`event_id`, `notifier_kind`)
);
--> statement-breakpoint
CREATE INDEX `notification_outbox_due_idx` ON `notification_outbox` (`status`, `next_attempt_at`);
--> statement-breakpoint
CREATE TRIGGER `domain_events_no_update`
BEFORE UPDATE ON `domain_events`
BEGIN
  SELECT RAISE(ABORT, 'domain_events is append-only');
END;
--> statement-breakpoint
CREATE TRIGGER `domain_events_no_delete`
BEFORE DELETE ON `domain_events`
BEGIN
  SELECT RAISE(ABORT, 'domain_events is append-only');
END;
