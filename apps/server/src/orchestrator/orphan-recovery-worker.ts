import type { BrainPort, BrainTurnInput, SttPort } from "@botamin/contracts";
import { closeDomainDatabase, openDomainDatabase } from "../db/database";
import { SqliteBookingService } from "../domain/booking";
import { SqliteBookingDraftStore } from "../domain/booking-draft/store";
import { ConversationOrchestrator } from "./orchestrator";
import { createInitialConversationState } from "./state";

const [filename, conversationId, instant] = process.argv.slice(2);
if (!filename || !conversationId || !instant) {
	throw new TypeError("Expected database, conversation and clock arguments");
}

const brain: BrainPort = {
	createThread: async () => "unused-recovery-thread",
	async *runTurn(_input: BrainTurnInput) {},
	interrupt: async () => undefined,
	health: async () => ({ status: "healthy" }),
};
const stt: SttPort = {
	transcribe: async () => {
		throw new Error("STT is not used during orphan recovery");
	},
	health: async () => "ready",
};

const database = openDomainDatabase({ filename, applyMigrations: false });
try {
	const now = () => new Date(instant);
	const orchestrator = new ConversationOrchestrator({
		conversationId,
		promptVersion: "c".repeat(64),
		stt,
		brain,
		bookings: new SqliteBookingService(database, { now }),
		draftStore: new SqliteBookingDraftStore(database, { now }),
		initialState: {
			...createInitialConversationState({ qualificationEnabled: false }),
			stage: "DISCONNECTED",
			resumeStage: "COLLECT_BOOKING",
			contactConsentConfirmed: true,
		},
	});
	const booking = await orchestrator.reconcileDurableBooking();
	if (!booking) throw new Error("Orphan recovery did not create a booking");
	process.stdout.write(JSON.stringify({ bookingId: booking.id }));
} finally {
	closeDomainDatabase(database);
}
