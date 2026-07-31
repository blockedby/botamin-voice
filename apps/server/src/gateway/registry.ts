import type { CreateConversationRequest } from "@botamin/contracts";
import type { GatewaySession } from "./session";

export interface CreateSessionContext {
	conversationId: string;
	expiresAt: Date;
	request: CreateConversationRequest;
	acquireTurn(): (() => void) | null;
}

export interface SessionRegistryOptions {
	maxActiveConversations: number;
	maxConcurrentBrainTurns: number;
	sessionMaxMs: number;
	createSession(context: CreateSessionContext): GatewaySession;
	now?: () => Date;
	idFactory?: () => string;
	cleanupIntervalMs?: number;
}

/** Process-local bounded registry; durable booking data remains in SQLite. */
export class SessionRegistry {
	readonly #sessions = new Map<string, GatewaySession>();
	readonly #maxActive: number;
	readonly #maxBrainTurns: number;
	readonly #sessionMaxMs: number;
	readonly #createSession: SessionRegistryOptions["createSession"];
	readonly #now: () => Date;
	readonly #idFactory: () => string;
	readonly #timer: ReturnType<typeof setInterval>;
	#activeBrainTurns = 0;
	#disposed = false;

	constructor(options: SessionRegistryOptions) {
		this.#maxActive = options.maxActiveConversations;
		this.#maxBrainTurns = options.maxConcurrentBrainTurns;
		this.#sessionMaxMs = options.sessionMaxMs;
		this.#createSession = options.createSession;
		this.#now = options.now ?? (() => new Date());
		this.#idFactory = options.idFactory ?? (() => Bun.randomUUIDv7());
		this.#timer = setInterval(
			() => void this.cleanupExpired(),
			options.cleanupIntervalMs ?? 30_000,
		);
		this.#timer.unref?.();
	}

	create(request: CreateConversationRequest): GatewaySession | null {
		if (this.#disposed) return null;
		this.cleanupExpired();
		if (!this.hasCapacity) return null;
		const now = this.#now();
		const conversationId = this.#idFactory();
		const expiresAt = new Date(now.getTime() + this.#sessionMaxMs);
		const session = this.#createSession({
			conversationId,
			expiresAt,
			request,
			acquireTurn: () => this.acquireTurn(),
		});
		this.#sessions.set(conversationId, session);
		return session;
	}

	get(conversationId: string): GatewaySession | null {
		const session = this.#sessions.get(conversationId);
		if (!session) return null;
		if (session.stopped || session.isExpired()) {
			this.#sessions.delete(conversationId);
			void session.stop("disconnected");
			return null;
		}
		return session;
	}

	async stop(conversationId: string): Promise<void> {
		const session = this.#sessions.get(conversationId);
		if (!session) return;
		this.#sessions.delete(conversationId);
		await session.stop("completed");
	}

	cleanupExpired(): void {
		const now = this.#now();
		for (const [id, session] of this.#sessions) {
			if (!session.stopped && !session.isExpired(now)) continue;
			this.#sessions.delete(id);
			void session.stop("disconnected");
		}
	}

	async dispose(): Promise<void> {
		if (this.#disposed) return;
		this.#disposed = true;
		clearInterval(this.#timer);
		const sessions = [...this.#sessions.values()];
		this.#sessions.clear();
		await Promise.allSettled(
			sessions.map((session) => session.stop("disconnected")),
		);
	}

	get hasCapacity(): boolean {
		return (
			!this.#disposed &&
			this.#sessions.size < this.#maxActive &&
			this.#activeBrainTurns < this.#maxBrainTurns
		);
	}

	get activeCount(): number {
		return this.#sessions.size;
	}

	get activeBrainTurns(): number {
		return this.#activeBrainTurns;
	}

	private acquireTurn(): (() => void) | null {
		if (this.#disposed || this.#activeBrainTurns >= this.#maxBrainTurns) {
			return null;
		}
		this.#activeBrainTurns += 1;
		let released = false;
		return () => {
			if (released) return;
			released = true;
			this.#activeBrainTurns = Math.max(0, this.#activeBrainTurns - 1);
		};
	}
}
