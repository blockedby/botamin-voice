import { type CodexChildProcess, JsonlRpcClient } from "./jsonl-client";

export const PINNED_CODEX_CLI_VERSION = "codex-cli 0.146.0";
export const CODEX_PROTOCOL_SCHEMA_REVISION = "0.146.0-experimental";

export interface CodexSupervisorOptions {
	codexBin: string;
	codexHome: string;
	runtimeCwd: string;
	requestTimeoutMs: number;
	restartBaseDelayMs: number;
	restartMaxDelayMs: number;
	env?: Record<string, string | undefined>;
	spawn?: CodexSpawn;
	onLifecycleEvent?: (event: {
		type: "started" | "exited" | "restart_scheduled" | "stderr";
		attempt?: number;
		bytes?: number;
	}) => void;
}

export type CodexSpawn = (
	command: string[],
	options: { cwd: string; env: Record<string, string> },
) => CodexChildProcess;

function defaultSpawn(
	command: string[],
	options: { cwd: string; env: Record<string, string> },
): CodexChildProcess {
	return Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	}) as unknown as CodexChildProcess;
}

/**
 * Builds an allowlisted child environment. In particular, application secrets
 * (xAI, webhook, database and .env-derived values) are not inherited.
 */
export function buildSanitizedCodexEnv(
	codexHome: string,
	source: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const result: Record<string, string> = { CODEX_HOME: codexHome };
	for (const key of [
		"PATH",
		"HOME",
		"LANG",
		"LC_ALL",
		"TZ",
		"TMPDIR",
		"SSL_CERT_FILE",
		"SSL_CERT_DIR",
	] as const) {
		const value = source[key];
		if (value) result[key] = value;
	}
	return result;
}

export function restrictedAppServerCommand(codexBin: string): string[] {
	return [
		codexBin,
		"app-server",
		"--stdio",
		"--strict-config",
		"-c",
		"features.shell_tool=false",
		"-c",
		"features.unified_exec=false",
		"-c",
		"features.shell_snapshot=false",
		"-c",
		"features.web_search=false",
		"-c",
		'web_search="disabled"',
		"-c",
		"features.apps=false",
		"-c",
		"features.plugins=false",
		"-c",
		"features.remote_plugin=false",
		"-c",
		"features.in_app_browser=false",
		"-c",
		"features.network_proxy=false",
		"-c",
		"features.multi_agent=false",
		"-c",
		"agents.enabled=false",
		"-c",
		"features.memories=false",
		"-c",
		"allow_login_shell=false",
		"-c",
		'history.persistence="none"',
		"-c",
		"project_doc_max_bytes=131072",
		"-c",
		"mcp_servers={}",
	];
}

export class CodexProcessSupervisor {
	private process: CodexChildProcess | undefined;
	private rpcClient: JsonlRpcClient | undefined;
	private startPromise: Promise<JsonlRpcClient> | undefined;
	private stopped = false;
	private restartAttempt = 0;
	private restartTimer: ReturnType<typeof setTimeout> | undefined;
	private generation = 0;
	private readonly restartHandlers = new Set<(error: Error) => void>();

	constructor(private readonly options: CodexSupervisorOptions) {}

	onRestart(handler: (error: Error) => void): () => void {
		this.restartHandlers.add(handler);
		return () => this.restartHandlers.delete(handler);
	}

	async client(): Promise<JsonlRpcClient> {
		if (this.stopped) throw new Error("Codex supervisor is stopped");
		if (this.rpcClient) return this.rpcClient;
		if (!this.startPromise) this.startPromise = this.start();
		return this.startPromise;
	}

	isRunning(): boolean {
		return this.rpcClient !== undefined;
	}

	async stop(): Promise<void> {
		this.stopped = true;
		if (this.restartTimer) clearTimeout(this.restartTimer);
		this.restartTimer = undefined;
		this.rpcClient?.close(new Error("Codex supervisor stopped"));
		this.rpcClient = undefined;
		this.process?.kill("SIGTERM");
		this.process = undefined;
		this.startPromise = undefined;
	}

	private async start(): Promise<JsonlRpcClient> {
		const generation = ++this.generation;
		const spawn = this.options.spawn ?? defaultSpawn;
		let child: CodexChildProcess;
		try {
			child = spawn(restrictedAppServerCommand(this.options.codexBin), {
				cwd: this.options.runtimeCwd,
				env: buildSanitizedCodexEnv(
					this.options.codexHome,
					this.options.env ?? process.env,
				),
			});
		} catch (error) {
			this.startPromise = undefined;
			this.scheduleRestart(asError(error));
			throw error;
		}
		this.process = child;
		this.observeStderr(child);
		const client = new JsonlRpcClient(child, this.options.requestTimeoutMs);
		try {
			const initialized = await client.request("initialize", {
				clientInfo: {
					name: "botamin_voice",
					title: "Botamin Voice",
					version: "0.1.0",
				},
				capabilities: {
					experimentalApi: true,
					requestAttestation: false,
				},
			});
			if (
				typeof initialized !== "object" ||
				initialized === null ||
				!("userAgent" in initialized) ||
				typeof initialized.userAgent !== "string" ||
				!initialized.userAgent.includes(
					`/${PINNED_CODEX_CLI_VERSION.replace("codex-cli ", "")}`,
				)
			)
				throw new Error("Codex app-server version does not match protocol pin");
			await client.notify("initialized", {});
		} catch (error) {
			client.close(asError(error));
			child.kill();
			this.process = undefined;
			this.startPromise = undefined;
			this.scheduleRestart(asError(error));
			throw error;
		}
		if (this.stopped || generation !== this.generation) {
			client.close(new Error("Stale Codex app-server process"));
			child.kill();
			throw new Error("Stale Codex app-server process");
		}
		this.rpcClient = client;
		this.startPromise = undefined;
		this.restartAttempt = 0;
		this.options.onLifecycleEvent?.({ type: "started" });
		void child.exited.then((code) => {
			if (generation !== this.generation) return;
			const error = new Error(`Codex app-server exited (${code})`);
			this.rpcClient = undefined;
			this.process = undefined;
			this.startPromise = undefined;
			this.options.onLifecycleEvent?.({ type: "exited" });
			for (const handler of this.restartHandlers) handler(error);
			this.scheduleRestart(error);
		});
		return client;
	}

	private scheduleRestart(_error: Error): void {
		if (this.stopped || this.restartTimer) return;
		const attempt = this.restartAttempt++;
		const delay = Math.min(
			this.options.restartMaxDelayMs,
			this.options.restartBaseDelayMs * 2 ** attempt,
		);
		this.options.onLifecycleEvent?.({
			type: "restart_scheduled",
			attempt: attempt + 1,
		});
		this.restartTimer = setTimeout(() => {
			this.restartTimer = undefined;
			if (!this.stopped) void this.client().catch(() => undefined);
		}, delay);
	}

	private observeStderr(child: CodexChildProcess): void {
		if (!child.stderr) return;
		void (async () => {
			const reader = child.stderr?.getReader();
			if (!reader) return;
			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) return;
					// Contents may contain prompts/PII. Report byte count only.
					this.options.onLifecycleEvent?.({
						type: "stderr",
						bytes: value.byteLength,
					});
				}
			} finally {
				reader.releaseLock();
			}
		})();
	}
}

function asError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}
