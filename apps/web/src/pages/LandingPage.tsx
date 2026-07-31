import type { VoiceDemoProps } from "../components/VoiceDemo";
import { VoiceDemo } from "../components/VoiceDemo";

export interface LandingPageProps {
	voice: VoiceDemoProps;
}

const scenarios = [
	{
		number: "01",
		title: "Обрабатывать входящие 24/7",
		text: "Подхватывать запросы ночью и в выходные, пока интерес лида ещё высокий.",
	},
	{
		number: "02",
		title: "Квалифицировать и передавать только целевые лиды",
		text: "Уточнять задачу и передавать менеджеру структурированный контекст вместо сырого обращения.",
	},
	{
		number: "03",
		title: "Реактивировать недозвоны и холодные базы",
		text: "Возвращаться к пропущенным контактам и системно выходить на следующий шаг.",
	},
] as const;

const cases = [
	{
		result: "15%",
		context: "в квалифицированный лид",
		name: "«Главтрассы» · голосовой outbound",
		detail: "Выход на ЛПР, резюме и транскрипция для передачи тёплого лида.",
	},
	{
		result: "13%",
		context: "доведены до реального интереса",
		name: "РоллПроф · входящий поток и follow-up",
		detail: "Работа 24/7 и возврат к тем, кому менеджер не дозвонился.",
	},
	{
		result: "10 → 45%",
		context: "рост конверсии по публикации",
		name: "Продавец утеплительной пены · Авито",
		detail: "Скорость первого ответа и фильтрация нецелевых обращений.",
	},
] as const;

export function LandingPage({ voice }: LandingPageProps) {
	return (
		<div className="site-shell">
			<a className="skip-link" href="#voice-demo-title">
				К голосовому демо
			</a>
			<header className="site-header">
				<a
					className="wordmark"
					href="#top"
					aria-label="Botamin — в начало страницы"
				>
					Botamin
				</a>
				<nav aria-label="Разделы страницы">
					<a href="#scenarios">Сценарии</a>
					<a href="#process">Процесс</a>
					<a href="#cases">Кейсы</a>
				</nav>
				<span className="header-note">голосовой sales demo</span>
			</header>

			<main className="landing-page" id="top">
				<section className="hero" aria-labelledby="hero-title">
					<div className="hero-copy">
						<p className="section-index">Botamin · AI-первая линия продаж</p>
						<h1 id="hero-title">
							AI-продавец, который сам покажет, как перестать терять лиды
						</h1>
						<p className="hero-lead">
							Поговорите с голосовым агентом Botamin. Он разберёт ваш процесс,
							покажет релевантный сценарий и зафиксирует следующий шаг.
						</p>
						<aside className="hero-prompt" aria-label="Что обсудить в демо">
							<span aria-hidden="true">“</span>
							<p>
								Расскажите, где сейчас теряются лиды: в скорости ответа,
								квалификации, недозвонах или работе с базой.
							</p>
						</aside>
					</div>
					<div className="hero-demo">
						<VoiceDemo {...voice} />
					</div>
				</section>

				<section
					className="scenario-section"
					id="scenarios"
					aria-labelledby="scenario-title"
				>
					<div className="section-heading">
						<p className="section-index">Три сценария</p>
						<h2 id="scenario-title">
							Первая линия, которая не ждёт рабочего дня
						</h2>
						<p>
							Botamin берёт повторяемый первый контакт, а менеджер получает уже
							понятную задачу и контекст.
						</p>
					</div>
					<ol className="scenario-list">
						{scenarios.map((scenario) => (
							<li key={scenario.number}>
								<span>{scenario.number}</span>
								<div>
									<h3>{scenario.title}</h3>
									<p>{scenario.text}</p>
								</div>
							</li>
						))}
					</ol>
				</section>

				<section
					className="process-section"
					id="process"
					aria-labelledby="process-title"
				>
					<div className="section-heading is-light">
						<p className="section-index">Как это работает</p>
						<h2 id="process-title">От первого сигнала до понятного handoff</h2>
					</div>
					<ol className="process-flow" aria-label="Процесс Botamin">
						{[
							"Источник",
							"AI-первая линия",
							"Квалификация",
							"Структурированный handoff",
							"Менеджер",
						].map((step, index) => (
							<li key={step}>
								<span>{String(index + 1).padStart(2, "0")}</span>
								<strong>{step}</strong>
							</li>
						))}
					</ol>
					<p className="process-note">
						Сценарий опирается на базу знаний, задаёт по одному вопросу и
						передаёт результат человеку — не заменяет решение менеджера.
					</p>
				</section>

				<section
					className="cases-section"
					id="cases"
					aria-labelledby="cases-title"
				>
					<div className="section-heading">
						<p className="section-index">Публичные кейсы</p>
						<h2 id="cases-title">Контекст вместо обещаний</h2>
						<p>
							Результаты ниже опубликованы в публичной ленте Botamin. Это данные
							конкретных кейсов, а не гарантия результата для нового проекта.
						</p>
					</div>
					<div className="case-ledger">
						{cases.map((caseItem) => (
							<article key={caseItem.name}>
								<p className="case-result">{caseItem.result}</p>
								<div>
									<p className="case-context">{caseItem.context}</p>
									<h3>{caseItem.name}</h3>
									<p>{caseItem.detail}</p>
								</div>
							</article>
						))}
					</div>
					<p className="case-source">
						Источник атрибуции: публичная Telegram-лента Botamin{` `}
						<a href="https://t.me/GPT_for_sales">«GPT для продаж»</a>.
						Показатели следует проверять применительно к вашему процессу и
						данным.
					</p>
				</section>

				<section className="trust-section" aria-labelledby="trust-title">
					<div>
						<p className="section-index">Границы демо</p>
						<h2 id="trust-title">Контроль остаётся у вас</h2>
					</div>
					<ul>
						<li>
							<strong>Не публичный чат.</strong>
							<span>Ваши данные не публикуются в открытом разговоре.</span>
						</li>
						<li>
							<strong>Можно остановить.</strong>
							<span>Микрофон и разговор выключаются в любой момент.</span>
						</li>
						<li>
							<strong>Без фиктивной встречи.</strong>
							<span>
								Реальная встреча в этом демо не создаётся. Лид и следующий шаг
								считаются записанными только после явного подтверждения.
							</span>
						</li>
					</ul>
				</section>
			</main>

			<footer className="site-footer">
				<strong>Botamin</strong>
				<p>AI-агенты для первой линии продаж</p>
				<a href="#top">Наверх</a>
			</footer>
		</div>
	);
}
