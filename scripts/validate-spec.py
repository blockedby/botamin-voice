#!/usr/bin/env python3
from __future__ import annotations

from collections import defaultdict, deque
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import yaml

ROOT = Path(__file__).resolve().parents[1]
errors: list[str] = []
notes: list[str] = []

# Local Markdown links, excluding fenced code and remote/anchor URLs.
link_re = re.compile(r"!?(?:\[[^\]]*\])\(([^)]+)\)")
for path in ROOT.rglob("*.md"):
    if "node_modules" in path.parts or ".git" in path.parts:
        continue
    text = re.sub(r"```.*?```", "", path.read_text(errors="replace"), flags=re.S)
    for raw_target in link_re.findall(text):
        target = raw_target.strip().split()[0].strip("<>")
        if target.startswith(("http://", "https://", "mailto:", "#", "data:")):
            continue
        local = target.split("#", 1)[0]
        if local and not (path.parent / local).resolve().exists():
            errors.append(f"broken link: {path.relative_to(ROOT)} -> {target}")

# Task graph.
data = yaml.safe_load((ROOT / "tasks/tasks.yaml").read_text())
if data.get("spec_version") != "0.4-demo":
    errors.append(f"tasks spec_version must be 0.4-demo, got {data.get('spec_version')!r}")
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

# Rendered assets.
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

# Correction 003 precedence and active OpenRouter TTS invariants.
correction_rel = "corrections/CORRECTION-003_OPENROUTER_TTS_TYPESCRIPT_NATIVE.md"
correction = ROOT / correction_rel
if not correction.is_file():
    errors.append(f"missing {correction_rel}")
for onboarding_name in ("README.md", "AGENT_START_HERE.md"):
    onboarding = (ROOT / onboarding_name).read_text(errors="replace")
    first_link = link_re.search(onboarding)
    if not first_link or first_link.group(1).split("#", 1)[0] != correction_rel:
        errors.append(f"{onboarding_name} must link Correction 003 first")
    if "0.4-demo" not in onboarding:
        errors.append(f"{onboarding_name} missing 0.4-demo")

required_env = {
    "TTS_PROVIDER": "openrouter",
    "OPENROUTER_BASE_URL": "https://openrouter.ai/api/v1",
    "OPENROUTER_TTS_MODEL": "x-ai/grok-voice-tts-1.0",
    "OPENROUTER_TTS_VOICE": "eve",
    "OPENROUTER_TTS_RESPONSE_FORMAT": "mp3",
    "OPENROUTER_HTTP_REFERER": "http://localhost:5173",
    "TTS_TEXT_ONLY_FALLBACK": "true",
    "TTS_MAX_CHARS_PER_SEGMENT": "240",
    "TTS_MAX_CHARS_PER_TURN": "1800",
    "TTS_MAX_CHARS_PER_SESSION": "8000",
}
env_values: dict[str, str] = {}
for line in (ROOT / ".env.example").read_text().splitlines():
    if not line or line.lstrip().startswith("#") or "=" not in line:
        continue
    key, value = line.split("=", 1)
    if key in env_values:
        errors.append(f"duplicate env key: {key}")
    env_values[key] = value
for key, value in required_env.items():
    if env_values.get(key) != value:
        errors.append(f".env.example {key} must equal {value!r}")
for key in env_values:
    if key.startswith(("EDGE" + "_TTS_", "XAI" + "_TTS_")) or key == (
        "TTS_BROWSER_" + "FALLBACK"
    ):
        errors.append(f"retired env key remains active: {key}")

architecture = (ROOT / "docs/03-system-architecture.md").read_text()
env_block_match = re.search(r"```dotenv\n(.*?)```", architecture, re.S)
doc_env_values: dict[str, str] = {}
if not env_block_match:
    errors.append("docs/03-system-architecture.md missing dotenv matrix")
else:
    for line in env_block_match.group(1).splitlines():
        if not line or line.lstrip().startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        doc_env_values[key] = value
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

by_id = {task["id"]: task for task in tasks}
t12 = by_id.get("T12", {})
if t12.get("title") != "OpenRouter TTS adapter in TypeScript/Bun":
    errors.append("T12 title is not the Correction 003 title")
if t12.get("owned_paths") != [
    "apps/server/src/providers/openrouter/tts/**",
    "scripts/openrouter-tts*",
]:
    errors.append("T12 owned_paths do not match Correction 003")

active_text_paths = [
    ROOT / "README.md",
    ROOT / "CURRENT_DECISIONS.md",
    ROOT / "AGENT_START_HERE.md",
    ROOT / "AGENT_DISPATCH_PROMPT.md",
    ROOT / "00-UNPACK-FIRST.txt",
    ROOT / ".env.example",
    ROOT / "sources.md",
    ROOT / "tasks/tasks.yaml",
    *sorted((ROOT / "docs").glob("*.md")),
    *agent_packets,
    *sorted((ROOT / "diagrams").glob("*.dot")),
]
stale_active_patterns = {
    "direct xAI TTS websocket": re.compile(r"wss://api\.x\.ai/v1/" + "tts", re.I),
    "xAI streaming TTS instruction": re.compile("xAI Streaming " + "TTS", re.I),
    "retired xAI TTS env": re.compile("XAI" + "_TTS_"),
    "retired Edge package/path": re.compile(
        "edge" + r"[-_ ]tts|edge" + "-community|msedge" + "-tts|services/edge"
        + "-tts|Svetlana" + "Neural|Dariya" + "Neural",
        re.I,
    ),
}
for path in active_text_paths:
    for line_number, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
        for label, pattern in stale_active_patterns.items():
            if pattern.search(line):
                negative_policy = re.search(
                    r"\b(no|not|never|without|absent|retired|rejected|superseded)\b|"
                    r"не (?:использ|добав|содерж|существ)|запрещ",
                    line,
                    re.I,
                )
                if negative_policy:
                    continue
                errors.append(f"{label}: {path.relative_to(ROOT)}:{line_number}")

active_corpus = "\n".join(path.read_text(errors="ignore") for path in active_text_paths)
for term in (
    "OpenRouterTtsAdapter",
    'contentType: "audio/mpeg"',
    "native Bun `fetch`",
    "TTS_TEXT_ONLY_FALLBACK",
    "OpenRouter TTS is paid usage",
):
    if term not in active_corpus:
        errors.append(f"missing Correction 003 active invariant: {term}")

# Assembled spec.
full_spec = (ROOT / "FULL_SPEC.md").read_text(errors="replace")
if "**Версия:** 0.4-demo" not in full_spec:
    errors.append("FULL_SPEC version is not 0.4-demo")
for stale in (
    "wss://api.x.ai/v1/" + "tts",
    "xAI Streaming " + "TTS",
    "XAI" + "_TTS_",
):
    if stale in full_spec:
        errors.append(f"FULL_SPEC contains stale active TTS text: {stale}")
for number in range(0, 11):
    if f"# {number:02d}." not in full_spec:
        errors.append(f"FULL_SPEC missing section {number:02d}")
if "# Источники" not in full_spec:
    errors.append("FULL_SPEC missing sources")

html = (ROOT / "technical-spec.html").read_text(errors="replace")
if "0.4-demo" not in html or "OpenRouter TTS" not in html:
    errors.append("technical-spec.html missing version/OpenRouter migration")
for stale in (
    "wss://api.x.ai/v1/" + "tts",
    "xAI Streaming " + "TTS",
    "XAI" + "_TTS_",
):
    if stale in html:
        errors.append(f"technical-spec.html contains stale active TTS text: {stale}")
embedded_rasters = len(re.findall(r"data:image/(?:png|jpe?g|webp)", html))
embedded_svgs = len(re.findall(r"data:image/svg\+xml", html))
inline_svgs = len(re.findall(r"<svg\b", html))
if embedded_rasters < 3:
    errors.append(f"HTML embedded raster count too low: {embedded_rasters}")
if inline_svgs + embedded_svgs < 7:
    errors.append(
        f"HTML embedded SVG count too low: inline={inline_svgs}, data={embedded_svgs}"
    )
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
    if "node_modules" in path.parts or ".git" in path.parts:
        continue
    if not path.is_file() or path.suffix.lower() not in text_extensions:
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
        "Correction 003 precedence, 0.4-demo and OpenRouter TTS invariants verified",
        f"{len(tasks)} tasks; dependency graph is acyclic",
        f"{len(agent_packets)} agent packets",
        f"{len(list(ROOT.glob('diagrams/*.svg')))} SVG diagrams",
        f"{len(list(ROOT.glob('charts/*.png')))} PNG charts",
        f"HTML embeds {embedded_rasters} raster images and {inline_svgs + embedded_svgs} SVGs",
        f"{sum(1 for path in ROOT.rglob('*.md') if 'node_modules' not in path.parts and '.git' not in path.parts)} Markdown files",
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
