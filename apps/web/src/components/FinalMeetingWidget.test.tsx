/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createInternalMeeting } from "../testFixtures/rc4";
import { FinalMeetingWidget, formatMoscowMeeting } from "./FinalMeetingWidget";

describe("FinalMeetingWidget", () => {
	test("formats Moscow date and time independently of the host timezone", () => {
		const original = process.env.TZ;
		process.env.TZ = "Pacific/Honolulu";
		const hawaii = formatMoscowMeeting(
			"2026-08-03T06:00:00.000Z",
			"2026-08-03T06:20:00.000Z",
		);
		process.env.TZ = "Asia/Tokyo";
		const tokyo = formatMoscowMeeting(
			"2026-08-03T06:00:00.000Z",
			"2026-08-03T06:20:00.000Z",
		);
		if (original === undefined) delete process.env.TZ;
		else process.env.TZ = original;
		expect(tokyo).toEqual(hawaii);
		expect(tokyo.startTime).toBe("09:00");
		expect(tokyo.endTime).toBe("09:20");
		expect(tokyo.date).toContain("3 августа 2026");
	});

	test("renders an accessible section, dl, times, full contacts and exact truth note", () => {
		const html = renderToStaticMarkup(
			<FinalMeetingWidget meeting={createInternalMeeting()} />,
		);
		expect(html).toContain('class="final-meeting-widget"');
		expect(html).toContain('aria-labelledby="final-meeting-title"');
		expect(html).toContain('tabindex="-1"');
		expect(html).toContain("<dl>");
		expect(html.match(/<time/g)?.length).toBe(3);
		expect(html).toContain("Встреча создана");
		expect(html).toContain("09:00");
		expect(html).toContain("09:20");
		expect(html).toContain("20 минут");
		expect(html).toContain("Анна");
		expect(html).toContain("Очень длинное название компании");
		expect(html).toContain("anna.long-contact@example.com");
		expect(html).toContain("+7 999 123-45-67");
		expect(html).toContain("@anna_botamin");
		expect(html).toContain("Квалификация");
		expect(html).toContain(
			"Внутренняя виртуальная встреча Botamin. Внешнее календарное событие и приглашение не создавались.",
		);
		expect(html).not.toContain('aria-live="');
		expect(html).not.toContain('role="status"');
		expect(html).not.toMatch(/join|provider|провайдер|менеджер/iu);
	});
});
