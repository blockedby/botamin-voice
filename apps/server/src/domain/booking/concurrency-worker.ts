import { openDomainDatabase } from "../../db/database";
import { SqliteBookingService } from "./service";

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
	const result = await service.createBooking({
		conversationId,
		idempotencyKey,
		name: "Concurrent lead",
		contacts: [{ channel: "telegram", value: "@concurrent" }],
		consentConfirmed: true,
	});
	process.stdout.write(JSON.stringify(result));
} finally {
	database.$client.close(false);
}
