CREATE TABLE `_booking_slot_migration_guard` (
  `valid` integer NOT NULL CHECK (`valid` = 1)
);
--> statement-breakpoint
INSERT INTO `_booking_slot_migration_guard` (`valid`)
SELECT CASE WHEN EXISTS (SELECT 1 FROM `bookings`) THEN 0 ELSE 1 END;
--> statement-breakpoint
DROP TABLE `_booking_slot_migration_guard`;
--> statement-breakpoint
ALTER TABLE `bookings` ADD `meeting_start_at` text;
--> statement-breakpoint
ALTER TABLE `bookings` ADD `meeting_end_at` text;
--> statement-breakpoint
ALTER TABLE `bookings` ADD `meeting_timezone` text;
--> statement-breakpoint
CREATE UNIQUE INDEX `bookings_meeting_start_unique`
ON `bookings` (`meeting_start_at`)
WHERE `meeting_start_at` IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER `bookings_require_internal_meeting_slot_insert`
BEFORE INSERT ON `bookings`
WHEN NEW.`company` IS NULL
  OR trim(NEW.`company`) = ''
  OR NEW.`meeting_start_at` IS NULL
  OR NEW.`meeting_end_at` IS NULL
  OR NEW.`meeting_timezone` IS NULL
  OR NEW.`meeting_timezone` <> 'Europe/Moscow'
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`meeting_start_at`) <> NEW.`meeting_start_at`
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`meeting_end_at`) <> NEW.`meeting_end_at`
  OR strftime('%s', NEW.`meeting_start_at`) IS NULL
  OR strftime('%s', NEW.`meeting_end_at`) IS NULL
  OR strftime('%s', NEW.`meeting_end_at`) - strftime('%s', NEW.`meeting_start_at`) <> 1200
  OR CAST(strftime('%w', NEW.`meeting_start_at`, '+3 hours') AS integer) NOT BETWEEN 1 AND 5
  OR CAST(strftime('%H', NEW.`meeting_start_at`, '+3 hours') AS integer) NOT BETWEEN 9 AND 17
  OR CAST(strftime('%M', NEW.`meeting_start_at`, '+3 hours') AS integer) % 20 <> 0
  OR (CAST(strftime('%H', NEW.`meeting_start_at`, '+3 hours') AS integer) = 17
      AND CAST(strftime('%M', NEW.`meeting_start_at`, '+3 hours') AS integer) <> 0)
  OR strftime('%S', NEW.`meeting_start_at`, '+3 hours') <> '00'
BEGIN
  SELECT RAISE(ABORT, 'booking requires a valid internal meeting slot');
END;
--> statement-breakpoint
CREATE TRIGGER `bookings_require_internal_meeting_slot_update`
BEFORE UPDATE OF `company`, `meeting_start_at`, `meeting_end_at`, `meeting_timezone` ON `bookings`
WHEN NEW.`company` IS NULL
  OR trim(NEW.`company`) = ''
  OR NEW.`meeting_start_at` IS NULL
  OR NEW.`meeting_end_at` IS NULL
  OR NEW.`meeting_timezone` IS NULL
  OR NEW.`meeting_timezone` <> 'Europe/Moscow'
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`meeting_start_at`) <> NEW.`meeting_start_at`
  OR strftime('%Y-%m-%dT%H:%M:%fZ', NEW.`meeting_end_at`) <> NEW.`meeting_end_at`
  OR strftime('%s', NEW.`meeting_start_at`) IS NULL
  OR strftime('%s', NEW.`meeting_end_at`) IS NULL
  OR strftime('%s', NEW.`meeting_end_at`) - strftime('%s', NEW.`meeting_start_at`) <> 1200
  OR CAST(strftime('%w', NEW.`meeting_start_at`, '+3 hours') AS integer) NOT BETWEEN 1 AND 5
  OR CAST(strftime('%H', NEW.`meeting_start_at`, '+3 hours') AS integer) NOT BETWEEN 9 AND 17
  OR CAST(strftime('%M', NEW.`meeting_start_at`, '+3 hours') AS integer) % 20 <> 0
  OR (CAST(strftime('%H', NEW.`meeting_start_at`, '+3 hours') AS integer) = 17
      AND CAST(strftime('%M', NEW.`meeting_start_at`, '+3 hours') AS integer) <> 0)
  OR strftime('%S', NEW.`meeting_start_at`, '+3 hours') <> '00'
BEGIN
  SELECT RAISE(ABORT, 'booking requires a valid internal meeting slot');
END;
