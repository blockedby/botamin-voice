/// <reference types="bun" />

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { isCompleteMp3File } from "@botamin/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import {
	type GreetingAudioLike,
	PROACTIVE_GREETING_AUDIO_PATH,
	PROACTIVE_GREETING_COPY,
	ProactiveGreeting,
	ProactiveGreetingController,
} from "./ProactiveGreeting";

class FakeAudio implements GreetingAudioLike {
	preload = "none";
	currentTime = 7;
	playCalls = 0;
	pauseCalls = 0;
	loadCalls = 0;
	removedSources = 0;
	private readonly listeners = {
		ended: new Set<() => void>(),
		error: new Set<() => void>(),
	};

	constructor(private readonly playResult: () => Promise<void>) {}

	play(): Promise<void> {
		this.playCalls += 1;
		return this.playResult();
	}

	pause(): void {
		this.pauseCalls += 1;
	}

	load(): void {
		this.loadCalls += 1;
	}

	removeAttribute(name: "src"): void {
		expect(name).toBe("src");
		this.removedSources += 1;
	}

	addEventListener(type: "ended" | "error", listener: () => void): void {
		this.listeners[type].add(listener);
	}

	removeEventListener(type: "ended" | "error", listener: () => void): void {
		this.listeners[type].delete(listener);
	}

	emit(type: "ended" | "error"): void {
		for (const listener of [...this.listeners[type]]) listener();
	}
}

function immediateScheduler() {
	let scheduled: (() => void) | null = null;
	return {
		schedule(release: () => void): () => void {
			scheduled = release;
			return () => {
				scheduled = null;
			};
		},
		run(): void {
			const release = scheduled;
			scheduled = null;
			release?.();
		},
		get pending(): boolean {
			return scheduled !== null;
		},
	};
}

describe("proactive static greeting asset", () => {
	test("keeps concise Botamin identity copy with exactly one business question", () => {
		expect(PROACTIVE_GREETING_COPY).toBe(
			"Здравствуйте! Я голосовой AI-консультант Botamin. Чем занимается ваша компания? Подтвердите условия, и начнём.",
		);
		expect(PROACTIVE_GREETING_COPY.match(/\?/gu)).toHaveLength(1);
		expect(
			PROACTIVE_GREETING_COPY.trim().split(/\s+/u).length,
		).toBeLessThanOrEqual(22);
	});

	test("ships one bounded complete product-owned MP3", async () => {
		const file = Bun.file(
			resolve(
				import.meta.dir,
				"../../public/assets/botamin-proactive-greeting.mp3",
			),
		);
		const bytes = new Uint8Array(await file.arrayBuffer());
		expect(bytes.byteLength).toBeGreaterThan(0);
		expect(bytes.byteLength).toBeLessThanOrEqual(2_000_000);
		expect(isCompleteMp3File(bytes)).toBe(true);
	});
});

describe("proactive static greeting lifecycle", () => {
	test("automatically attempts the fixed same-origin MP3 once without conversation, network, socket, or microphone capabilities", async () => {
		const sources: string[] = [];
		const audio = new FakeAudio(async () => undefined);
		const controller = new ProactiveGreetingController((source) => {
			sources.push(source);
			return audio;
		});

		expect(await controller.start()).toBe(true);
		expect(await controller.start()).toBe(false);
		expect(controller.snapshot).toBe("played");
		expect(sources).toEqual([PROACTIVE_GREETING_AUDIO_PATH]);
		expect(audio.preload).toBe("auto");
		expect(audio.playCalls).toBe(1);
	});

	test("shows the blocked state and retries only from a user action", async () => {
		const blockedError = new Error("autoplay blocked");
		blockedError.name = "NotAllowedError";
		const first = new FakeAudio(async () => {
			throw blockedError;
		});
		let allowRetry: (() => void) | undefined;
		const second = new FakeAudio(
			() =>
				new Promise<void>((resolve) => {
					allowRetry = resolve;
				}),
		);
		const audios = [first, second];
		const controller = new ProactiveGreetingController(() => {
			const audio = audios.shift();
			if (!audio) throw new Error("unexpected extra audio attempt");
			return audio;
		});

		expect(await controller.start()).toBe(false);
		expect(controller.snapshot).toBe("blocked");
		expect(first.pauseCalls).toBe(0);
		expect(first.removedSources).toBe(0);

		const retrying = controller.retry();
		expect(controller.snapshot).toBe("retrying");
		allowRetry?.();
		expect(await retrying).toBe(true);
		expect(controller.snapshot).toBe("played");
		expect(second.playCalls).toBe(1);
	});

	test("turns a media error into the available fallback without claiming playback", async () => {
		let settlePlay: (() => void) | undefined;
		const audio = new FakeAudio(
			() =>
				new Promise<void>((resolve) => {
					settlePlay = resolve;
				}),
		);
		const controller = new ProactiveGreetingController(() => audio);
		const starting = controller.start();
		audio.emit("error");
		expect(controller.snapshot).toBe("unavailable");
		settlePlay?.();
		expect(await starting).toBe(false);
		expect(controller.snapshot).toBe("unavailable");
		expect(audio.pauseCalls).toBe(0);
	});

	test("does not replay across rerenders or StrictMode-style resubscription and releases on final unmount", async () => {
		const scheduler = immediateScheduler();
		const audio = new FakeAudio(async () => undefined);
		let factoryCalls = 0;
		const controller = new ProactiveGreetingController(() => {
			factoryCalls += 1;
			return audio;
		}, scheduler.schedule);
		const unsubscribe = controller.subscribe(() => undefined);
		expect(await controller.start()).toBe(true);

		unsubscribe();
		expect(scheduler.pending).toBe(true);
		const finalUnsubscribe = controller.subscribe(() => undefined);
		expect(scheduler.pending).toBe(false);
		expect(await controller.start()).toBe(false);
		expect(factoryCalls).toBe(1);
		expect(audio.pauseCalls).toBe(0);

		finalUnsubscribe();
		scheduler.run();
		expect(controller.snapshot).toBe("stopped");
		expect(audio.pauseCalls).toBe(1);
		expect(audio.currentTime).toBe(0);
		expect(audio.loadCalls).toBe(1);
		expect(audio.removedSources).toBe(1);
	});

	test("immediately stops and releases audio when a real session starts", async () => {
		const audio = new FakeAudio(async () => undefined);
		const controller = new ProactiveGreetingController(() => audio);
		expect(await controller.start()).toBe(true);
		controller.stop();
		expect(controller.snapshot).toBe("stopped");
		expect(audio.pauseCalls).toBe(1);
		expect(audio.currentTime).toBe(0);
		expect(await controller.retry()).toBe(false);
	});
});

describe("ProactiveGreeting accessibility and states", () => {
	test("renders the fixed copy and a non-live truthful loading state", () => {
		const html = renderToStaticMarkup(
			<ProactiveGreeting status="loading" onRetry={() => undefined} />,
		);
		expect(html).toContain(PROACTIVE_GREETING_COPY);
		expect(html).toContain("Подготавливаем звук…");
		expect(html).toContain('aria-live="off"');
		expect(html).not.toContain("Включить приветствие");
		expect(html).not.toContain("приветствие прозвучало");
	});

	test("renders the named native fallback button only after autoplay is blocked", () => {
		const blocked = renderToStaticMarkup(
			<ProactiveGreeting status="blocked" onRetry={() => undefined} />,
		);
		const played = renderToStaticMarkup(
			<ProactiveGreeting status="played" onRetry={() => undefined} />,
		);
		expect(blocked).toContain("Браузер не включил звук автоматически");
		expect(blocked).toContain("Включить приветствие");
		expect(blocked).toContain('type="button"');
		expect(blocked).not.toContain('aria-live="polite"');
		const retrying = renderToStaticMarkup(
			<ProactiveGreeting status="retrying" onRetry={() => undefined} />,
		);
		expect(retrying).toContain("Включить приветствие");
		expect(retrying).toContain("Пробуем включить звук…");
		expect(retrying).toContain('aria-busy="true"');
		const unavailable = renderToStaticMarkup(
			<ProactiveGreeting status="unavailable" onRetry={() => undefined} />,
		);
		expect(unavailable).toContain("Включить приветствие");
		expect(unavailable).toContain("Не удалось загрузить приветствие");
		expect(unavailable).not.toContain("звук автоматически");
		expect(played).not.toContain("Включить приветствие");
		expect(played).not.toContain("Подготавливаем звук");
	});
});
