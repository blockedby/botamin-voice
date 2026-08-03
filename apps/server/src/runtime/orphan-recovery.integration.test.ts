import { afterEach, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type {
	AppendQualificationInput,
	BookingService,
	BrainPort,
	BrainTurnInput,
	CreateBookingInput,
	MeetingSlot,
	SttPort,
	TtsPort,
} from "@botamin/contracts";
import {
	ConversationStore,
	closeDomainDatabase,
	openDomainDatabase,
} from "../db";
import { SqliteBookingService } from "../domain/booking/service";
import { SqliteBookingDraftStore } from "../domain/booking-draft/store";
import type { NamedLeadNotifier } from "../notifiers";
import { createProductionRuntime } from "./runtime";

const directories: string[] = [];
const instant = "2026-08-02T20:00:00.000Z";
const slots: [MeetingSlot, MeetingSlot] = [
	{
		startAt: "2026-08-03T06:00:00.000Z",
		endAt: "2026-08-03T06:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	},
	{
		startAt: "2026-08-03T13:00:00.000Z",
		endAt: "2026-08-03T13:20:00.000Z",
		timeZone: "Europe/Moscow",
		durationMinutes: 20,
	},
];

afterEach(async () => {
	await Promise.all(
		directories
			.splice(0)
			.map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

interface Harness {
	directory: string;
	databaseFile: string;
	env: Record<string, string>;
}

interface ProviderCalls {
	brainTurns: number;
	stt: number;
	tts: number;
}

async function harness(): Promise<Harness> {
	const directory = await mkdtemp(join(tmpdir(), "botamin-startup-recovery-"));
	directories.push(directory);
	const promptDir = join(directory, "brain");
	const codexHome = join(directory, "codex-home");
	await mkdir(promptDir, { recursive: true });
	await mkdir(codexHome, { recursive: true });
	const agents = join(promptDir, "AGENTS.md");
	await writeFile(agents, "# recovery test prompt\n", { mode: 0o444 });
	await chmod(agents, 0o444);
	const databaseFile = join(directory, "data", "app.db");
	await mkdir(join(directory, "data"), { recursive: true });
	return {
		directory,
		databaseFile,
		env: {
			APP_ORIGIN: "http://localhost:5173",
			AUTO_MIGRATE: "true",
			DATABASE_URL: `file:${databaseFile}`,
			MIGRATIONS_DIR: resolve("drizzle"),
			BRAIN_PROVIDER: "codex-subscription",
			CODEX_MODEL: "gpt-5.6-luna",
			CODEX_HOME: codexHome,
			CODEX_CWD: promptDir,
			PROMPT_RUNTIME_DIR: promptDir,
			CODEX_TOOL_MODE: "envelope",
			CODEX_MAX_CONCURRENT_TURNS: "1",
			MAX_ACTIVE_CONVERSATIONS: "1",
			MAX_CONCURRENT_BRAIN_TURNS: "1",
			STT_PROVIDER: "openrouter",
			TTS_PROVIDER: "openrouter",
			OPENROUTER_API_KEY: "test-placeholder-not-a-secret",
			OPENROUTER_STT_AUDIO_FORMAT: "wav",
			OPENROUTER_STT_LANGUAGE: "ru",
			OPENROUTER_TTS_RESPONSE_FORMAT: "mp3",
			STT_TEXT_ONLY_INPUT_FALLBACK: "false",
			STORE_RAW_AUDIO: "false",
		},
	};
}

function providerFakes(calls: ProviderCalls) {
	const brain: BrainPort & { close(): Promise<void> } = {
		createThread: async () => "unused-thread",
		async *runTurn(_input: BrainTurnInput) {
			calls.brainTurns += 1;
			yield* [];
		},
		interrupt: async () => undefined,
		health: async () => ({ status: "healthy" }),
		close: async () => undefined,
	};
	const stt: SttPort = {
		transcribe: async () => {
			calls.stt += 1;
			throw new Error("not used");
		},
		health: async () => "ready",
	};
	const tts: TtsPort & { readonly outputContentType: "audio/mpeg" } = {
		outputContentType: "audio/mpeg",
		synthesize: async () => {
			calls.tts += 1;
			throw new Error("not used");
		},
		health: async () => "ready",
	};
	return { brain, stt, tts };
}

const silentNotifier: NamedLeadNotifier = {
	kind: "console",
	publish: async () => undefined,
};

function seedCommitting(databaseFile: string): {
	conversationId: string;
	revision: number;
} {
	const database = openDomainDatabase({ filename: databaseFile });
	try {
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "a".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: instant,
			startedAt: instant,
		});
		const store = new SqliteBookingDraftStore(database, {
			now: () => new Date(instant),
		});
		const initial = store.initialize(conversationId, slots);
		const ready = store.applyForm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			baseRevision: initial.revision,
			selectedCandidateId: initial.candidates[0].candidateId,
			details: {
				name: "Private Recovery Person",
				company: "Private Recovery Company",
				workEmail: "private-recovery@example.com",
				phone: "+79991234567",
			},
		});
		const confirmed = store.confirm(conversationId, {
			requestId: Bun.randomUUIDv7(),
			revision: ready.revision,
		});
		const committing = store.markCommitting(conversationId, confirmed.revision);
		return { conversationId, revision: committing.revision };
	} finally {
		closeDomainDatabase(database);
	}
}

function seedUncommitted(databaseFile: string): string {
	const database = openDomainDatabase({ filename: databaseFile });
	try {
		const conversationId = Bun.randomUUIDv7();
		new ConversationStore(database).create({
			id: conversationId,
			stage: "COLLECT_BOOKING",
			promptVersion: "a".repeat(64),
			source: "landing",
			locale: "ru-RU",
			qualificationEnabled: true,
			consentAt: instant,
			startedAt: instant,
		});
		new SqliteBookingDraftStore(database, {
			now: () => new Date(instant),
		}).initialize(conversationId, slots);
		return conversationId;
	} finally {
		closeDomainDatabase(database);
	}
}

function markFailed(
	databaseFile: string,
	seeded: { conversationId: string; revision: number },
): void {
	const database = openDomainDatabase({
		filename: databaseFile,
		applyMigrations: false,
	});
	try {
		new SqliteBookingDraftStore(database, {
			now: () => new Date(instant),
		}).markFailed(seeded.conversationId, seeded.revision);
	} finally {
		closeDomainDatabase(database);
	}
}

function databaseCounts(databaseFile: string, conversationId: string) {
	const database = openDomainDatabase({
		filename: databaseFile,
		applyMigrations: false,
	});
	try {
		return {
			bookings: database.$client
				.query<{ value: number }, [string]>(
					"SELECT count(*) AS value FROM bookings WHERE conversation_id = ?",
				)
				.get(conversationId)?.value,
			events: database.$client
				.query<{ value: number }, [string]>(
					"SELECT count(*) AS value FROM domain_events WHERE conversation_id = ? AND type = 'booking.created'",
				)
				.get(conversationId)?.value,
			context: database.$client
				.query<{ draft_json: string }, [string]>(
					"SELECT draft_json FROM conversation_contexts WHERE conversation_id = ?",
				)
				.get(conversationId)?.draft_json,
		};
	} finally {
		closeDomainDatabase(database);
	}
}

function transientBookings(onCreate?: () => void): BookingService {
	return {
		candidateMeetingSlots: async () => slots,
		createBooking: async (_input: CreateBookingInput) => {
			onCreate?.();
			throw Object.assign(new Error("safe transient"), {
				code: "DB_UNAVAILABLE",
			});
		},
		appendQualification: async (_input: AppendQualificationInput) => {
			throw new Error("not used");
		},
		findByConversationId: async () => null,
	};
}

describe("production-wired orphan booking recovery", () => {
	test("restart recovers crash-before-create without a session or provider call", async () => {
		const setup = await harness();
		const seeded = seedCommitting(setup.databaseFile);
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		const runtime = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryIntervalMs: 60_000,
		});
		try {
			expect(runtime.registry.get(seeded.conversationId)).toBeNull();
			const ready = await runtime.readiness();
			expect(ready.checks.find((check) => check.name === "recovery")).toEqual({
				name: "recovery",
				status: "ready",
			});
			expect(calls).toEqual({ brainTurns: 0, stt: 0, tts: 0 });
			const counts = databaseCounts(setup.databaseFile, seeded.conversationId);
			expect(counts.bookings).toBe(1);
			expect(counts.events).toBe(1);
			expect(JSON.parse(counts.context ?? "{}")).toMatchObject({
				commitStatus: "committed",
				confirmationStatus: "confirmed",
			});
			const metrics = JSON.stringify(runtime.metrics?.snapshot());
			expect(metrics).toContain('"orphanRecovery"');
			for (const privateValue of [
				seeded.conversationId,
				"Private Recovery Person",
				"Private Recovery Company",
				"private-recovery@example.com",
				"+79991234567",
			]) {
				expect(metrics).not.toContain(privateValue);
			}
		} finally {
			await runtime.dispose();
		}
	});

	test("runtime construction waits for the bounded startup scan", async () => {
		const setup = await harness();
		seedCommitting(setup.databaseFile);
		let release: (() => void) | undefined;
		const gate = new Promise<void>((resolveGate) => {
			release = resolveGate;
		});
		let createStarted = false;
		const delayed = transientBookings(() => {
			createStarted = true;
		});
		const originalCreate = delayed.createBooking.bind(delayed);
		delayed.createBooking = async (input) => {
			createStarted = true;
			await gate;
			return originalCreate(input);
		};
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		let settled = false;
		const constructing = createProductionRuntime(setup.env, {
			...providerFakes(calls),
			bookings: delayed,
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryIntervalMs: 60_000,
		}).then((runtime) => {
			settled = true;
			return runtime;
		});
		for (let attempt = 0; attempt < 20 && !createStarted; attempt += 1) {
			await Bun.sleep(2);
		}
		expect(createStarted).toBe(true);
		expect(settled).toBe(false);
		release?.();
		const runtime = await constructing;
		try {
			expect(
				(await runtime.readiness()).checks.find(
					(check) => check.name === "recovery",
				)?.status,
			).toBe("degraded");
		} finally {
			await runtime.dispose();
		}
	});

	test("startup loading stops at the configured maximum and reports pending work", async () => {
		const setup = await harness();
		seedCommitting(setup.databaseFile);
		seedCommitting(setup.databaseFile);
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		const runtime = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryBatchSize: 1,
			orphanRecoveryMaxPerSweep: 1,
			orphanRecoveryIntervalMs: 60_000,
		});
		try {
			expect(
				(await runtime.readiness()).checks.find(
					(check) => check.name === "recovery",
				),
			).toEqual({
				name: "recovery",
				status: "degraded",
				code: "ORPHAN_RECOVERY_DEGRADED",
			});
			const database = openDomainDatabase({
				filename: setup.databaseFile,
				applyMigrations: false,
			});
			try {
				expect(
					database.$client
						.query<{ value: number }, []>(
							"SELECT count(*) AS value FROM bookings",
						)
						.get()?.value,
				).toBe(1);
			} finally {
				closeDomainDatabase(database);
			}
		} finally {
			await runtime.dispose();
		}
	});

	test("a transient early ID does not starve later bounded sweep rows", async () => {
		const setup = await harness();
		const first = seedCommitting(setup.databaseFile);
		const second = seedCommitting(setup.databaseFile);
		const blockedId = [first.conversationId, second.conversationId].sort()[0];
		if (!blockedId) throw new Error("missing recovery ID");
		const recoverableId =
			blockedId === first.conversationId
				? second.conversationId
				: first.conversationId;
		const auxiliary = openDomainDatabase({
			filename: setup.databaseFile,
			applyMigrations: false,
		});
		const durable = new SqliteBookingService(auxiliary, {
			now: () => new Date(instant),
			notifierKind: "console",
		});
		const routed: BookingService = {
			candidateMeetingSlots: (...input) =>
				durable.candidateMeetingSlots(...input),
			createBooking: (input) =>
				input.conversationId === blockedId
					? Promise.reject(
							Object.assign(new Error("safe transient"), {
								code: "DB_UNAVAILABLE",
							}),
						)
					: durable.createBooking(input),
			appendQualification: (input) => durable.appendQualification(input),
			findByConversationId: (conversationId) =>
				durable.findByConversationId(conversationId),
		};
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		const runtime = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			bookings: routed,
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryBatchSize: 1,
			orphanRecoveryMaxPerSweep: 1,
			orphanRecoveryIntervalMs: 10,
		});
		try {
			for (let attempt = 0; attempt < 30; attempt += 1) {
				if (databaseCounts(setup.databaseFile, recoverableId).bookings === 1)
					break;
				await Bun.sleep(5);
			}
			expect(databaseCounts(setup.databaseFile, recoverableId).bookings).toBe(
				1,
			);
			expect(databaseCounts(setup.databaseFile, blockedId).bookings).toBe(0);
		} finally {
			await runtime.dispose();
			closeDomainDatabase(auxiliary);
		}
	});

	test("concurrent production starts create exactly one booking and event", async () => {
		const setup = await harness();
		const seeded = seedCommitting(setup.databaseFile);
		const firstCalls = { brainTurns: 0, stt: 0, tts: 0 };
		const secondCalls = { brainTurns: 0, stt: 0, tts: 0 };
		const [first, second] = await Promise.all([
			createProductionRuntime(setup.env, {
				...providerFakes(firstCalls),
				notifier: silentNotifier,
				now: () => new Date(instant),
				orphanRecoveryIntervalMs: 60_000,
			}),
			createProductionRuntime(setup.env, {
				...providerFakes(secondCalls),
				notifier: silentNotifier,
				now: () => new Date(instant),
				orphanRecoveryIntervalMs: 60_000,
			}),
		]);
		try {
			expect(
				databaseCounts(setup.databaseFile, seeded.conversationId),
			).toMatchObject({
				bookings: 1,
				events: 1,
			});
			expect(firstCalls).toEqual({ brainTurns: 0, stt: 0, tts: 0 });
			expect(secondCalls).toEqual({ brainTurns: 0, stt: 0, tts: 0 });
		} finally {
			await Promise.all([first.dispose(), second.dispose()]);
		}
	});

	test("committed, failed, and uncommitted contexts are ignored by later starts", async () => {
		const setup = await harness();
		const committed = seedCommitting(setup.databaseFile);
		const failed = seedCommitting(setup.databaseFile);
		markFailed(setup.databaseFile, failed);
		const uncommitted = seedUncommitted(setup.databaseFile);
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		const first = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryIntervalMs: 60_000,
		});
		await first.dispose();
		const second = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryIntervalMs: 60_000,
		});
		try {
			const snapshot = second.metrics?.snapshot() as {
				business?: { orphanRecovery?: { scanned?: number } };
			};
			expect(snapshot.business?.orphanRecovery?.scanned).toBe(0);
			expect(
				databaseCounts(setup.databaseFile, committed.conversationId),
			).toMatchObject({
				bookings: 1,
				events: 1,
			});
			expect(
				databaseCounts(setup.databaseFile, failed.conversationId).bookings,
			).toBe(0);
			expect(databaseCounts(setup.databaseFile, uncommitted).bookings).toBe(0);
		} finally {
			await second.dispose();
		}
	});

	test("malformed committing data fails closed with aggregate-only degraded health", async () => {
		const setup = await harness();
		const seeded = seedCommitting(setup.databaseFile);
		const database = openDomainDatabase({
			filename: setup.databaseFile,
			applyMigrations: false,
		});
		try {
			const row = database.$client
				.query<{ draft_json: string; updated_at: string }, [string]>(
					"SELECT draft_json, updated_at FROM conversation_contexts WHERE conversation_id = ?",
				)
				.get(seeded.conversationId);
			if (!row) throw new Error("missing context");
			const malformed = JSON.parse(row.draft_json) as Record<string, unknown>;
			delete malformed.candidates;
			database.$client.run(
				"UPDATE conversation_contexts SET draft_json = ? WHERE conversation_id = ?",
				[JSON.stringify(malformed), seeded.conversationId],
			);
		} finally {
			closeDomainDatabase(database);
		}
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		const runtime = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryIntervalMs: 60_000,
		});
		try {
			const ready = await runtime.readiness();
			expect(ready.status).toBe("ready");
			expect(ready.checks.find((check) => check.name === "recovery")).toEqual({
				name: "recovery",
				status: "degraded",
				code: "ORPHAN_RECOVERY_DEGRADED",
			});
			expect(
				databaseCounts(setup.databaseFile, seeded.conversationId).bookings,
			).toBe(0);
			const metrics = JSON.stringify(runtime.metrics?.snapshot());
			expect(metrics).not.toContain(seeded.conversationId);
			expect(metrics).not.toContain("Private Recovery Person");
		} finally {
			await runtime.dispose();
		}
	});

	test("transient errors retain committing rows and dispose stops periodic retries", async () => {
		const setup = await harness();
		const seeded = seedCommitting(setup.databaseFile);
		let createCalls = 0;
		const calls = { brainTurns: 0, stt: 0, tts: 0 };
		const runtime = await createProductionRuntime(setup.env, {
			...providerFakes(calls),
			bookings: transientBookings(() => {
				createCalls += 1;
			}),
			notifier: silentNotifier,
			now: () => new Date(instant),
			orphanRecoveryIntervalMs: 10,
		});
		const ready = await runtime.readiness();
		expect(
			ready.checks.find((check) => check.name === "recovery")?.status,
		).toBe("degraded");
		await Bun.sleep(35);
		expect(createCalls).toBeGreaterThan(1);
		await runtime.dispose();
		const callsAtDispose = createCalls;
		await Bun.sleep(30);
		expect(createCalls).toBe(callsAtDispose);
		const context = databaseCounts(
			setup.databaseFile,
			seeded.conversationId,
		).context;
		expect(JSON.parse(context ?? "{}")).toMatchObject({
			commitStatus: "committing",
			bookingId: null,
		});
	});
});
