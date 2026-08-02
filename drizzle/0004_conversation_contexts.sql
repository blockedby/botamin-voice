CREATE TABLE `conversation_contexts` (
  `conversation_id` text PRIMARY KEY NOT NULL REFERENCES `conversations`(`id`) ON DELETE CASCADE,
  `revision` integer NOT NULL CHECK (`revision` >= 0),
  `draft_json` text NOT NULL CHECK (json_valid(`draft_json`) AND json_type(`draft_json`) = 'object'),
  `updated_at` text NOT NULL,
  CHECK (json_extract(`draft_json`, '$.revision') = `revision`),
  CHECK (json_extract(`draft_json`, '$.factRegistry.revision') = `revision`),
  CHECK (json_extract(`draft_json`, '$.updatedAt') = `updated_at`)
);
