import { constants } from "node:fs";
import type { FileHandle } from "node:fs/promises";
import {
	chmod,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";

const SECRET_FILES = {
	OPENROUTER_API_KEY: "openrouter_api_key",
	WEBHOOK_URL: "webhook_url",
	WEBHOOK_SIGNING_SECRET: "webhook_signing_secret",
} as const;

type SecretName = keyof typeof SECRET_FILES;

export interface MaterializeOptions {
	root: string;
	allowBlankOpenRouter?: boolean;
}

export interface MaterializedSecret {
	name: SecretName;
	path: string;
}

export class SafeMaterializationError extends Error {}

export function parseDotenv(source: string): Record<string, string> {
	const values: Record<string, string> = {};
	const withoutByteOrderMark =
		source.charCodeAt(0) === 0xfeff ? source.slice(1) : source;
	const lines = withoutByteOrderMark
		.replaceAll("\r\n", "\n")
		.replaceAll("\r", "\n")
		.split("\n");

	for (let index = 0; index < lines.length; index += 1) {
		const rawLine = lines[index] ?? "";
		const line = rawLine.trimStart();
		if (line === "" || line.startsWith("#")) continue;

		const exportPrefix = /^export\s+/.exec(line);
		const assignment = exportPrefix
			? line.slice(exportPrefix[0].length).trimStart()
			: line;
		const equals = assignment.indexOf("=");
		if (equals < 1) throw syntaxError(index + 1);

		const key = assignment.slice(0, equals).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) throw syntaxError(index + 1);

		values[key] = parseValue(assignment.slice(equals + 1), index + 1);
	}

	return values;
}

export async function materializeComposeSecrets(
	options: MaterializeOptions,
): Promise<MaterializedSecret[]> {
	const requestedRoot = resolve(options.root);
	if (hasControlCharacters(requestedRoot)) {
		throw new SafeMaterializationError(
			"Repository path contains unsafe characters.",
		);
	}
	const root = await realpath(requestedRoot).catch(() => {
		throw new SafeMaterializationError(
			"Repository root is not a real directory.",
		);
	});
	if (root !== requestedRoot) {
		throw new SafeMaterializationError(
			"Repository root must not traverse a symlink.",
		);
	}

	const envPath = join(root, ".env");
	const env = parseDotenv(await readPrivateRegularFile(envPath, ".env"));
	const openRouterKey = env.OPENROUTER_API_KEY ?? "";
	if (!options.allowBlankOpenRouter && openRouterKey.trim() === "") {
		throw new SafeMaterializationError(
			"OPENROUTER_API_KEY must be nonblank (use --allow-blank-openrouter only for device auth or an intentionally degraded raw start).",
		);
	}

	const runtimeDirectory = join(root, ".runtime");
	const secretDirectory = join(runtimeDirectory, "secrets");
	await ensurePrivateDirectory(runtimeDirectory, ".runtime");
	await ensurePrivateDirectory(secretDirectory, ".runtime/secrets");
	if ((await realpath(secretDirectory)) !== secretDirectory) {
		throw new SafeMaterializationError(
			"Secret directory must not traverse a symlink.",
		);
	}

	const secrets = Object.entries(SECRET_FILES).map(([name, filename]) => ({
		name: name as SecretName,
		path: join(secretDirectory, filename),
		value: env[name] ?? "",
	}));
	for (const secret of secrets)
		await assertSafeDestination(secret.path, secret.name);
	for (const secret of secrets)
		await atomicWrite(secret.path, secret.value, secretDirectory);

	return secrets.map(({ name, path }) => ({ name, path }));
}

function parseValue(raw: string, lineNumber: number): string {
	const value = raw.trimStart();
	if (value === "") return "";
	const quote = value[0];
	if (quote !== '"' && quote !== "'" && quote !== "`") {
		const comment = value.indexOf("#");
		return (comment < 0 ? value : value.slice(0, comment)).trimEnd();
	}

	let result = "";
	let escaped = false;
	for (let index = 1; index < value.length; index += 1) {
		const character = value[index] ?? "";
		if (quote === '"' && escaped) {
			result += decodeDoubleQuotedEscape(character);
			escaped = false;
			continue;
		}
		if (quote === '"' && character === "\\") {
			escaped = true;
			continue;
		}
		if (character === quote) {
			const remainder = value.slice(index + 1).trim();
			if (remainder !== "" && !remainder.startsWith("#"))
				throw syntaxError(lineNumber);
			return result;
		}
		result += character;
	}
	throw syntaxError(lineNumber);
}

function decodeDoubleQuotedEscape(character: string): string {
	switch (character) {
		case "n":
			return "\n";
		case "r":
			return "\r";
		case "t":
			return "\t";
		case '"':
			return '"';
		case "\\":
			return "\\";
		default:
			return `\\${character}`;
	}
}

function syntaxError(lineNumber: number): SafeMaterializationError {
	return new SafeMaterializationError(
		`Invalid dotenv syntax at line ${lineNumber}.`,
	);
}

async function readPrivateRegularFile(
	path: string,
	label: string,
): Promise<string> {
	const metadata = await lstat(path).catch(() => {
		throw new SafeMaterializationError(`${label} is missing.`);
	});
	if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
		throw new SafeMaterializationError(
			`${label} must be one regular, non-linked file.`,
		);
	}
	if ((metadata.mode & 0o077) !== 0) {
		throw new SafeMaterializationError(
			`${label} must not be accessible by group or other users (use mode 0600).`,
		);
	}
	assertCurrentOwner(metadata.uid, label);

	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (
			!opened.isFile() ||
			opened.dev !== metadata.dev ||
			opened.ino !== metadata.ino
		) {
			throw new SafeMaterializationError(
				`${label} changed while it was being opened.`,
			);
		}
		return await handle.readFile({ encoding: "utf8" });
	} catch (error) {
		if (error instanceof SafeMaterializationError) throw error;
		throw new SafeMaterializationError(`${label} could not be read safely.`);
	} finally {
		await handle?.close();
	}
}

async function ensurePrivateDirectory(
	path: string,
	label: string,
): Promise<void> {
	let metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code !== "ENOENT") {
			throw new SafeMaterializationError(
				`${label} could not be inspected safely.`,
			);
		}
		return null;
	});
	if (metadata === null) {
		await mkdir(path, { mode: 0o700 }).catch(() => {
			throw new SafeMaterializationError(
				`${label} could not be created safely.`,
			);
		});
		metadata = await lstat(path);
	}
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new SafeMaterializationError(
			`${label} must be a real directory, not a link.`,
		);
	}
	assertCurrentOwner(metadata.uid, label);
	await chmod(path, 0o700);
}

async function assertSafeDestination(
	path: string,
	label: string,
): Promise<void> {
	const metadata = await lstat(path).catch((error: NodeJS.ErrnoException) => {
		if (error.code === "ENOENT") return null;
		throw new SafeMaterializationError(
			`${label} destination could not be inspected safely.`,
		);
	});
	if (metadata === null) return;
	if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
		throw new SafeMaterializationError(
			`${label} destination is not a safe regular file.`,
		);
	}
	assertCurrentOwner(metadata.uid, `${label} destination`);
}

async function atomicWrite(
	path: string,
	value: string,
	directory: string,
): Promise<void> {
	const temporaryPath = join(
		directory,
		`.${basename(path)}.${process.pid}.${crypto.randomUUID()}.tmp`,
	);
	let handle: FileHandle | undefined;
	try {
		handle = await open(
			temporaryPath,
			constants.O_CREAT |
				constants.O_EXCL |
				constants.O_WRONLY |
				constants.O_NOFOLLOW,
			0o600,
		);
		await handle.writeFile(value, { encoding: "utf8" });
		await handle.chmod(0o600);
		await handle.sync();
		await handle.close();
		handle = undefined;
		if ((await realpath(directory)) !== directory) {
			throw new SafeMaterializationError(
				"Secret directory changed during materialization.",
			);
		}
		await rename(temporaryPath, path);
	} catch (error) {
		if (error instanceof SafeMaterializationError) throw error;
		throw new SafeMaterializationError(
			"A secret file could not be written safely.",
		);
	} finally {
		await handle?.close();
		await rm(temporaryPath, { force: true }).catch(() => undefined);
	}
}

function assertCurrentOwner(owner: number, label: string): void {
	const currentOwner = process.getuid?.();
	if (currentOwner !== undefined && owner !== currentOwner) {
		throw new SafeMaterializationError(
			`${label} must be owned by the current user.`,
		);
	}
}

function hasControlCharacters(value: string): boolean {
	return Array.from(value).some((character) => {
		const codePoint = character.codePointAt(0) ?? 0;
		return codePoint <= 31 || codePoint === 127;
	});
}

async function main(): Promise<void> {
	const arguments_ = process.argv.slice(2);
	const allowBlankOpenRouter = arguments_.includes("--allow-blank-openrouter");
	if (arguments_.some((argument) => argument !== "--allow-blank-openrouter")) {
		throw new SafeMaterializationError(
			"Usage: bun scripts/materialize-compose-secrets.ts [--allow-blank-openrouter]",
		);
	}
	const secrets = await materializeComposeSecrets({
		root: process.cwd(),
		allowBlankOpenRouter,
	});
	console.log("Compose secret directory: .runtime/secrets (mode 0700)");
	for (const secret of secrets) {
		console.log(`${secret.name}: ${basename(secret.path)} (mode 0600)`);
	}
}

if (import.meta.main) {
	main().catch((error: unknown) => {
		const message =
			error instanceof SafeMaterializationError
				? error.message
				: "Compose secret materialization failed safely.";
		console.error(message);
		process.exitCode = 1;
	});
}
