import type {
	BrowserBookingDraft,
	ConversationFactField,
} from "@botamin/contracts";
import { type FormEvent, useEffect, useReducer, useRef, useState } from "react";
import {
	BOOKING_FORM_FIELDS,
	type BookingFormErrors,
	type BookingFormField,
	bookingDetailsPatch,
	bookingDraftFormReducer,
	createBookingDraftFormState,
	validateBookingForm,
} from "../state/bookingDraft";
import type {
	BookingConflictSelection,
	BookingFormSubmission,
	BookingSubmissionState,
} from "./voiceTypes";

const LABELS: Record<BookingFormField, string> = {
	name: "Имя",
	company: "Компания",
	workEmail: "Рабочий email",
	phone: "Телефон",
	telegram: "Telegram",
};

const INPUT_PROPS: Record<
	BookingFormField,
	{
		type: "text" | "email" | "tel";
		autoComplete: string;
		inputMode?: "email" | "tel" | "text";
		maxLength: number;
	}
> = {
	name: { type: "text", autoComplete: "name", maxLength: 120 },
	company: { type: "text", autoComplete: "organization", maxLength: 200 },
	workEmail: {
		type: "email",
		autoComplete: "email",
		inputMode: "email",
		maxLength: 254,
	},
	phone: { type: "tel", autoComplete: "tel", inputMode: "tel", maxLength: 64 },
	telegram: {
		type: "text",
		autoComplete: "off",
		inputMode: "text",
		maxLength: 128,
	},
};

const PENDING_STATUSES = new Set<BookingSubmissionState["status"]>([
	"details-pending",
	"confirmation-pending",
	"conflict-resolution-pending",
]);

interface BookingLocalConflictControlsProps {
	field: BookingFormField;
	serverValue: string;
	submission: BookingSubmissionState;
	onUseServer(): void;
	onKeepLocal(): void;
	useServerRef?(node: HTMLButtonElement | null): void;
}

export function BookingLocalConflictControls({
	field,
	serverValue,
	submission,
	onUseServer,
	onKeepLocal,
	useServerRef,
}: BookingLocalConflictControlsProps) {
	const pending = PENDING_STATUSES.has(submission.status);
	return (
		<div id={`booking-${field}-local-conflict`} className="booking-conflict">
			<p>
				Распознано: <strong>{serverValue}</strong>
			</p>
			<div>
				<button
					ref={useServerRef}
					type="button"
					disabled={pending}
					onClick={onUseServer}
				>
					Использовать распознанное
				</button>
				<button type="button" disabled={pending} onClick={onKeepLocal}>
					Оставить введённое
				</button>
			</div>
		</div>
	);
}

export interface BookingFormProps {
	draft: BrowserBookingDraft;
	submission: BookingSubmissionState;
	available: boolean;
	onSubmit(submission: BookingFormSubmission): boolean;
	onResolveConflict(selection: BookingConflictSelection): boolean;
}

export function formatMoscowCandidate(startAt: string, endAt: string): string {
	const date = new Intl.DateTimeFormat("ru-RU", {
		timeZone: "Europe/Moscow",
		weekday: "long",
		day: "numeric",
		month: "long",
	}).format(new Date(startAt));
	const time = new Intl.DateTimeFormat("ru-RU", {
		timeZone: "Europe/Moscow",
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return `${date}, ${time.format(new Date(startAt))}–${time.format(new Date(endAt))}`;
}

function withoutErrors(
	current: BookingFormErrors,
	...fields: Array<keyof BookingFormErrors>
): BookingFormErrors {
	const next = { ...current };
	for (const field of fields) delete next[field];
	return next;
}

function conflictDescriptionIds(
	field: BookingFormField,
	hasLocalConflict: boolean,
	hasServerConflict: boolean,
): string {
	return [
		`booking-${field}-error`,
		hasLocalConflict ? `booking-${field}-local-conflict` : null,
		hasServerConflict ? `booking-${field}-server-conflict` : null,
	]
		.filter(Boolean)
		.join(" ");
}

export function BookingForm({
	draft,
	submission,
	available,
	onSubmit,
	onResolveConflict,
}: BookingFormProps) {
	const [form, dispatch] = useReducer(
		bookingDraftFormReducer,
		draft,
		createBookingDraftFormState,
	);
	const [errors, setErrors] = useState<BookingFormErrors>({});
	const fieldRefs = useRef<
		Partial<Record<BookingFormField | "candidate", HTMLElement>>
	>({});

	useEffect(() => {
		dispatch({ type: "server.merge", draft, authoritative: true });
	}, [draft]);

	const pending = PENDING_STATUSES.has(submission.status);
	const editField = (field: BookingFormField, value: string) => {
		dispatch({ type: "field.edit", field, value });
		setErrors((current) => withoutErrors(current, field, "form"));
	};
	const focusFirstError = (nextErrors: BookingFormErrors) => {
		const first = [...BOOKING_FORM_FIELDS, "candidate" as const].find(
			(field) => nextErrors[field],
		);
		if (first) fieldRefs.current[first]?.focus();
	};
	const submit = (event: FormEvent<HTMLFormElement>) => {
		event.preventDefault();
		const nextErrors = validateBookingForm(form, draft);
		setErrors(nextErrors);
		if (Object.keys(nextErrors).length > 0) {
			queueMicrotask(() => focusFirstError(nextErrors));
			return;
		}
		const request: BookingFormSubmission = {
			baseRevision: draft.revision,
			details: bookingDetailsPatch(form, draft),
			...(form.selectedCandidateDirty
				? { selectedCandidateId: form.selectedCandidateId }
				: {}),
		};
		if (!onSubmit(request)) {
			setErrors({ form: "Запрос пока не отправлен. Все поля сохранены." });
		}
	};

	return (
		<section
			className="booking-details"
			aria-labelledby="booking-details-title"
		>
			<header className="booking-details-heading">
				<p className="section-index">Следующий шаг</p>
				<h3 id="booking-details-title">Проверьте детали встречи</h3>
				<p>
					Распознанные данные заполняются автоматически. Встреча появится только
					после подтверждения сервером.
				</p>
			</header>
			<form className="booking-details-form" onSubmit={submit} noValidate>
				<div className="booking-fields-grid">
					{BOOKING_FORM_FIELDS.map((field) => {
						const localConflict = form.fields[field].localConflict;
						const serverConflict = draft[field].status === "conflicted";
						const invalid = Boolean(
							errors[field] || localConflict || serverConflict,
						);
						return (
							<div className="booking-field" key={field}>
								<label htmlFor={`booking-${field}`}>
									<span>{LABELS[field]}</span>
								</label>
								<input
									ref={(node) => {
										if (node) fieldRefs.current[field] = node;
									}}
									id={`booking-${field}`}
									name={field}
									required={
										field === "name" ||
										field === "company" ||
										field === "workEmail"
									}
									value={form.fields[field].value}
									aria-invalid={invalid}
									aria-describedby={conflictDescriptionIds(
										field,
										Boolean(localConflict),
										serverConflict,
									)}
									disabled={pending}
									onChange={(event) =>
										editField(field, event.currentTarget.value)
									}
									{...INPUT_PROPS[field]}
								/>
								<p id={`booking-${field}-error`} className="field-error">
									{errors[field] ?? ""}
								</p>
								{localConflict ? (
									<BookingLocalConflictControls
										field={field}
										serverValue={localConflict.serverValue}
										submission={submission}
										useServerRef={(node) => {
											if (node) fieldRefs.current[field] = node;
										}}
										onUseServer={() => {
											dispatch({
												type: "local-conflict.use-server",
												field,
											});
											setErrors((current) => withoutErrors(current, field));
										}}
										onKeepLocal={() => {
											dispatch({
												type: "local-conflict.keep-local",
												field,
											});
											setErrors((current) => withoutErrors(current, field));
										}}
									/>
								) : null}
								{serverConflict ? (
									<div
										id={`booking-${field}-server-conflict`}
										className="booking-conflict"
									>
										<p>Выберите распознанное значение:</p>
										<div>
											{draft[field].conflictOptions.map((option, index) => (
												<button
													ref={(node) => {
														if (index === 0 && node)
															fieldRefs.current[field] = node;
													}}
													key={option.optionId}
													type="button"
													disabled={pending}
													onClick={() => {
														onResolveConflict({
															baseRevision: draft.revision,
															field: field as ConversationFactField,
															conflictOptionId: option.optionId,
														});
													}}
												>
													{String(option.value)}
												</button>
											))}
										</div>
									</div>
								) : null}
							</div>
						);
					})}
				</div>

				<fieldset
					className="booking-slots"
					aria-describedby="booking-candidate-error"
				>
					<legend>Время встречи · Москва</legend>
					{draft.candidates.map((candidate, index) => (
						<label key={candidate.candidateId}>
							<input
								ref={(node) => {
									if (index === 0 && node) fieldRefs.current.candidate = node;
								}}
								type="radio"
								name="meetingCandidate"
								value={candidate.candidateId}
								checked={
									!form.staleCandidate &&
									form.selectedCandidateId === candidate.candidateId
								}
								disabled={pending}
								onChange={() => {
									dispatch({
										type: "candidate.select",
										candidateId: candidate.candidateId,
									});
									setErrors((current) => withoutErrors(current, "candidate"));
								}}
							/>
							<span>
								{formatMoscowCandidate(
									candidate.meetingSlot.startAt,
									candidate.meetingSlot.endAt,
								)}
							</span>
						</label>
					))}
				</fieldset>
				<p id="booking-candidate-error" className="field-error">
					{errors.candidate ?? ""}
				</p>

				<p className="booking-submit-message" role="alert">
					{submission.status === "rejected"
						? submission.message
						: (errors.form ?? "")}
				</p>
				<button
					className="booking-details-submit"
					type="submit"
					disabled={!available || pending}
				>
					{pending ? "Подтверждаем…" : "Подтвердить и создать встречу"}
				</button>
			</form>
		</section>
	);
}
