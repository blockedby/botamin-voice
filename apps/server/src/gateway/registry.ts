import type { CreateConversationRequest } from "@botamin/contracts";
import type { ObservabilityMetrics } from "../observability";
import type { GatewaySession } from "./session";
import {
	type BrainTurnAdmission,
	type BrainTurnPriority,
	BrainTurnQueue,
} from "./turn-queue";

export interface CreateSessionContext {
	conversationId: string;
	expiresAt: Date;
	request: CreateConversationRequest;
	acquireTurn(input: {
		priority: BrainTurnPriority;
		signal: AbortSignal;
	}): Promise<BrainTurnAdmission>;
	/** Schedules bounded cleanup if a client loses the terminal fallback. */
	onTerminalError(): void;
}

export interface SessionRegistryOptions {
	maxActiveConversations: number;
	maxActiveConversationsPerSource?: number;
	maxConcurrentBrainTurns: number;
	maxPendingBrainTurns?: number;
	brainQueueTimeoutMs?: number;
	sessionMaxMs: number;
	abandonedSessionMs?: number;
	terminalErrorCleanupMs?: number;
	createSession(context: CreateSessionContext): GatewaySession;
	now?: () => Date;
	idFactory?: () => string;
	cleanupIntervalMs?: number;
	metrics?: ObservabilityMetrics;
}

interface SessionRecord {
	session: GatewaySession;
	sourceKey: string;
	createdAtMs: number;
}

/** Process-local bounded registry; durable booking data remains in SQLite. */
export class SessionRegistry {
	readonly #sessions = new Map<string, SessionRecord>();
	readonly #stops = new Map<string, Promise<void>>();
	readonly #terminalErrorTimers = new Map<
		string,
		ReturnType<typeof setTimeout>
	>();
	readonly #activeBySource = new Map<string, number>();
	readonly #maxActive: number;
	readonly #maxActivePerSource: number;
	readonly #maxConcurrentBrainTurns: number;
	readonly #maxPendingBrainTurns: number;
	readonly #sessionMaxMs: number;
	readonly #abandonedSessionMs: number;
	readonly #terminalErrorCleanupMs: number;
	readonly #createSession: SessionRegistryOptions["createSession"];
	readonly #now: () => Date;
	readonly #idFactory: () => string;
	readonly #timer: ReturnType<typeof setInterval>;
	readonly #turnQueue: BrainTurnQueue;
	readonly #metrics: ObservabilityMetrics | undefined;
	#disposed = false;

	constructor(options: SessionRegistryOptions) {
		this.#maxActive = options.maxActiveConversations;
		this.#maxActivePerSource =
			options.maxActiveConversationsPerSource ?? options.maxActiveConversations;
		this.#maxConcurrentBrainTurns = options.maxConcurrentBrainTurns;
		this.#maxPendingBrainTurns = options.maxPendingBrainTurns ?? 0;
		this.#sessionMaxMs = options.sessionMaxMs;
		this.#abandonedSessionMs = options.abandonedSessionMs ?? 10_000;
		this.#terminalErrorCleanupMs = options.terminalErrorCleanupMs ?? 5_000;
		this.#createSession = options.createSession;
		this.#now = options.now ?? (() => new Date());
		this.#idFactory = options.idFactory ?? (() => Bun.randomUUIDv7());
		this.#metrics = options.metrics;
		this.#turnQueue = new BrainTurnQueue({
			maxActive: this.#maxConcurrentBrainTurns,
			maxPending: this.#maxPendingBrainTurns,
			queueTimeoutMs: options.brainQueueTimeoutMs ?? 45_000,
		});
		this.#updateCapacity();
		this.#timer = setInterval(
			() => this.cleanupExpired(),
			options.cleanupIntervalMs ?? 1_000,
		);
		this.#timer.unref?.();
	}

	create(
		request: CreateConversationRequest,
		sourceKey = "ip:unknown",
	): GatewaySession | null {
		if (this.#disposed) return null;
		this.cleanupExpired();
		if (
			!this.hasCapacity ||
			(this.#activeBySource.get(sourceKey) ?? 0) >= this.#maxActivePerSource
		) {
			this.#metrics?.recordQueue("session_capacity");
			return null;
		}
		const now = this.#now();
		const conversationId = this.#idFactory();
		const expiresAt = new Date(now.getTime() + this.#sessionMaxMs);
		const session = this.#createSession({
			conversationId,
			expiresAt,
			request,
			acquireTurn: async (input) => {
				const startedAt = this.#now().getTime();
				const pending = this.#turnQueue.acquire(input);
				this.#updateCapacity();
				const result = await pending;
				this.#metrics?.recordQueue(
					result.ok ? "granted" : result.reason,
					Math.max(0, this.#now().getTime() - startedAt),
				);
				this.#updateCapacity();
				if (!result.ok) return result;
				return {
					ok: true,
					release: () => {
						result.release();
						this.#updateCapacity();
					},
				};
			},
			onTerminalError: () => this.#scheduleTerminalErrorCleanup(conversationId),
		});
		this.#sessions.set(conversationId, {
			session,
			sourceKey,
			createdAtMs: now.getTime(),
		});
		this.#activeBySource.set(
			sourceKey,
			(this.#activeBySource.get(sourceKey) ?? 0) + 1,
		);
		this.#updateCapacity();
		return session;
	}

	get(conversationId: string): GatewaySession | null {
		const record = this.#sessions.get(conversationId);
		if (!record) return null;
		if (record.session.stopped || record.session.isExpired()) {
			this.#remove(conversationId);
			void this.#trackStop(conversationId, record.session, "disconnected");
			return null;
		}
		return record.session;
	}

	async stop(
		conversationId: string,
		reason: "completed" | "disconnected" = "completed",
	): Promise<void> {
		const existing = this.#stops.get(conversationId);
		if (existing) return existing;
		const record = this.#remove(conversationId);
		if (!record) return;
		return this.#trackStop(conversationId, record.session, reason);
	}

	cleanupExpired(): void {
		const now = this.#now();
		for (const [id, record] of this.#sessions) {
			const abandoned =
				!record.session.established &&
				now.getTime() - record.createdAtMs >= this.#abandonedSessionMs;
			if (
				!record.session.stopped &&
				!record.session.isExpired(now) &&
				!abandoned
			) {
				continue;
			}
			this.#remove(id);
			void this.#trackStop(id, record.session, "disconnected");
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#timer);
		for (const timer of this.#terminalErrorTimers.values()) clearTimeout(timer);
		this.#terminalErrorTimers.clear();
		this.#turnQueue.close();
		for (const [id, record] of [...this.#sessions]) {
			this.#remove(id);
			void this.#trackStop(id, record.session, "disconnected");
		}
		await Promise.allSettled([...this.#stops.values()]);
	}

	get hasCapacity(): boolean {
		return !this.#disposed && this.#sessions.size < this.#maxActive;
	}

	get hasTurnCapacity(): boolean {
		return !this.#disposed && this.#turnQueue.hasAdmissionCapacity;
	}

	get activeCount(): number {
		return this.#sessions.size;
	}

	get activeBrainTurns(): number {
		return this.#turnQueue.activeCount;
	}

	get pendingBrainTurns(): number {
		return this.#turnQueue.pendingCount;
	}

	#remove(conversationId: string): SessionRecord | null {
		const record = this.#sessions.get(conversationId);
		if (!record) return null;
		this.#sessions.delete(conversationId);
		const terminalTimer = this.#terminalErrorTimers.get(conversationId);
		if (terminalTimer) clearTimeout(terminalTimer);
		this.#terminalErrorTimers.delete(conversationId);
		const next = (this.#activeBySource.get(record.sourceKey) ?? 1) - 1;
		if (next <= 0) this.#activeBySource.delete(record.sourceKey);
		else this.#activeBySource.set(record.sourceKey, next);
		this.#updateCapacity();
		return record;
	}

	#updateCapacity(): void {
		this.#metrics?.setCapacity({
			activeSessions: this.#sessions.size,
			maxActiveSessions: this.#maxActive,
			activeBrainTurns: this.#turnQueue.activeCount,
			maxActiveBrainTurns: this.#maxConcurrentBrainTurns,
			pendingBrainTurns: this.#turnQueue.pendingCount,
			maxPendingBrainTurns: this.#maxPendingBrainTurns,
		});
	}

	#scheduleTerminalErrorCleanup(conversationId: string): void {
		if (
			this.#disposed ||
			!this.#sessions.has(conversationId) ||
			this.#terminalErrorTimers.has(conversationId)
		) {
			return;
		}
		const timer = setTimeout(() => {
			this.#terminalErrorTimers.delete(conversationId);
			void this.stop(conversationId, "disconnected");
		}, this.#terminalErrorCleanupMs);
		timer.unref?.();
		this.#terminalErrorTimers.set(conversationId, timer);
	}

	#trackStop(
		conversationId: string,
		session: GatewaySession,
		reason: "completed" | "disconnected",
	): Promise<void> {
		const existing = this.#stops.get(conversationId);
		if (existing) return existing;
		const stopping = session.stop(reason).finally(() => {
			if (this.#stops.get(conversationId) === stopping) {
				this.#stops.delete(conversationId);
			}
		});
		this.#stops.set(conversationId, stopping);
		return stopping;
	}
}
