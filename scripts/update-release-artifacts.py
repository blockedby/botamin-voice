#!/usr/bin/env python3
"""Regenerate MANIFEST.txt and CHECKSUMS.sha256 from repository package files."""

from hashlib import sha256
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parents[1]

result = subprocess.run(
    ["git", "ls-files", "--cached", "--others", "--exclude-standard"],
    cwd=ROOT,
    check=True,
    capture_output=True,
    text=True,
)
paths = sorted(
    {
        line
        for line in result.stdout.splitlines()
        if line
        and line != "CHECKSUMS.sha256"
        and not line.startswith(".git/")
        and (ROOT / line).is_file()
    }
)

manifest = ROOT / "MANIFEST.txt"
manifest.write_text("\n".join(paths) + "\n")
if "MANIFEST.txt" not in paths:
    raise SystemExit("MANIFEST.txt must be tracked and included")

checksum_lines = []
for relative in paths:
    path = ROOT / relative
    if not path.is_file():
        raise SystemExit(f"manifest entry is not a file: {relative}")
    checksum_lines.append(f"{sha256(path.read_bytes()).hexdigest()}  {relative}")
(ROOT / "CHECKSUMS.sha256").write_text("\n".join(checksum_lines) + "\n")

print(f"Wrote MANIFEST.txt ({len(paths)} files) and CHECKSUMS.sha256")
