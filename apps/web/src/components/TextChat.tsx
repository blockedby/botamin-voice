import {
	ContactSchema,
	type ConversationStage,
	VISITOR_TEXT_MAX_LENGTH,
} from "@botamin/contracts";
import {
	type FormEvent,
	type KeyboardEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import type { TextSubmissionState } from "./voiceTypes";

const TEXT_TURN_STAGES = new Set<ConversationStage>([
	"GREETING",
	"DISCOVERY",
	"VALUE",
	"OBJECTION",
	"BOOKING_OFFER",
	"COLLECT_BOOKING",
	"BOOKED",
	"POST_BOOKING_QUALIFICATION",
]);

export interface BookingDetailsDraft {
	name: string;
	company: string;
	email: string;
	contactChannel: "phone" | "telegram" | "";
	contactValue: string;
}

type BookingField = keyof BookingDetailsDraft;
type BookingErrors = Partial<Record<BookingField, string>>;

const EMPTY_BOOKING_DETAILS: BookingDetailsDraft = {
	name: "",
	company: "",
	email: "",
	contactChannel: "",
	contactValue: "",
};

export function isComposerSubmitKey(input: {
	key: string;
	shiftKey: boolean;
	isComposing?: boolean;
}): boolean {
	return input.key === "Enter" && !input.shiftKey && !input.isComposing;
}

export function validateBookingDetails(
	draft: BookingDetailsDraft,
): BookingErrors {
	const errors: BookingErrors = {};
	const name = draft.name.trim();
	const company = draft.company.trim();
	const email = draft.email.trim();
	const contactValue = draft.contactValue.trim();
	if (!name || name.length > 120)
		errors.name = "Укажите имя (до 120 символов).";
	if (!company || company.length > 200) {
		errors.company = "Укажите компанию (до 200 символов).";
	}
	if (!ContactSchema.safeParse({ channel: "email", value: email }).success) {
		errors.email = "Укажите корректный рабочий email.";
	}
	if (!draft.contactChannel) {
		errors.contactChannel = "Выберите телефон или Telegram.";
	} else if (
		!ContactSchema.safeParse({
			channel: draft.contactChannel,
			value: contactValue,
		}).success
	) {
		errors.contactValue =
			draft.contactChannel === "phone"
				? "Укажите корректный телефон."
				: "Укажите Telegram-контакт.";
	}
	return errors;
}

/** Serialize UI fields as visitor speech; no tool name, status, or booking claim. */
export function serializeBookingDetails(draft: BookingDetailsDraft): string {
	const contactLabel =
		draft.contactChannel === "phone" ? "Телефон" : "Telegram";
	return [
		"Передаю данные для следующего шага:",
		`Имя: ${draft.name.trim()}`,
		`Компания: ${draft.company.trim()}`,
		`Рабочий email: ${draft.email.trim()}`,
		`${contactLabel}: ${draft.contactValue.trim()}`,
	].join("\n");
}

export interface TextChatProps {
	conversationStage: ConversationStage | null;
	textInputAvailable: boolean;
	textSubmission: TextSubmissionState;
	onTextSubmit(text: string): boolean;
}

function TextComposer({
	textInputAvailable,
	textSubmission,
	onTextSubmit,
}: Omit<TextChatProps, "conversationStage">) {
	const [text, setText] = useState("");
	const [localError, setLocalError] = useState<string | null>(null);
	const submittedText = useRef<string | null>(null);
	const pending = textSubmission.status === "pending";

	useEffect(() => {
		if (textSubmission.status === "rejected") {
			submittedText.current = null;
			return;
		}
		if (
			textSubmission.status === "accepted" &&
			submittedText.current !== null
		) {
			setText("");
			submittedText.current = null;
			setLocalError(null);
		}
	}, [textSubmission]);

	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const normalized = text.trim();
		if (!normalized) {
			setLocalError("Введите сообщение.");
			return;
		}
		if (normalized.length > VISITOR_TEXT_MAX_LENGTH) {
			setLocalError(
				`Сообщение должно быть не длиннее ${VISITOR_TEXT_MAX_LENGTH} символов.`,
			);
			return;
		}
		if (!textInputAvailable || pending || !onTextSubmit(normalized)) {
			setLocalError("Сообщение пока не отправлено. Текст сохранён.");
			return;
		}
		submittedText.current = normalized;
		setLocalError(null);
	};

	const error =
		textSubmission.status === "rejected" ? textSubmission.message : localError;

	return (
		<form className="text-composer" onSubmit={submit}>
			<label htmlFor="visitor-message">Напишите сообщение</label>
			<div className="composer-row">
				<textarea
					id="visitor-message"
					name="visitorMessage"
					rows={2}
					maxLength={VISITOR_TEXT_MAX_LENGTH}
					autoComplete="off"
					enterKeyHint="send"
					value={text}
					disabled={pending}
					aria-describedby="visitor-message-hint visitor-message-error"
					onChange={(event) => {
						setText(event.currentTarget.value);
						setLocalError(null);
					}}
					onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
						if (
							isComposerSubmitKey({
								key: event.key,
								shiftKey: event.shiftKey,
								isComposing: event.nativeEvent.isComposing,
							})
						) {
							event.preventDefault();
							event.currentTarget.form?.requestSubmit();
						}
					}}
				/>
				<button
					className="text-submit"
					type="submit"
					disabled={!textInputAvailable || pending || text.trim().length === 0}
				>
					{pending ? "Отправляем…" : "Отправить"}
				</button>
			</div>
			<p id="visitor-message-hint" className="composer-hint">
				Enter — отправить, Shift+Enter — новая строка.
			</p>
			<p id="visitor-message-error" className="field-error">
				{error ?? ""}
			</p>
		</form>
	);
}

function BookingDetailsForm({
	textInputAvailable,
	textSubmission,
	onTextSubmit,
}: Omit<TextChatProps, "conversationStage">) {
	const [draft, setDraft] = useState(EMPTY_BOOKING_DETAILS);
	const [errors, setErrors] = useState<BookingErrors>({});
	const fieldRefs = {
		name: useRef<HTMLInputElement>(null),
		company: useRef<HTMLInputElement>(null),
		email: useRef<HTMLInputElement>(null),
		contactChannel: useRef<HTMLInputElement>(null),
		contactValue: useRef<HTMLInputElement>(null),
	};
	const pending = textSubmission.status === "pending";
	const update = <Field extends BookingField>(
		field: Field,
		value: BookingDetailsDraft[Field],
	) => {
		setDraft((current) => ({ ...current, [field]: value }));
		setErrors((current) => ({ ...current, [field]: undefined }));
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextErrors = validateBookingDetails(draft);
		setErrors(nextErrors);
		const firstError = (
			["name", "company", "email", "contactChannel", "contactValue"] as const
		).find((field) => nextErrors[field]);
		if (firstError) {
			fieldRefs[firstError].current?.focus();
			return;
		}
		const text = serializeBookingDetails(draft);
		if (text.length > VISITOR_TEXT_MAX_LENGTH || !onTextSubmit(text)) {
			setErrors({
				contactValue: "Данные пока не отправлены. Все поля сохранены.",
			});
		}
	};

	return (
		<section
			className="booking-details"
			aria-labelledby="booking-details-title"
		>
			<div className="booking-details-heading">
				<p className="section-index">Следующий шаг</p>
				<h3 id="booking-details-title">Передайте детали в разговор</h3>
				<p>
					Агент проверит данные и сам решит, можно ли создать запись. Форма не
					подтверждает встречу.
				</p>
			</div>
			<form className="booking-details-form" onSubmit={submit} noValidate>
				<div className="booking-fields-grid">
					<label>
						<span>Имя</span>
						<input
							ref={fieldRefs.name}
							name="name"
							type="text"
							autoComplete="name"
							maxLength={120}
							required
							value={draft.name}
							aria-invalid={Boolean(errors.name)}
							aria-describedby="booking-name-error"
							onChange={(event) => update("name", event.currentTarget.value)}
						/>
						<small id="booking-name-error">{errors.name ?? ""}</small>
					</label>
					<label>
						<span>Компания</span>
						<input
							ref={fieldRefs.company}
							name="organization"
							type="text"
							autoComplete="organization"
							maxLength={200}
							required
							value={draft.company}
							aria-invalid={Boolean(errors.company)}
							aria-describedby="booking-company-error"
							onChange={(event) => update("company", event.currentTarget.value)}
						/>
						<small id="booking-company-error">{errors.company ?? ""}</small>
					</label>
				</div>
				<label>
					<span>Рабочий email</span>
					<input
						ref={fieldRefs.email}
						name="email"
						type="email"
						inputMode="email"
						autoComplete="email"
						maxLength={254}
						required
						value={draft.email}
						aria-invalid={Boolean(errors.email)}
						aria-describedby="booking-email-error"
						onChange={(event) => update("email", event.currentTarget.value)}
					/>
					<small id="booking-email-error">{errors.email ?? ""}</small>
				</label>
				<fieldset className="contact-channel">
					<legend>Дополнительный контакт</legend>
					<div>
						<label>
							<input
								ref={fieldRefs.contactChannel}
								type="radio"
								name="contactChannel"
								value="phone"
								checked={draft.contactChannel === "phone"}
								aria-invalid={Boolean(errors.contactChannel)}
								aria-describedby="booking-contact-channel-error"
								onChange={() => {
									update("contactChannel", "phone");
									update("contactValue", "");
								}}
							/>
							Телефон
						</label>
						<label>
							<input
								type="radio"
								name="contactChannel"
								value="telegram"
								checked={draft.contactChannel === "telegram"}
								aria-invalid={Boolean(errors.contactChannel)}
								aria-describedby="booking-contact-channel-error"
								onChange={() => {
									update("contactChannel", "telegram");
									update("contactValue", "");
								}}
							/>
							Telegram
						</label>
					</div>
					<small id="booking-contact-channel-error">
						{errors.contactChannel ?? ""}
					</small>
				</fieldset>
				{draft.contactChannel ? (
					<label className="revealed-contact">
						<span>
							{draft.contactChannel === "phone" ? "Телефон" : "Telegram"}
						</span>
						<input
							ref={fieldRefs.contactValue}
							name={draft.contactChannel}
							type={draft.contactChannel === "phone" ? "tel" : "text"}
							inputMode={draft.contactChannel === "phone" ? "tel" : "text"}
							autoComplete={draft.contactChannel === "phone" ? "tel" : "off"}
							maxLength={draft.contactChannel === "phone" ? 64 : 128}
							required
							value={draft.contactValue}
							aria-invalid={Boolean(errors.contactValue)}
							aria-describedby="booking-contact-error"
							onChange={(event) =>
								update("contactValue", event.currentTarget.value)
							}
						/>
						<small id="booking-contact-error">
							{errors.contactValue ?? ""}
						</small>
					</label>
				) : null}
				{textSubmission.status === "rejected" ? (
					<p className="field-error">{textSubmission.message}</p>
				) : null}
				<button
					className="booking-details-submit"
					type="submit"
					disabled={!textInputAvailable || pending}
				>
					{pending ? "Передаём данные…" : "Передать данные агенту"}
				</button>
			</form>
		</section>
	);
}

export function TextChat(props: TextChatProps) {
	if (
		props.conversationStage === null ||
		!TEXT_TURN_STAGES.has(props.conversationStage)
	) {
		return null;
	}
	return (
		<div className="text-chat">
			{props.conversationStage === "COLLECT_BOOKING" ? (
				<BookingDetailsForm {...props} />
			) : null}
			<TextComposer {...props} />
		</div>
	);
}
