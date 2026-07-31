CREATE TABLE `_idempotency_scope_migration_guard` (
  `valid` integer NOT NULL CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_idempotency_scope_migration_guard` (`valid`)
SELECT CASE WHEN EXISTS (
  SELECT 1
  FROM `idempotency_keys`
  WHERE (`scope` = 'booking:create' AND `conversation_id` IS NULL)
     OR (`scope` = 'booking:qualification' AND `booking_id` IS NULL)
) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `_idempotency_scope_migration_guard`;
--> statement-breakpoint
UPDATE `idempotency_keys`
SET `scope` = CASE
  WHEN `scope` = 'booking:create' AND `conversation_id` IS NOT NULL
    THEN `scope` || ':' || `conversation_id`
  WHEN `scope` = 'booking:qualification' AND `booking_id` IS NOT NULL
    THEN `scope` || ':' || `booking_id`
  ELSE `scope`
END
WHERE `scope` IN ('booking:create', 'booking:qualification');
--> statement-breakpoint
ALTER TABLE `notification_outbox` ADD `claim_token` text;
