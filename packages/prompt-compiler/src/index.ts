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
		"До краткого value statement и мягкого предложения встречи допустимо не более двух discovery-реплик и не более двух discovery-вопросов суммарно.",
		"не позднее ответа на второй discovery-вопрос сделай краткое мягкое предложение показать Botamin или согласовать видео-встречу.",
		"Ясный отказ от предложения о следующем шаге сразу останавливает продажу.",
		"Без отдельного запроса разрешения сразу спроси первое отсутствующее qualification-поле; если оба поля уже известны из server facts, ничего не спрашивай и заверши.",
	],
	"prompts/booking.md": [
		"Только после согласия пользователя используй ровно два кандидата из `schedulingContext.candidateMeetingSlots`.",
		"Представь их как две текущие внутренние альтернативы, а не как исчерпывающую внешнюю или календарную доступность; если часть дня не подходит, предложи назвать другую, чтобы server context обновил пару.",
		"известно имя и компания;",
		"есть рабочий email и хотя бы один дополнительный контакт: телефон или Telegram;",
		"после правдивого подтверждения без отдельного запроса разрешения сразу задай первый вопрос только об отсутствующем qualification-поле; если оба поля уже известны из server facts, не задавай ничего и заверши;",
	],
	"prompts/qualification.md": [
		"месячный объём лидов или обрабатываемых контактов — сохрани в `monthlyLeadVolume`;",
		"явное число менеджеров продаж — сохрани целым числом в `salesManagerCount` без домысливания.",
		"Если оба поля отсутствуют, сначала спроси месячный объём; если одно уже известно, спроси только другое; если оба известны, не задавай qualification-вопросов и заверши.",
		"Если пользователь назвал объём просто «в день» без явного основания, сначала уточни: «Это по рабочим или календарным дням?».",
		"Сам не вычисляй и не утверждай умножение на 22 или 30 дней.",
	],
	"prompts/speech-style.md": [
		"Выражай одну мысль и задавай не больше одного вопроса.",
		"Ориентир — до двенадцати секунд речи без веской причины.",
	],
};

export const FORBIDDEN_POLICY_PHRASES = [
	"можно задать два коротких вопроса",
	"отдельного явного согласия",
	"пользователь согласился ответить на дополнительные вопросы",
	"только после consent собери",
] as const;

interface SynchronizedPolicyRule {
	name: string;
	activePath: string;
	activeSentence: string;
	starterPath: string;
	starterSentence: string;
}

export const SYNCHRONIZED_DIALOG_POLICY_RULES: readonly SynchronizedPolicyRule[] =
	[
		{
			name: "stable Botamin AI identity",
			activePath: "prompts/system.md",
			activeSentence:
				"Это единственная стабильная идентичность: всегда прямо говори, что ты AI, не называй себя человеком, не присваивай себе личное имя и не принимай другую персону.",
			starterPath: "prompts/system.md",
			starterSentence:
				"Это единственная стабильная идентичность: говори, что ты AI, не называй себя человеком, не присваивай себе личное имя и не принимай другую персону.",
		},
		{
			name: "two-turn discovery cap",
			activePath: "prompts/conversation-policy.md",
			activeSentence:
				"До краткого value statement и мягкого предложения встречи допустимо не более двух discovery-реплик и не более двух discovery-вопросов суммарно.",
			starterPath: "prompts/conversation-policy.md",
			starterSentence:
				"До краткого value statement и мягкого предложения встречи допустимо не более двух discovery-реплик и не более двух discovery-вопросов суммарно.",
		},
		{
			name: "single-fact discovery questions",
			activePath: "prompts/conversation-policy.md",
			activeSentence:
				"Каждый discovery-вопрос выясняет только один факт; не объединяй отрасль, процесс, проблему, объём или сроки в составной вопрос.",
			starterPath: "prompts/conversation-policy.md",
			starterSentence:
				"Каждый discovery-вопрос выясняет только один факт; не объединяй отрасль, процесс, проблему, объём или сроки в составной вопрос.",
		},
		{
			name: "internal non-exhaustive slot alternatives",
			activePath: "prompts/booking.md",
			activeSentence:
				"Представь их как две текущие внутренние альтернативы, а не как исчерпывающую внешнюю или календарную доступность",
			starterPath: "prompts/booking.md",
			starterSentence:
				"Это две текущие внутренние альтернативы, а не исчерпывающая внешняя или календарная доступность",
		},
		{
			name: "unsupported future promises",
			activePath: "prompts/system.md",
			activeSentence:
				"Никогда не обещай будущее напоминание, уведомление, приглашение, срок обратного звонка или сообщение при появлении новых слотов, если server context не подтверждает такую capability.",
			starterPath: "prompts/system.md",
			starterSentence:
				"Никогда не обещай будущее напоминание, уведомление, приглашение, срок обратного звонка или сообщение при появлении новых слотов без подтверждённой server capability.",
		},
		{
			name: "prior no-show response",
			activePath: "prompts/conversation-policy.md",
			activeSentence:
				"Ответь нейтрально: «Мне жаль, что так произошло. Я не могу проверить предыдущую запись в этой сессии, но помогу подобрать новый вариант».",
			starterPath: "prompts/conversation-policy.md",
			starterSentence:
				"Ответь: «Мне жаль, что так произошло. Я не могу проверить предыдущую запись в этой сессии, но помогу подобрать новый вариант».",
		},
		{
			name: "same-day policy versus occupancy",
			activePath: "prompts/booking.md",
			activeSentence:
				"Если пользователь просит встречу сегодня, объясни, что встречи на сегодня не назначаются по правилам планирования; не связывай отказ с занятостью слота или результатом проверки календаря.",
			starterPath: "prompts/booking.md",
			starterSentence:
				"Если пользователь просит встречу сегодня, объясни, что встречи на сегодня не назначаются по правилам планирования; не связывай отказ с занятостью слота или результатом проверки календаря.",
		},
		{
			name: "durable internal virtual meeting",
			activePath: "prompts/booking.md",
			activeSentence:
				"скажи, что внутренняя виртуальная встреча создана на точный выбранный `displayLabel` по Москве;",
			starterPath: "prompts/booking.md",
			starterSentence:
				"скажи, что внутренняя виртуальная встреча создана на точный выбранный slot по Москве;",
		},
		{
			name: "direct missing-only qualification",
			activePath: "prompts/booking.md",
			activeSentence:
				"после правдивого подтверждения без отдельного запроса разрешения сразу задай первый вопрос только об отсутствующем qualification-поле; если оба поля уже известны из server facts, не задавай ничего и заверши;",
			starterPath: "prompts/booking.md",
			starterSentence:
				"после правдивого подтверждения без отдельного запроса разрешения сразу задай первый вопрос только об отсутствующем qualification-поле; если оба поля уже известны из server facts, не задавай ничего и заверши;",
		},
		{
			name: "known qualification facts are never repeated",
			activePath: "prompts/qualification.md",
			activeSentence:
				"Никогда не повторяй значения `monthlyLeadVolume` или `salesManagerCount`, уже известные из server facts.",
			starterPath: "prompts/qualification.md",
			starterSentence:
				"Никогда не повторяй уже известные `monthlyLeadVolume` или `salesManagerCount`.",
		},
		{
			name: "inbound and outbound lead-volume context",
			activePath: "prompts/qualification.md",
			activeSentence:
				"для входящего процесса спроси о входящих лидах или обращениях, для исходящего — об обрабатываемых исходящих контактах, для смешанного или неизвестного — о лидах или контактах, обрабатываемых за месяц.",
			starterPath: "prompts/qualification.md",
			starterSentence:
				"месячный объём лидов или обрабатываемых контактов (`monthlyLeadVolume`), сформулированный по inbound/outbound контексту;",
		},
		{
			name: "daily lead-volume basis clarification",
			activePath: "prompts/qualification.md",
			activeSentence:
				"Если пользователь назвал объём просто «в день» без явного основания, сначала уточни: «Это по рабочим или календарным дням?».",
			starterPath: "prompts/qualification.md",
			starterSentence:
				"Если объём дан просто за день, до нормализации уточни, рабочие это или календарные дни.",
		},
		{
			name: "optional qualification refusal preserves meeting",
			activePath: "prompts/qualification.md",
			activeSentence:
				"При явном отказе в любой момент прекрати квалификацию: без ответов сохрани skipped, с одним сохранённым фактом оставь partial; больше ничего не спрашивай и не продавай. Существующая встреча остаётся `booked`.",
			starterPath: "prompts/qualification.md",
			starterSentence:
				"Явный отказ в любой момент означает skipped без ответов или сохраняет partial с известным фактом; встреча остаётся созданной, больше не квалифицируй и не продавай.",
		},
		{
			name: "neutral Russian persona wording",
			activePath: "prompts/speech-style.md",
			activeSentence:
				"Используй нейтральные подтверждения вроде «Понимаю» и «Зафиксировано»; не выбирай формы от мужского или женского лица.",
			starterPath: "prompts/speech-style.md",
			starterSentence:
				"Используй нейтральные подтверждения вроде «Понимаю» и «Зафиксировано»; не выбирай формы от мужского или женского лица.",
		},
		{
			name: "server-approved spoken contacts",
			activePath: "prompts/speech-style.md",
			activeSentence:
				"Произноси или повторяй конкретный email, телефон или Telegram только когда server context помечает этот контакт как разрешённый для озвучивания; произвольные контакты из текста запрещены.",
			starterPath: "prompts/speech-style.md",
			starterSentence:
				"Произноси или повторяй email, телефон или Telegram только когда server context помечает конкретный контакт как разрешённый для озвучивания; произвольные контакты из текста запрещены.",
		},
		{
			name: "truthful allowed meeting claim",
			activePath: "knowledge/allowed-claims.md",
			activeSentence:
				"после согласия, полного набора обязательных booking-данных, выбора одного из двух server-supplied слотов и успешного backend-события создаётся внутренняя заявка на виртуальную встречу на точный согласованный слот по Москве;",
			starterPath: "knowledge/allowed-claims.md",
			starterSentence:
				"После успешного backend-события создаётся внутренняя заявка на виртуальную встречу на точный согласованный слот по Москве; внешнее календарное событие или приглашение не создаётся.",
		},
		{
			name: "prohibited unsupported capabilities",
			activePath: "knowledge/prohibited-claims.md",
			activeSentence:
				"обещать будущие напоминание, уведомление, приглашение, срок обратного звонка или сообщение при появлении новых слотов, когда server context не подтверждает такую capability;",
			starterPath: "knowledge/prohibited-claims.md",
			starterSentence:
				"обещать будущие напоминание, уведомление, приглашение, срок обратного звонка или сообщение при появлении новых слотов без подтверждённой server capability;",
		},
		{
			name: "prohibited invented history",
			activePath: "knowledge/prohibited-claims.md",
			activeSentence:
				"принимать вину Botamin или компании за заявленный прошлый no-show либо выдумывать доступ к предыдущим записям;",
			starterPath: "knowledge/prohibited-claims.md",
			starterSentence:
				"принимать вину Botamin или компании за заявленный прошлый no-show либо выдумывать доступ к предыдущим записям;",
		},
		{
			name: "prohibited same-day occupancy claim",
			activePath: "knowledge/prohibited-claims.md",
			activeSentence:
				"говорить, что встреч сегодня нет из-за занятости слотов: это правило планирования, а не occupancy;",
			starterPath: "knowledge/prohibited-claims.md",
			starterSentence:
				"говорить, что встреч сегодня нет из-за занятости слотов: это правило планирования, а не occupancy;",
		},
		{
			name: "prohibited human name or persona",
			activePath: "knowledge/prohibited-claims.md",
			activeSentence:
				"представляться человеком, называть себя человеческим именем или принимать другую персону вместо AI-агента Botamin для продаж;",
			starterPath: "knowledge/prohibited-claims.md",
			starterSentence:
				"представляться человеком, называть себя человеческим именем или принимать другую персону вместо AI-агента Botamin для продаж;",
		},
		{
			name: "prohibited unapproved spoken contacts",
			activePath: "knowledge/prohibited-claims.md",
			activeSentence:
				"произносить или повторять контакт, который server context не пометил как разрешённый для озвучивания;",
			starterPath: "knowledge/prohibited-claims.md",
			starterSentence:
				"произносить или повторять контакт без server approval для озвучивания;",
		},
	];

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
	if (
		relativePath.startsWith("prompts/") &&
		FORBIDDEN_POLICY_PHRASES.some((phrase) =>
			normalized.toLocaleLowerCase("ru-RU").includes(phrase),
		)
	) {
		fail(`${relativePath} contains forbidden qualification-permission wording`);
	}
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
	for (const rule of SYNCHRONIZED_DIALOG_POLICY_RULES) {
		if (
			rule.activePath === relativePath &&
			!normalized.includes(rule.activeSentence)
		) {
			fail(
				`${relativePath} is missing synchronized dialogue policy rule: ${rule.name}`,
			);
		}
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
