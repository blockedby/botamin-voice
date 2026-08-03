CREATE TABLE `conversation_contexts` (
  `conversation_id` text PRIMARY KEY NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL CHECK (typeof(`revision`) = 'integer' AND `revision` >= 0),
  `draft_json` text NOT NULL CHECK (
    CASE WHEN json_valid(`draft_json`) THEN
      COALESCE(json_type(`draft_json`, '$') = 'object', 0)
    ELSE 0 END
  ),
  `updated_at` text NOT NULL,
  CHECK (
    CASE WHEN json_valid(`draft_json`) THEN
      COALESCE(
        json_type(`draft_json`, '$.revision') = 'integer'
        AND json_extract(`draft_json`, '$.revision') >= 0
        AND json_extract(`draft_json`, '$.revision') = `revision`,
        0
      )
    ELSE 0 END
  ),
  CHECK (
    CASE WHEN json_valid(`draft_json`) THEN
      COALESCE(
        json_type(`draft_json`, '$.factRegistry') = 'object'
        AND json_type(`draft_json`, '$.factRegistry.schemaVersion') = 'integer'
        AND json_extract(`draft_json`, '$.factRegistry.schemaVersion') = 1
        AND json_type(`draft_json`, '$.factRegistry.facts') = 'object',
        0
      )
    ELSE 0 END
  ),
  CHECK (
    CASE WHEN json_valid(`draft_json`) THEN
      COALESCE(
        json_type(`draft_json`, '$.factRegistry.revision') = 'integer'
        AND json_extract(`draft_json`, '$.factRegistry.revision') >= 0
        AND json_extract(`draft_json`, '$.factRegistry.revision') = `revision`,
        0
      )
    ELSE 0 END
  ),
  CHECK (
    CASE WHEN json_valid(`draft_json`) THEN
      COALESCE(
        json_type(`draft_json`, '$.updatedAt') = 'text'
        AND json_extract(`draft_json`, '$.updatedAt') = `updated_at`,
        0
      )
    ELSE 0 END
  )
);
--> statement-breakpoint
CREATE INDEX `conversation_contexts_committing_cursor_idx`
ON `conversation_contexts` (
  CASE WHEN json_valid(`draft_json`)
    THEN json_extract(`draft_json`, '$.commitStatus')
    ELSE NULL
  END,
  `conversation_id`
);
