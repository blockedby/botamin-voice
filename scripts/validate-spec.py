#!/usr/bin/env python3
from __future__ import annotations

from collections import defaultdict, deque
from html.parser import HTMLParser
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import yaml

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []
notes: list[str] = []
link_re = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")


def is_ignored(path: Path) -> bool:
    return (
        "node_modules" in path.parts
        or "dist" in path.parts
        or "coverage" in path.parts
        or ".git" in path.parts
        or ("corrections" in path.parts and "superseded" in path.parts)
    )


class VisibleHtmlParser(HTMLParser):
    """Collect rendered text while ignoring non-visible resource/style/script bodies."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.hidden_depth = 0
        self.parts: list[str] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        del attrs
        if tag.lower() in {"script", "style", "template"}:
            self.hidden_depth += 1

    def handle_endtag(self, tag: str) -> None:
        if tag.lower() in {"script", "style", "template"} and self.hidden_depth:
            self.hidden_depth -= 1

    def handle_data(self, data: str) -> None:
        if not self.hidden_depth:
            self.parts.append(data)


def visible_html_text(text: str) -> str:
    parser = VisibleHtmlParser()
    parser.feed(text)
    parser.close()
    return "\n".join(parser.parts)


def parse_env(text: str, label: str) -> dict[str, str]:
    values: dict[str, str] = {}
    for line in text.splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        if key in values:
            errors.append(f"duplicate env key in {label}: {key}")
        values[key] = value
    return values


# Local Markdown links, excluding fenced code, superseded history and remote/anchor URLs.
for path in ROOT.rglob("*.md"):
    if is_ignored(path):
        continue
    text = re.sub(r"```.*?```", "", path.read_text(errors="replace"), flags=re.S)
    for raw_target in link_re.findall(text):
        target = raw_target.strip().split()[0].strip("<>")
        if target.startswith(("http://", "https://", "mailto:", "#", "data:")):
            continue
        local = target.split("#", 1)[0]
        if local and not (path.parent / local).resolve().exists():
            errors.append(f"broken link: {path.relative_to(ROOT)} -> {target}")

# Task graph and gates.
data = yaml.safe_load((ROOT / "tasks/tasks.yaml").read_text())
if data.get("spec_version") != "0.5-demo":
    errors.append(f"tasks spec_version must be 0.5-demo, got {data.get('spec_version')!r}")
tasks = data["tasks"]
ids = [task["id"] for task in tasks]
id_set = set(ids)
if len(ids) != len(id_set):
    errors.append("duplicate task IDs")
indegree = {task_id: 0 for task_id in ids}
adjacency: dict[str, list[str]] = defaultdict(list)
for task in tasks:
    for dependency in task.get("depends_on", []):
        if dependency not in id_set:
            errors.append(f"unknown dependency {dependency} in {task['id']}")
            continue
        adjacency[dependency].append(task["id"])
        indegree[task["id"]] += 1
queue = deque(task_id for task_id, degree in indegree.items() if degree == 0)
visited: list[str] = []
while queue:
    current = queue.popleft()
    visited.append(current)
    for neighbor in adjacency[current]:
        indegree[neighbor] -= 1
        if indegree[neighbor] == 0:
            queue.append(neighbor)
if len(visited) != len(ids):
    errors.append("task dependency cycle")
for gate_id, gate in data.get("merge_gates", {}).items():
    for required in gate.get("requires", []):
        if required not in id_set:
            errors.append(f"unknown gate task {required} in {gate_id}")

# Rendered assets and packets.
for path in ROOT.glob("diagrams/*.svg"):
    try:
        ET.parse(path)
    except Exception as exc:  # noqa: BLE001
        errors.append(f"invalid SVG {path.name}: {exc}")
for path in ROOT.glob("charts/*.png"):
    if path.stat().st_size < 1_000:
        errors.append(f"suspicious PNG size {path.name}")
agent_packets = sorted((ROOT / "tasks/agents").glob("A*.md"))
if len(agent_packets) != 8:
    errors.append(f"expected 8 agent packets, got {len(agent_packets)}")
if not (ROOT / "tasks/agents/A2-openrouter-voice.md").is_file():
    errors.append("missing OpenRouter-only A2 packet")
retired_packet = ROOT / ("tasks/agents/A2-" + "x" + "ai-voice.md")
if retired_packet.exists():
    errors.append(f"retired agent packet remains: {retired_packet.relative_to(ROOT)}")

# Correction 004 precedence and superseded exclusion.
correction_rel = "corrections/CORRECTION-004_OPENROUTER_VOICE_ONLY.md"
correction = ROOT / correction_rel
if not correction.is_file():
    errors.append(f"missing {correction_rel}")
superseded_rel = "corrections/superseded/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md"
superseded = ROOT / superseded_rel
required_header = (
    "STATUS: SUPERSEDED BY CORRECTION-004_OPENROUTER_VOICE_ONLY.md\n"
    "DO NOT IMPLEMENT\n"
)
if not superseded.is_file():
    errors.append(f"missing {superseded_rel}")
elif not superseded.read_text(errors="replace").startswith(required_header):
    errors.append("Correction 003 superseded header is not exact")
for onboarding_name in ("README.md", "AGENT_START_HERE.md"):
    onboarding = (ROOT / onboarding_name).read_text(errors="replace")
    first_link = link_re.search(onboarding)
    if not first_link or first_link.group(1).split("#", 1)[0] != correction_rel:
        errors.append(f"{onboarding_name} must link Correction 004 first")
    if "0.5-demo" not in onboarding:
        errors.append(f"{onboarding_name} missing 0.5-demo")
    if "CORRECTION-003" in onboarding or "corrections/superseded" in onboarding:
        errors.append(f"{onboarding_name} includes superseded onboarding instruction")

# Exact active environment matrix.
env_text = (ROOT / ".env.example").read_text()
env_values = parse_env(env_text, ".env.example")
required_env = {
    "STT_PROVIDER": "openrouter",
    "OPENROUTER_STT_MODEL": "openai/gpt-audio-mini",
    "OPENROUTER_STT_AUDIO_FORMAT": "wav",
    "OPENROUTER_STT_LANGUAGE": "ru",
    "STT_CONNECT_TIMEOUT_MS": "8000",
    "STT_TOTAL_TIMEOUT_MS": "30000",
    "STT_MAX_RETRIES": "1",
    "STT_RETRY_BASE_MS": "400",
    "STT_MAX_UTTERANCE_MS": "60000",
    "STT_MAX_AUDIO_BYTES": "2000000",
    "STT_TEXT_ONLY_INPUT_FALLBACK": "false",
    "TTS_PROVIDER": "openrouter",
    "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
    "OPENROUTER_TTS_MODEL": "x-ai/grok-voice-tts-1.0",
    "OPENROUTER_TTS_VOICE": "eve",
    "OPENROUTER_TTS_RESPONSE_FORMAT": "mp3",
    "TTS_TEXT_ONLY_FALLBACK": "true",
}
for key, value in required_env.items():
    if env_values.get(key) != value:
        errors.append(f".env.example {key} must equal {value!r}")
if list(env_values).count("OPENROUTER_API_KEY") != 1:
    errors.append(".env.example must contain exactly one OPENROUTER_API_KEY")
retired_env_re = re.compile(
    r"^(?:" + "X" + "AI" + r"_|" + "X" + "AI_STT" + r"_|" + "X" + "AI_TTS" + r"_)",
    re.I,
)
for key in env_values:
    if retired_env_re.search(key):
        errors.append(f"retired voice env key remains active: {key}")

architecture = (ROOT / "docs/03-system-architecture.md").read_text()
env_blocks = re.findall(r"```dotenv\n(.*?)```", architecture, re.S)
if len(env_blocks) != 1:
    errors.append(f"architecture must contain exactly one dotenv matrix, got {len(env_blocks)}")
else:
    doc_env_values = parse_env(env_blocks[0], "architecture dotenv matrix")
    if doc_env_values != env_values:
        missing = sorted(env_values.keys() - doc_env_values.keys())
        extra = sorted(doc_env_values.keys() - env_values.keys())
        changed = sorted(
            key
            for key in env_values.keys() & doc_env_values.keys()
            if env_values[key] != doc_env_values[key]
        )
        errors.append(
            "architecture env matrix differs from .env.example: "
            f"missing={missing}, extra={extra}, changed={changed}"
        )

# Exact voice task ownership and semantics.
by_id = {task["id"]: task for task in tasks}
t11 = by_id.get("T11", {})
if t11.get("title") != "OpenRouter phrase-level STT adapter in TypeScript/Bun":
    errors.append("T11 title is not the Correction 004 title")
if t11.get("owned_paths") != [
    "apps/server/src/providers/openrouter/stt/**",
    "scripts/openrouter-stt*",
]:
    errors.append("T11 owned_paths do not match Correction 004")
t12 = by_id.get("T12", {})
if t12.get("title") != "OpenRouter TTS adapter in TypeScript/Bun":
    errors.append("T12 title changed unexpectedly")
if t12.get("owned_paths") != [
    "apps/server/src/providers/openrouter/tts/**",
    "scripts/openrouter-tts*",
]:
    errors.append("T12 owned_paths do not match the active TTS contract")

# Active source/contracts/fixtures/docs/generated text: reject retired provider and STT APIs.
# Historical corrections are excluded only through is_ignored(); generated HTML is parsed as visible text.
active_extensions = {
    ".css", ".dot", ".html", ".js", ".json", ".md", ".mjs", ".py",
    ".sh", ".ts", ".tsx", ".txt", ".yaml", ".yml",
}
generated_html_path = ROOT / "technical-spec.html"
active_text_paths = sorted(
    path
    for path in ROOT.rglob("*")
    if path.is_file()
    and not is_ignored(path)
    and path.suffix.lower() in active_extensions
    and path != generated_html_path
)
retired_provider_re = re.compile(
    r"(?:\b" + "x" + "ai" + r"\b|" + "x_" + "ai" + r"|" + "x " + "ai" + r")",
    re.I,
)
retired_partial_event = "transcript" + "." + "partial"
retired_session_type = "Stt" + "Session"
retired_audio_push = "send" + "Audio"
retired_stt_contract_patterns = (
    ("partial STT event", re.compile(re.escape(retired_partial_event), re.I)),
    (
        "session-style STT type",
        re.compile(r"\b" + re.escape(retired_session_type) + r"(?:Input)?\b"),
    ),
    ("streaming STT audio method", re.compile(r"\b" + re.escape(retired_audio_push) + r"\b")),
)
connection_name = "con" + "nect"
connection_call_re = re.compile(r"\b" + connection_name + r"\s*\(")
stt_connection_call_re = re.compile(r"\bstt\w*\s*\.\s*" + connection_name + r"\s*\(", re.I)
for path in active_text_paths:
    path_text = path.read_text(errors="ignore")
    has_session_surface = bool(retired_stt_contract_patterns[1][1].search(path_text))
    for line_number, line in enumerate(path_text.splitlines(), 1):
        if retired_provider_re.search(line):
            errors.append(f"retired voice provider text/path: {path.relative_to(ROOT)}:{line_number}")
        for label, pattern in retired_stt_contract_patterns:
            if pattern.search(line):
                errors.append(
                    f"retired STT contract ({label}): {path.relative_to(ROOT)}:{line_number}"
                )
        if stt_connection_call_re.search(line) or (
            has_session_surface and connection_call_re.search(line)
        ):
            errors.append(
                f"retired STT contract (session-style connection method): "
                f"{path.relative_to(ROOT)}:{line_number}"
            )
active_corpus = "\n".join(path.read_text(errors="ignore") for path in active_text_paths)
for term in (
    "OpenRouter is the only",
    "/api/v1/chat/completions",
    "input_audio",
    "openai/gpt-audio-mini",
    "audio.commit",
    "transcript.final",
    "gateway/utterance assembler",
    "already-WAV",
    "OpenRouterTtsAdapter",
    'contentType: "audio/wav"',
    'contentType: "audio/mpeg"',
):
    if term not in active_corpus:
        errors.append(f"missing Correction 004 active invariant: {term}")

# Ownership must remain explicit: gateway encodes one WAV; adapter only validates/bounds/posts it.
a2_packet = (ROOT / "tasks/agents/A2-openrouter-voice.md").read_text(errors="ignore")
testing_spec = (ROOT / "docs/08-testing-and-acceptance.md").read_text(errors="ignore")
ownership_requirements = {
    "architecture gateway WAV ownership": (
        architecture,
        "gateway/utterance assembler создаёт один validated WAV request",
    ),
    "architecture adapter does not encode WAV": (
        architecture,
        "adapter не добавляет WAV header и не конвертирует PCM",
    ),
    "A2 consumes already-WAV bytes": (
        a2_packet,
        "bytes are already a validated WAV",
    ),
    "A2 forbids duplicate encoder": (
        a2_packet,
        "A2 must not duplicate that encoder inside the adapter",
    ),
    "separate gateway encoder tests": (
        testing_spec,
        "Gateway/utterance-assembler tests prove",
    ),
    "separate adapter request tests": (
        testing_spec,
        "OpenRouterSttAdapter` tests use an already-WAV fixture",
    ),
}
for label, (text, required) in ownership_requirements.items():
    if required not in text:
        errors.append(f"missing WAV ownership invariant: {label}")

# Assembled spec and standalone HTML.
full_spec = (ROOT / "FULL_SPEC.md").read_text(errors="replace")
if "**Версия:** 0.5-demo" not in full_spec:
    errors.append("FULL_SPEC version is not 0.5-demo")
if "CORRECTION-003" in full_spec or "STATUS: SUPERSEDED" in full_spec:
    errors.append("FULL_SPEC includes superseded Correction 003 content")
if retired_provider_re.search(full_spec):
    errors.append("FULL_SPEC contains retired voice-provider text/path")
for term in ("/api/v1/chat/completions", "input_audio", "final transcript", "OpenRouter STT", "OpenRouter TTS"):
    if term not in full_spec:
        errors.append(f"FULL_SPEC missing active voice invariant: {term}")
for number in range(0, 11):
    if f"# {number:02d}." not in full_spec:
        errors.append(f"FULL_SPEC missing section {number:02d}")
if "# Источники" not in full_spec:
    errors.append("FULL_SPEC missing sources")

html = generated_html_path.read_text(errors="replace")
if "0.5-demo" not in html or "OpenRouter STT" not in html or "OpenRouter TTS" not in html:
    errors.append("technical-spec.html missing version/OpenRouter voice migration")
if "CORRECTION-003" in html or "STATUS: SUPERSEDED" in html:
    errors.append("technical-spec.html includes superseded Correction 003 content")
# Embedded resources and CSS can contain coincidental byte/text patterns; scan rendered text only.
html_visible = visible_html_text(html)
if retired_provider_re.search(html_visible):
    errors.append("technical-spec.html visible text contains retired voice-provider text/path")
for label, pattern in retired_stt_contract_patterns:
    if pattern.search(html_visible):
        errors.append(f"technical-spec.html visible text contains retired STT contract ({label})")
html_has_session_surface = bool(retired_stt_contract_patterns[1][1].search(html_visible))
if stt_connection_call_re.search(html_visible) or (
    html_has_session_surface and connection_call_re.search(html_visible)
):
    errors.append(
        "technical-spec.html visible text contains retired STT contract "
        "(session-style connection method)"
    )
embedded_rasters = len(re.findall(r"data:image/(?:png|jpe?g|webp)", html))
embedded_svgs = len(re.findall(r"data:image/svg\+xml", html))
inline_svgs = len(re.findall(r"<svg\b", html))
if embedded_rasters < 3:
    errors.append(f"HTML embedded raster count too low: {embedded_rasters}")
if inline_svgs + embedded_svgs < 7:
    errors.append(f"HTML embedded SVG count too low: inline={inline_svgs}, data={embedded_svgs}")
for source in re.findall(r'<img[^>]+src="([^"]+)"', html):
    if not source.startswith("data:"):
        errors.append(f"non-embedded image source: {source[:100]}")

# Basic accidental-secret scan.
secret_patterns = [
    r"sk-[A-Za-z0-9_-]{20,}",
    r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
    r'"refresh_token"\s*:',
]
text_extensions = {".md", ".yaml", ".yml", ".json", ".txt", ".sh", ".dot", ".css", ".html"}
for path in ROOT.rglob("*"):
    if is_ignored(path) or not path.is_file() or path.suffix.lower() not in text_extensions:
        continue
    text = path.read_text(errors="ignore")
    for pattern in secret_patterns:
        if re.search(pattern, text):
            errors.append(f"possible secret in {path.relative_to(ROOT)}")

corpus = "\n".join(path.read_text(errors="ignore") for path in ROOT.glob("docs/*.md"))
required_terms = {
    "booking invariant": "booking.created",
    "Luna model": "gpt-5.6-luna",
    "AI library decision": "Direct `codex app-server` JSON-RPC",
    "qualification tool": "append_booking_qualification",
}
for label, term in required_terms.items():
    if term not in corpus:
        errors.append(f"missing required term: {label}")

notes.extend(
    [
        "Correction 004 precedence, 0.5-demo and OpenRouter-only voice invariants verified",
        "Correction 003 is marked superseded and excluded from active/generated instructions",
        f"{len(tasks)} tasks; dependency graph is acyclic",
        f"{len(agent_packets)} agent packets",
        f"{len(list(ROOT.glob('diagrams/*.svg')))} SVG diagrams",
        f"{len(list(ROOT.glob('charts/*.png')))} PNG charts",
        f"HTML embeds {embedded_rasters} raster images and {inline_svgs + embedded_svgs} SVGs",
        f"{sum(1 for path in ROOT.rglob('*.md') if not is_ignored(path))} active Markdown files",
    ]
)

print("VALIDATION NOTES")
for note in notes:
    print(f"- {note}")
if errors:
    print("\nERRORS")
    for error in errors:
        print(f"- {error}")
    sys.exit(1)
print("\nALL VALIDATIONS PASSED")
