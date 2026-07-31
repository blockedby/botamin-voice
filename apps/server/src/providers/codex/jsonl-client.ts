import type { RpcNotification, RpcServerRequest } from "./protocol";
import { isRecord } from "./protocol";

export interface CodexStdin {
	write(data: string | Uint8Array): number;
	flush?(): number | Promise<number>;
	end?(): number | Promise<number>;
}

export interface CodexChildProcess {
	stdin: CodexStdin;
	stdout: ReadableStream<Uint8Array>;
	stderr?: ReadableStream<Uint8Array>;
	exited: Promise<number>;
	kill(signal?: number | NodeJS.Signals): void;
	pid?: number;
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
	timer: ReturnType<typeof setTimeout>;
}

type NotificationHandler = (notification: RpcNotification) => void;
type ServerRequestHandler = (params: unknown) => unknown | Promise<unknown>;
type CloseHandler = (error: Error) => void;

const MAX_PROTOCOL_LINE_BYTES = 1_048_576;

export class CodexRpcError extends Error {
	constructor(
		readonly code: number,
		message: string,
		readonly data?: unknown,
	) {
		super(message);
		this.name = "CodexRpcError";
	}
}

/** A minimal JSONL JSON-RPC client. It never logs protocol payloads. */
export class JsonlRpcClient {
	readonly pendingCount = (): number => this.pending.size;
	private readonly pending = new Map<number, PendingRequest>();
	private readonly notificationHandlers = new Set<NotificationHandler>();
	private readonly serverRequestHandlers = new Map<
		string,
		ServerRequestHandler
	>();
	private readonly closeHandlers = new Set<CloseHandler>();
	private nextId = 1;
	private closedError: Error | undefined;

	constructor(
		private readonly process: CodexChildProcess,
		private readonly defaultTimeoutMs: number,
	) {
		void this.readLoop();
		void process.exited.then((code) => {
			this.close(new Error(`Codex app-server exited (${code})`));
		});
	}

	onNotification(handler: NotificationHandler): () => void {
		this.notificationHandlers.add(handler);
		return () => this.notificationHandlers.delete(handler);
	}

	onServerRequest(method: string, handler: ServerRequestHandler): () => void {
		this.serverRequestHandlers.set(method, handler);
		return () => {
			if (this.serverRequestHandlers.get(method) === handler)
				this.serverRequestHandlers.delete(method);
		};
	}

	onClose(handler: CloseHandler): () => void {
		this.closeHandlers.add(handler);
		return () => this.closeHandlers.delete(handler);
	}

	async request(
		method: string,
		params: unknown,
		timeoutMs = this.defaultTimeoutMs,
	): Promise<unknown> {
		if (this.closedError) throw this.closedError;
		const id = this.nextId++;
		const result = new Promise<unknown>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`Codex request timed out: ${method}`));
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
		});
		try {
			await this.write({ id, method, params });
		} catch (error) {
			const pending = this.pending.get(id);
			if (pending) {
				clearTimeout(pending.timer);
				this.pending.delete(id);
				pending.reject(asError(error));
			}
		}
		return result;
	}

	async notify(method: string, params: unknown): Promise<void> {
		if (this.closedError) throw this.closedError;
		await this.write({ method, params });
	}

	close(error = new Error("Codex RPC client closed")): void {
		if (this.closedError) return;
		this.closedError = error;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
		for (const handler of this.closeHandlers) handler(error);
	}

	private async write(message: unknown): Promise<void> {
		const encoded = `${JSON.stringify(message)}\n`;
		if (encoded.length > MAX_PROTOCOL_LINE_BYTES)
			throw new Error("Codex protocol message exceeds limit");
		this.process.stdin.write(encoded);
		await this.process.stdin.flush?.();
	}

	private async readLoop(): Promise<void> {
		const reader = this.process.stdout.getReader();
		const decoder = new TextDecoder();
		let buffered = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffered += decoder.decode(value, { stream: true });
				if (buffered.length > MAX_PROTOCOL_LINE_BYTES)
					throw new Error("Codex protocol line exceeds limit");
				let newline = buffered.indexOf("\n");
				while (newline >= 0) {
					const line = buffered.slice(0, newline).trim();
					buffered = buffered.slice(newline + 1);
					if (line) await this.handleLine(line);
					newline = buffered.indexOf("\n");
				}
			}
			buffered += decoder.decode();
			if (buffered.trim()) await this.handleLine(buffered.trim());
		} catch (error) {
			this.close(asError(error));
			this.process.kill();
		} finally {
			reader.releaseLock();
		}
	}

	private async handleLine(line: string): Promise<void> {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch {
			throw new Error("Codex app-server emitted invalid JSON");
		}
		if (!isRecord(message)) throw new Error("Invalid Codex RPC message");

		if (
			(typeof message.id === "number" || typeof message.id === "string") &&
			typeof message.method === "string"
		) {
			await this.handleServerRequest(message as unknown as RpcServerRequest);
			return;
		}
		if (typeof message.id === "number") {
			const pending = this.pending.get(message.id);
			if (!pending) return;
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (isRecord(message.error)) {
				pending.reject(
					new CodexRpcError(
						typeof message.error.code === "number" ? message.error.code : -1,
						typeof message.error.message === "string"
							? message.error.message
							: "Codex request failed",
						message.error.data,
					),
				);
			} else if ("result" in message) pending.resolve(message.result);
			else pending.reject(new Error("Invalid Codex RPC response"));
			return;
		}
		if (typeof message.method === "string") {
			const notification = message as unknown as RpcNotification;
			for (const handler of this.notificationHandlers) handler(notification);
			return;
		}
		throw new Error("Unrecognized Codex RPC message");
	}

	private async handleServerRequest(request: RpcServerRequest): Promise<void> {
		const handler = this.serverRequestHandlers.get(request.method);
		if (!handler) {
			await this.write({
				id: request.id,
				error: { code: -32601, message: "Method not supported by Botamin" },
			});
			return;
		}
		try {
			const result = await handler(request.params);
			await this.write({ id: request.id, result });
		} catch {
			await this.write({
				id: request.id,
				error: { code: -32602, message: "Tool request rejected by Botamin" },
			});
		}
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
