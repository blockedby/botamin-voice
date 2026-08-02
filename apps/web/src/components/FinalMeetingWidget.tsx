import type { InternalVirtualMeetingProjection } from "@botamin/contracts";
import type { Ref } from "react";

const MOSCOW_TIME_ZONE = "Europe/Moscow";

export interface FormattedMoscowMeeting {
	date: string;
	startTime: string;
	endTime: string;
}

/** Explicit timeZone makes output independent of the browser/host default zone. */
export function formatMoscowMeeting(
	startAt: string,
	endAt: string,
): FormattedMoscowMeeting {
	const dateFormatter = new Intl.DateTimeFormat("ru-RU", {
		timeZone: MOSCOW_TIME_ZONE,
		weekday: "long",
		day: "numeric",
		month: "long",
		year: "numeric",
	});
	const timeFormatter = new Intl.DateTimeFormat("ru-RU", {
		timeZone: MOSCOW_TIME_ZONE,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	});
	return {
		date: dateFormatter.format(new Date(startAt)),
		startTime: timeFormatter.format(new Date(startAt)),
		endTime: timeFormatter.format(new Date(endAt)),
	};
}

function qualificationLabel(meeting: InternalVirtualMeetingProjection): string {
	switch (meeting.qualificationStatus) {
		case "none":
			return "Дополнительный контекст отсутствует — он необязателен";
		case "partial":
			return "Дополнительная квалификация заполнена частично";
		case "complete":
			return "Дополнительная квалификация завершена";
		case "skipped":
			return "Дополнительная квалификация пропущена";
	}
}

const CONTACT_LABELS = {
	email: "Рабочий email",
	phone: "Телефон",
	telegram: "Telegram",
} as const;

export interface FinalMeetingWidgetProps {
	meeting: InternalVirtualMeetingProjection;
	widgetRef?: Ref<HTMLElement>;
}

export function FinalMeetingWidget({
	meeting,
	widgetRef,
}: FinalMeetingWidgetProps) {
	const formatted = formatMoscowMeeting(
		meeting.meetingSlot.startAt,
		meeting.meetingSlot.endAt,
	);
	return (
		<section
			className="final-meeting-widget"
			aria-labelledby="final-meeting-title"
			ref={widgetRef}
			tabIndex={-1}
		>
			<p className="section-index">Внутренняя встреча Botamin</p>
			<h3 id="final-meeting-title">Внутренняя виртуальная встреча создана</h3>
			<dl>
				<div>
					<dt>Дата по Москве</dt>
					<dd>
						<time dateTime={meeting.meetingSlot.startAt}>{formatted.date}</time>
					</dd>
				</div>
				<div>
					<dt>Время по Москве</dt>
					<dd>
						<time dateTime={meeting.meetingSlot.startAt}>
							{formatted.startTime}
						</time>
						{"–"}
						<time dateTime={meeting.meetingSlot.endAt}>
							{formatted.endTime}
						</time>
						{" · 20 минут"}
					</dd>
				</div>
				<div>
					<dt>Участник</dt>
					<dd>{meeting.name}</dd>
				</div>
				<div>
					<dt>Компания</dt>
					<dd>{meeting.company}</dd>
				</div>
				{meeting.contacts.map((contact) => (
					<div key={contact.channel}>
						<dt>{CONTACT_LABELS[contact.channel]}</dt>
						<dd>{contact.value}</dd>
					</div>
				))}
				<div>
					<dt>Квалификация</dt>
					<dd>{qualificationLabel(meeting)}</dd>
				</div>
				{meeting.qualificationFields.monthlyLeadVolume !== null ? (
					<div>
						<dt>Лиды или контакты за месяц</dt>
						<dd>{meeting.qualificationFields.monthlyLeadVolume}</dd>
					</div>
				) : null}
				{meeting.qualificationFields.salesManagerCount !== null ? (
					<div>
						<dt>Менеджеры по продажам</dt>
						<dd>{meeting.qualificationFields.salesManagerCount}</dd>
					</div>
				) : null}
			</dl>
			<p className="final-meeting-truth-note">
				Внутренняя виртуальная встреча создана на указанный точный слот по
				Москве. Внешнее календарное событие и приглашение не создавались.
			</p>
		</section>
	);
}
