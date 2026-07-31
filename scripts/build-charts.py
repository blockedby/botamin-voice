#!/usr/bin/env python3
"""Deterministically regenerate specification charts for OpenRouter-only voice policy."""

from pathlib import Path

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parents[1]
CHARTS = ROOT / "charts"

plt.rcParams.update(
    {
        "font.family": "DejaVu Sans",
        "font.size": 11,
        "figure.facecolor": "white",
        "axes.facecolor": "white",
        "savefig.facecolor": "white",
    }
)


def build_latency() -> None:
    labels = [
        "audio.commit + WAV preparation",
        "OpenRouter STT final transcript",
        "Luna first text delta",
        "First phrase buffer",
        "OpenRouter TTS complete MP3",
    ]
    seconds = [0.05, 0.65, 0.65, 0.20, 0.25]
    colors = ["#0891b2", "#2563eb", "#16a34a", "#d97706", "#7c3aed"]

    fig, ax = plt.subplots(figsize=(14, 3.8))
    left = 0.0
    for label, value, color in zip(labels, seconds, colors, strict=True):
        ax.barh([0], [value], left=left, color=color, label=f"{label}: {value:.2f} s")
        left += value
    ax.set_xlim(0, 2.2)
    ax.set_yticks([0], ["commit → final transcript → MP3 playback"])
    ax.set_xlabel("Seconds")
    ax.set_title("Engineering latency budget for one voice turn (SLO, not a provider guarantee)")
    ax.text(left + 0.03, 0, f"Target total: {left:.2f} s", va="center")
    ax.legend(loc="upper center", bbox_to_anchor=(0.5, -0.23), ncol=3, frameon=True)
    fig.subplots_adjust(left=0.28, right=0.98, top=0.82, bottom=0.34)
    fig.savefig(CHARTS / "01-latency-budget.png", dpi=140, metadata={"Software": "Botamin build-charts.py"})
    plt.close(fig)


def build_parallel_workstreams() -> None:
    labels = [
        "T00 Contracts + skeleton",
        "T01 Research + prompts",
        "T10 Web voice client",
        "T11 OpenRouter STT",
        "T12 OpenRouter TTS",
        "T13 Codex/Luna adapter",
        "T14 Booking + DB",
        "T15 Docker/ops",
        "T20 Orchestrator",
        "T21 Product UI",
        "T22 Component tests",
        "T30 E2E integration",
        "T31 Conversation evals",
        "T32 Hardening",
        "T40 Release candidate",
    ]
    starts = [0, 0, 1, 1, 1, 1, 1, 1, 2, 2, 2, 4, 5, 5, 6]
    durations = [1, 2, 2, 1, 1, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1]

    fig, ax = plt.subplots(figsize=(14, 10))
    positions = list(range(len(labels)))
    ax.barh(positions, durations, left=starts, color="#287fb8")
    ax.set_yticks(positions, labels)
    ax.invert_yaxis()
    ax.set_xticks(range(8), [f"Волна {wave}" for wave in range(8)])
    ax.set_xlim(0, 7.35)
    ax.grid(axis="x", alpha=0.25)
    ax.set_title("План параллельной работы агентов", fontsize=18)
    ax.set_xlabel("Логические волны и merge gates, не календарное время")
    fig.subplots_adjust(left=0.25, right=0.98, top=0.94, bottom=0.09)
    fig.savefig(
        CHARTS / "03-parallel-workstreams.png",
        dpi=140,
        metadata={"Software": "Botamin build-charts.py"},
    )
    plt.close(fig)


def build_cost_inputs() -> None:
    fig, ax = plt.subplots(figsize=(12, 6.2))
    ax.axis("off")
    ax.set_title("Metered voice inputs: OpenRouter STT + OpenRouter TTS", fontsize=19, pad=24)

    box = dict(boxstyle="round,pad=0.8", edgecolor="#334155", facecolor="#f8fafc", linewidth=1.5)
    ax.text(
        0.25,
        0.64,
        "OpenRouter phrase-level STT\n\nMeasured input: bounded WAV/audio usage\nCost input: measured usage × current model/account rate",
        ha="center",
        va="center",
        fontsize=13,
        bbox=box,
        transform=ax.transAxes,
    )
    ax.text(
        0.75,
        0.64,
        "OpenRouter TTS\n\nMeasured input: sanitized characters sent\nCost input: characters × current model/account rate",
        ha="center",
        va="center",
        fontsize=13,
        bbox=box,
        transform=ax.transAxes,
    )
    ax.text(0.50, 0.64, "+", ha="center", va="center", fontsize=28, transform=ax.transAxes)
    ax.text(
        0.50,
        0.25,
        "Release estimate = measured usage × rates verified at deployment\nNo free tier or fixed numeric provider price is assumed in this specification.",
        ha="center",
        va="center",
        fontsize=14,
        fontweight="bold",
        color="#0f172a",
        transform=ax.transAxes,
    )
    ax.text(
        0.50,
        0.08,
        "Track VPS, bandwidth and Codex subscription/credits separately.",
        ha="center",
        va="center",
        fontsize=11,
        color="#475569",
        transform=ax.transAxes,
    )
    fig.subplots_adjust(left=0.03, right=0.97, top=0.86, bottom=0.04)
    fig.savefig(
        CHARTS / "02-openrouter-stt-tts-cost.png",
        dpi=140,
        metadata={"Software": "Botamin build-charts.py"},
    )
    plt.close(fig)


if __name__ == "__main__":
    build_latency()
    build_cost_inputs()
    build_parallel_workstreams()
    print("Built charts/01-latency-budget.png, charts/02-openrouter-stt-tts-cost.png and charts/03-parallel-workstreams.png")
