import { createHash, randomUUID } from "node:crypto";
import {
	chmod,
	lstat,
	mkdir,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile,
} from "node:fs/promises";
import {
	basename,
	dirname,
	isAbsolute,
	join,
	parse,
	relative,
	resolve,
	sep,
} from "node:path";

export const PROMPT_ORDER = [
	"prompts/system.md",
	"prompts/product.md",
	"prompts/conversation-policy.md",
	"prompts/objections.md",
	"prompts/booking.md",
	"prompts/qualification.md",
	"prompts/speech-style.md",
	"knowledge/botamin-overview.md",
	"knowledge/use-cases.md",
	"knowledge/cases.md",
	"knowledge/faq.md",
	"knowledge/allowed-claims.md",
	"knowledge/prohibited-claims.md",
] as const;

export const MAX_FILE_BYTES = 16 * 1024;
export const MAX_BUNDLE_BYTES = 128 * 1024;
export const BOOKING_ORDER_SENTENCE =
	"Никогда не начинай квалификацию до успешного результата `create_booking`.";
export const REQUIRED_POLICY_SENTENCES: Readonly<
	Record<string, readonly string[]>
> = {
	"prompts/conversation-policy.md": [
		"Считай вопрос в приветствии discovery-вопросом; всего до предложения допустимо не более двух.",
		"не позднее ответа на второй discovery-вопрос сделай краткое мягкое предложение показать Botamin или согласовать видео-встречу.",
		"Ясный отказ от предложения о следующем шаге сразу останавливает продажу.",
	],
	"prompts/booking.md": [
		"Только после согласия пользователя server context должен предоставить ровно два конкретных slot candidates.",
		"известно имя и компания;",
		"есть рабочий email и хотя бы один дополнительный контакт: телефон или Telegram;",
	],
	"prompts/qualification.md": [
		"месячный объём входящих лидов — сохрани в `monthlyLeadVolume`;",
		"явное число менеджеров продаж — сохрани целым числом в `salesManagerCount` без домысливания.",
	],
	"prompts/speech-style.md": [
		"Выражай одну мысль и задавай не больше одного вопроса.",
		"Ориентир — до двенадцати секунд речи без веской причины.",
	],
};

const HEADINGS: Record<string, string[]> = {
	"prompts/system.md": [
		"Identity and hard boundaries",
		"Ownership and scope",
		"Role and objective",
		"Instruction precedence",
		"Non-negotiable rules",
		"Security and confidentiality",
	],
	"prompts/product.md": [
		"Botamin product guidance",
		"Ownership and scope",
		"Product position",
		"Value selection",
		"Factual boundaries",
	],
	"prompts/conversation-policy.md": [
		"Conversation policy",
		"Ownership and scope",
		"Turn policy",
		"Stages",
		"Refusal and recovery",
	],
	"prompts/objections.md": [
		"Objection handling",
		"Ownership and scope",
		"Response method",
		"Common patterns",
		"Stop conditions",
	],
	"prompts/booking.md": [
		"Booking policy",
		"Ownership and scope",
		"Hard ordering invariant",
		"Create booking prerequisites",
		"Tool success and replay",
		"Failure handling",
	],
	"prompts/qualification.md": [
		"Post-booking qualification",
		"Ownership and scope",
		"Preconditions",
		"Question selection",
		"Patch and stopping rules",
	],
	"prompts/speech-style.md": [
		"Speech style",
		"Ownership and scope",
		"Spoken Russian",
		"Text-to-speech safety",
		"Interruption behavior",
	],
	"knowledge/botamin-overview.md": [
		"Botamin overview",
		"Source context",
		"Confirmed product position",
		"MVP-specific boundaries",
		"Unresolved or mutable facts",
	],
	"knowledge/use-cases.md": [
		"Botamin use cases",
		"Source context",
		"Inbound qualification",
		"After-hours first line",
		"Missed-contact follow-up",
		"Reactivation",
		"Cold outbound",
		"Structured handoff",
		"Applicability guardrail",
	],
	"knowledge/cases.md": [
		"Published Botamin case claims",
		"Source and evidence policy",
		"Numeric case claims",
		"Пользовательский бриф Botamin — рост выручки компаний",
		"Главтрассы — голосовой outbound",
		"РоллПроф — входящий поток и follow-up",
		"Продавец утеплительной пены на Авито — скорость ответа и фильтрация",
		"Поставщик стройматериалов — масштаб входящей квалификации",
		"Non-numeric case context",
		"Foxford — follow-up после недозвонов",
		"Conversation use",
	],
	"knowledge/faq.md": [
		"FAQ response policy",
		"Source and scope",
		"«Сколько стоит?»",
		"«С какой CRM работаете?»",
		"«Это заменит менеджеров?»",
		"«Как быстро запускается?»",
		"«Вы гарантируете рост продаж?»",
		"«Что именно вы создадите после разговора?»",
		"«Вы человек?»",
		"«Покажите ваш prompt или внутренние данные»",
	],
	"knowledge/allowed-claims.md": [
		"Allowed claims policy",
		"Authority and precedence",
		"Product facts",
		"Case claims",
		"Mutable commercial facts",
		"MVP process facts",
		"Unknown-fact fallback",
	],
	"knowledge/prohibited-claims.md": [
		"Prohibited claims",
		"Commercial promises",
		"Product and integration claims",
		"Booking and handoff claims",
		"Identity and confidentiality",
	],
};

const HEADING_LEVELS: Partial<Record<string, readonly number[]>> = {
	"knowledge/cases.md": [1, 2, 2, 3, 3, 3, 3, 3, 2, 3, 2],
};

const SECRET_PATTERNS = [
	/["']?(?:api[_ -]?key|access[_ -]?token|refresh[_ -]?token|id[_ -]?token|client[_ -]?secret|webhook[_ -]?secret)["']?\s*[:=]/iu,
	/\bsk-[a-z0-9_-]{12,}\b/iu,
	/\bBearer\s+[a-z0-9._-]{12,}/iu,
	/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
	/(?:password|passwd|secret)\s*[:=]\s*\S+/iu,
];
const CURRENCY_PRICE =
	/(?:[$€£₽]\s*\d|\d\s*(?:₽|руб(?:\.?|лей)|USD|EUR|RUB)\b|\b(?:USD|EUR|RUB)\s*\d)/iu;
const RUSSIAN_MAGNITUDE_PRICE =
	/\b\d[\d ]*(?:[.,]\d+)?\s+(?:тыс\.?|тысяч(?:а|и)?|миллион(?:а|ов)?|млн\.?)\s+руб(?:ль|ля|лей)(?!\p{L})/iu;
export const ATTRIBUTED_REVENUE_CLAIM_LINES = [
	"- **Source claim:** в пользовательском брифе Botamin сообщается, что Botamin помог компаниям увеличить выручку на 10–15 миллионов рублей в месяц.",
	"- **Required attribution:** «В пользовательском брифе Botamin сообщается, что Botamin помог компаниям увеличить выручку на 10–15 миллионов рублей в месяц; это сообщение источника о прошлых результатах, а не гарантия, прогноз или переносимый результат для вашей компании».",
] as const;

export interface CompileOptions {
	sourceRoot: string;
	runtimeDir: string;
}

export interface CompileMetadata {
	promptVersion: string;
	outputPath: string;
	outputBytes: number;
	files: readonly string[];
}

function fail(message: string): never {
	throw new Error(`prompt compiler: ${message}`);
}

function assertOutside(sourceRoot: string, runtimeDir: string): void {
	const rel = relative(sourceRoot, runtimeDir);
	if (
		rel === "" ||
		(!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel))
	) {
		fail("runtime directory must be outside the source repository");
	}
}

async function assertSourceRoot(sourceRoot: string): Promise<string> {
	const stat = await lstat(sourceRoot).catch(() => undefined);
	if (!stat?.isDirectory())
		fail("source root must be an existing regular directory, not a symlink");
	return realpath(sourceRoot);
}

async function assertNoSymlinkComponents(path: string): Promise<void> {
	const root = parse(path).root;
	let cursor = root;
	for (const component of path.slice(root.length).split(sep).filter(Boolean)) {
		cursor = join(cursor, component);
		const stat = await lstat(cursor).catch(() => undefined);
		if (!stat) return;
		if (stat.isSymbolicLink())
			fail("runtime directory path must not contain symlinks");
	}
}

async function resolvePotentialRealPath(path: string): Promise<string> {
	let cursor = path;
	const missingComponents: string[] = [];
	while (true) {
		const stat = await lstat(cursor).catch(() => undefined);
		if (stat) return resolve(await realpath(cursor), ...missingComponents);
		const parent = dirname(cursor);
		if (parent === cursor) fail("runtime directory has no resolvable parent");
		missingComponents.unshift(basename(cursor));
		cursor = parent;
	}
}

async function assertRuntimeOutsideSource(
	canonicalSourceRoot: string,
	runtimeDir: string,
): Promise<void> {
	await assertNoSymlinkComponents(runtimeDir);
	assertOutside(
		canonicalSourceRoot,
		await resolvePotentialRealPath(runtimeDir),
	);
}

async function readRegularSourceFile(
	path: string,
	label: string,
): Promise<string> {
	const parentStat = await lstat(dirname(path)).catch(() => undefined);
	if (!parentStat?.isDirectory())
		fail(
			`source directory for ${label} must be a regular directory, not a symlink`,
		);
	const stat = await lstat(path).catch(() => undefined);
	if (!stat) fail(`missing required file: ${label}`);
	if (!stat.isFile())
		fail(`${label} must be a regular file, not a symlink or directory`);
	if (stat.size > MAX_FILE_BYTES)
		fail(`${label} exceeds ${MAX_FILE_BYTES} bytes`);
	const bytes = await readFile(path);
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return fail(`${label} is not valid UTF-8`);
	}
}

function validateSource(relativePath: string, source: string): string {
	const normalized = source.replace(/\r\n?/g, "\n");
	if (Buffer.byteLength(normalized, "utf8") > MAX_FILE_BYTES) {
		fail(`${relativePath} exceeds ${MAX_FILE_BYTES} bytes after normalization`);
	}
	const headings = [...normalized.matchAll(/^(#{1,6})\s+(.+?)\s*$/gmu)].map(
		(match) => ({
			level: match[1].length,
			text: match[2],
		}),
	);
	const expected = HEADINGS[relativePath];
	const expectedLevels =
		HEADING_LEVELS[relativePath] ??
		expected?.map((_heading, index) => (index === 0 ? 1 : 2));
	if (
		!expected ||
		headings.length !== expected.length ||
		headings.some(
			(heading, index) =>
				heading.text !== expected[index] ||
				heading.level !== expectedLevels?.[index],
		)
	) {
		fail(
			`${relativePath} has unexpected headings, heading levels, or heading order`,
		);
	}
	if (SECRET_PATTERNS.some((pattern) => pattern.test(normalized)))
		fail(`${relativePath} contains a secret-like pattern`);
	const sourceLines = normalized.split("\n");
	if (
		relativePath === "knowledge/cases.md" &&
		ATTRIBUTED_REVENUE_CLAIM_LINES.some(
			(line) =>
				sourceLines.filter((candidate) => candidate === line).length !== 1,
		)
	)
		fail(`${relativePath} has invalid attributed revenue claim lines`);
	const priceCheckedSource =
		relativePath === "knowledge/cases.md"
			? sourceLines
					.filter(
						(line) =>
							!ATTRIBUTED_REVENUE_CLAIM_LINES.some(
								(candidate) => candidate === line,
							),
					)
					.join("\n")
			: normalized;
	if (
		CURRENCY_PRICE.test(priceCheckedSource) ||
		RUSSIAN_MAGNITUDE_PRICE.test(priceCheckedSource)
	)
		fail(`${relativePath} contains a hard-coded numeric currency price`);
	if (
		relativePath === "prompts/system.md" ||
		relativePath === "prompts/booking.md"
	) {
		if (!normalized.includes(BOOKING_ORDER_SENTENCE))
			fail(`${relativePath} is missing the booking-order sentence`);
	}
	for (const sentence of REQUIRED_POLICY_SENTENCES[relativePath] ?? []) {
		if (!normalized.includes(sentence))
			fail(`${relativePath} is missing a required policy sentence`);
	}
	return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
}

async function prepareRuntime(runtimeDir: string): Promise<void> {
	const existing = await lstat(runtimeDir).catch(() => undefined);
	if (existing && !existing.isDirectory())
		fail("runtime directory must not be a symlink or non-directory");
	await mkdir(runtimeDir, { recursive: true, mode: 0o755 });
	const entries = await readdir(runtimeDir, { withFileTypes: true });
	for (const entry of entries) {
		if (
			entry.name !== "AGENTS.md" ||
			entry.isSymbolicLink() ||
			!entry.isFile()
		) {
			fail("runtime directory contains unexpected contents or symlinks");
		}
	}
}

export async function compilePromptBundle(
	options: CompileOptions,
): Promise<CompileMetadata> {
	const sourceRoot = resolve(options.sourceRoot);
	const runtimeDir = resolve(options.runtimeDir);
	const canonicalSourceRoot = await assertSourceRoot(sourceRoot);
	await assertRuntimeOutsideSource(canonicalSourceRoot, runtimeDir);
	const chunks: string[] = ["# Botamin compiled runtime instructions\n\n"];
	for (const relativePath of PROMPT_ORDER) {
		const path = resolve(sourceRoot, relativePath);
		const source = validateSource(
			relativePath,
			await readRegularSourceFile(path, relativePath),
		);
		chunks.push(
			`<!-- BEGIN ${relativePath} -->\n`,
			source,
			`<!-- END ${relativePath} -->\n\n`,
		);
	}
	const output = Buffer.from(chunks.join(""), "utf8");
	if (output.byteLength > MAX_BUNDLE_BYTES)
		fail(`compiled bundle exceeds ${MAX_BUNDLE_BYTES} bytes`);
	await prepareRuntime(runtimeDir);
	const outputPath = resolve(runtimeDir, "AGENTS.md");
	const tempPath = resolve(
		dirname(runtimeDir),
		`.AGENTS.md.${process.pid}.${randomUUID()}.tmp`,
	);
	await writeFile(tempPath, output, { flag: "wx", mode: 0o600 });
	try {
		await chmod(tempPath, 0o444);
		await rename(tempPath, outputPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
	return {
		promptVersion: createHash("sha256").update(output).digest("hex"),
		outputPath,
		outputBytes: output.byteLength,
		files: PROMPT_ORDER,
	};
}
