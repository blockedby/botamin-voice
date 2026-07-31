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

# Assembled spec.
full_spec = (ROOT / "FULL_SPEC.md").read_text(errors="replace")
for number in range(0, 11):
    if f"# {number:02d}." not in full_spec:
        errors.append(f"FULL_SPEC missing section {number:02d}")
if "# Источники" not in full_spec:
    errors.append("FULL_SPEC missing sources")

html = (ROOT / "technical-spec.html").read_text(errors="replace")
embedded_rasters = len(re.findall(r"data:image/", html))
inline_svgs = len(re.findall(r"<svg\b", html))
if embedded_rasters < 3:
    errors.append(f"HTML embedded raster count too low: {embedded_rasters}")
if inline_svgs < 7:
    errors.append(f"HTML inline SVG count too low: {inline_svgs}")
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
        f"{len(tasks)} tasks; dependency graph is acyclic",
        f"{len(agent_packets)} agent packets",
        f"{len(list(ROOT.glob('diagrams/*.svg')))} SVG diagrams",
        f"{len(list(ROOT.glob('charts/*.png')))} PNG charts",
        f"HTML embeds {embedded_rasters} raster images and {inline_svgs} inline SVGs",
        f"{len(list(ROOT.rglob('*.md')))} Markdown files",
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
