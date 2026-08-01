import { openDomainDatabase } from "../../db/database";
import { SqliteBookingService } from "./service";
import { generateCandidateMeetingSlots } from "./support";

const [filename, conversationId, idempotencyKey] = process.argv.slice(2);
if (
	filename === undefined ||
	conversationId === undefined ||
	idempotencyKey === undefined
) {
	throw new TypeError(
		"Expected database, conversation and idempotency arguments",
	);
}

const database = openDomainDatabase({ filename });
try {
	const service = new SqliteBookingService(database);
	const [meetingSlot] = generateCandidateMeetingSlots(
		new Date("2099-01-01T00:00:00.000Z"),
	);
	const result = await service.createBooking({
		conversationId,
		idempotencyKey,
		name: "Concurrent lead",
		contacts: [
			{ channel: "email", value: "concurrent@example.com" },
			{ channel: "telegram", value: "@concurrent" },
		],
		company: "Concurrent LLC",
		meetingSlot,
		consentConfirmed: true,
	});
	process.stdout.write(JSON.stringify(result));
} finally {
	database.$client.close(false);
}
