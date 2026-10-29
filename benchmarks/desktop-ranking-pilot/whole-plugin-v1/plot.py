#!/usr/bin/env python3
"""Render descriptive plots from a sanitized whole-plugin pilot report."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.ticker import MaxNLocator
import numpy as np

ARMS = ("plugin-off", "cheap", "plugin-on")
LABELS = ("Standard Codex", "Cheap retrieval", "Codex + Jev")
COLORS = ("#64748b", "#0f766e", "#7c3aed")


def _validate(report: Any) -> dict[str, Any]:
    if not isinstance(report, dict) or report.get("schemaVersion") != "whole-plugin-report-v1":
        raise ValueError("expected schemaVersion 'whole-plugin-report-v1'")
    rows = report.get("arms")
    if not isinstance(rows, list) or [row.get("id") for row in rows if isinstance(row, dict)] != list(ARMS):
        raise ValueError("arms must contain plugin-off, cheap, plugin-on in order")
    if not isinstance(report.get("paired"), list) or not isinstance(report.get("curves"), dict):
        raise ValueError("paired and curves must be provided")
    return report


def _number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value >= 0:
        return float(value)
    return None


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _finish(fig: plt.Figure, report: dict[str, Any], output: Path, name: str) -> None:
    completed = _count(report.get("completedAttempts"))
    pending = _count(report.get("pendingAttempts"))
    invalid = _count(report.get("invalidAttempts"))
    fig.suptitle(f"Six-bug exploratory pilot | {completed}/18 completed; {pending} pending; {invalid} invalid\nNot an official SWE-bench score", fontsize=11)
    fig.tight_layout(rect=(0, 0, 1, 0.92))
    for extension in ("svg", "png"):
        fig.savefig(output / f"{name}.{extension}", bbox_inches="tight", dpi=160)
    plt.close(fig)


def plot_fixes(report: dict[str, Any], output: Path) -> None:
    fig, ax = plt.subplots(figsize=(9, 5.8))
    for i, row in enumerate(report["arms"]):
        fixes, completed = _count(row.get("verifiedFixes")), _count(row.get("completed"))
        ax.bar(i, fixes, color=COLORS[i], width=0.6)
        result = f"{fixes}/{completed} ({fixes / completed:.0%})" if completed else "No completed result"
        ax.text(i, fixes + 0.12, result, ha="center", va="bottom", fontsize=10)
        ax.text(i, -0.13, f"{_count(row.get('pending'))} pending; {_count(row.get('invalid'))} invalid", transform=ax.get_xaxis_transform(), ha="center", fontsize=9, color="#475569")
    ax.set_xticks(range(3), LABELS)
    ax.set_ylim(0, max(1, max(_count(r.get("verifiedFixes")) for r in report["arms"])) + 0.8)
    ax.yaxis.set_major_locator(MaxNLocator(integer=True))
    ax.set_ylabel("Independently verified fixes")
    ax.set_title("Verified fixes / completed valid attempts")
    ax.grid(axis="y", alpha=0.2)
    _finish(fig, report, output, "verified-fixes")


def plot_curves(report: dict[str, Any], output: Path) -> None:
    fig, ax = plt.subplots(figsize=(9, 5.8))
    plotted = False
    for i, arm in enumerate(ARMS):
        curve = report["curves"].get(arm) or []
        points = [(p.get("elapsedMs"), p.get("verifiedFixes")) for p in curve if isinstance(p, dict)]
        points = [(x / 60_000, y) for x, y in points if _number(x) is not None and _number(y) is not None]
        if not points:
            continue
        if points != sorted(points):
            raise ValueError("curve points must preserve observed cumulative order")
        if points[0][0] > 0:
            points.insert(0, (0, 0))
        ax.step([p[0] for p in points], [p[1] for p in points], where="post", color=COLORS[i], linewidth=2, linestyle=("--", ":", "-")[i], marker=("s", "^", "o")[i], markersize=4, label=LABELS[i])
        plotted = True
    if plotted:
        ax.legend(frameon=False)
        ax.set_xlim(left=0)
        ax.set_ylim(bottom=0)
        ax.yaxis.set_major_locator(MaxNLocator(integer=True))
        ax.grid(alpha=0.2)
    else:
        ax.text(0.5, 0.5, "No scored observations; no performance curve", ha="center", va="center", transform=ax.transAxes)
        ax.set_axis_off()
    ax.set_title("Fixes versus cumulative all-assigned elapsed time")
    ax.set_xlabel("Minutes, including unsuccessful attempts, startup, waits and grading")
    ax.set_ylabel("Cumulative verified fixes")
    ax.text(0, -0.2, "Curves end at observed terminal support. Pending attempts are not failures.", transform=ax.transAxes, fontsize=9)
    _finish(fig, report, output, "cumulative-fixes")


def plot_paired(report: dict[str, Any], output: Path) -> None:
    rows = report["paired"]
    fig, ax = plt.subplots(figsize=(10, max(4.2, len(rows) * 0.63 + 2)))
    palette = {"verified-fix": "#15803d", "not-fixed": "#dc2626", "infrastructure-invalid": "#b45309", "pending": "#e2e8f0"}
    labels = {"verified-fix": "Verified fix", "not-fixed": "Not fixed", "infrastructure-invalid": "Invalid", "pending": "Pending"}
    for y, row in enumerate(rows):
        for x, arm in enumerate(ARMS):
            verdict = row.get("conditions", {}).get(arm, "pending")
            if verdict not in palette:
                raise ValueError("unknown paired outcome")
            ax.add_patch(plt.Rectangle((x - 0.45, y - 0.38), 0.9, 0.76, color=palette[verdict]))
            ax.text(x, y, labels[verdict], ha="center", va="center", fontsize=10, color="#111827" if verdict == "pending" else "white")
    ax.set_xticks(range(3), LABELS)
    ax.set_yticks(range(len(rows)), [row["taskId"] for row in rows])
    ax.set_xlim(-0.5, 2.5)
    ax.set_ylim(max(0.5, len(rows) - 0.5), -0.5)
    ax.set_title("Paired outcomes on the same bugs")
    ax.set_xlabel("Pending and infrastructure-invalid outcomes are not failed fixes")
    _finish(fig, report, output, "paired-outcomes")


def plot_cost_uptake(report: dict[str, Any], output: Path) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(12, 9))
    positions = np.arange(3)
    rows = report["arms"]
    cost = axes[0, 0]
    for i, row in enumerate(rows):
        coding, jev = _number(row.get("codingUsd")), _number(row.get("jevUsd"))
        if coding is not None:
            cost.bar(i - 0.15, coding, width=0.28, color="#64748b", label="Coding" if i == 0 else None)
        if jev is not None:
            cost.bar(i + 0.15, jev, width=0.28, color="#7c3aed", label="Jev" if i == 0 else None)
        unknown = []
        if coding is None:
            unknown.append("Coding unknown")
        if jev is None:
            unknown.append("Jev unknown")
        if unknown:
            cost.text(i, 0.04, "\n".join(unknown), transform=cost.get_xaxis_transform(), ha="center", fontsize=8)
    cost.set_title("Observed component cost (USD)")
    cost.set_ylabel("USD; unknown billing is not zero")
    cost.set_xticks(positions, LABELS, fontsize=8)
    handles, labels = cost.get_legend_handles_labels()
    if handles:
        cost.legend(handles, labels, frameon=False, fontsize=8)
    ops = axes[0, 1]
    for offset, key, label, color in ((-0.24, "approvals", "Approvals", "#2563eb"), (0, "failedPublicCycles", "Repeated failed checks", "#dc2626"), (0.24, "consultations", "Consultations", "#f59e0b")):
        ops.bar(positions + offset, [_count(r.get(key)) for r in rows], width=0.22, color=color, label=label)
    ops.set_title("Approval and consultation overhead")
    ops.set_xticks(positions, LABELS, fontsize=8)
    ops.yaxis.set_major_locator(MaxNLocator(integer=True))
    ops.legend(frameon=False, fontsize=8)
    uptake = axes[1, 0]
    bottom = np.zeros(3)
    for key, label, color in (("uptakeObserved", "Observed", "#15803d"), ("uptakeIgnored", "Ignored", "#64748b"), ("uptakeUnknown", "Unknown", "#f59e0b")):
        counts = np.array([_count(r.get(key)) for r in rows])
        uptake.bar(positions, counts, bottom=bottom, color=color, label=label)
        bottom += counts
    uptake.set_title("Advice uptake")
    uptake.set_xticks(positions, LABELS, fontsize=8)
    uptake.yaxis.set_major_locator(MaxNLocator(integer=True))
    uptake.legend(frameon=False, fontsize=8)
    note = axes[1, 1]
    note.axis("off")
    provider = sum(_count(r.get("providerRequests")) for r in rows)
    unknown_provider = sum(_count(r.get("providerRequestUnknown")) for r in rows)
    note.text(0, 0.95, f"Provider invocations observed: {provider}\nInvocation status unknown: {unknown_provider}\n\nSubscription usage is not cash savings.\nAdvice counts do not establish benefit.\n\nVerdict: {report.get('interpretation', {}).get('verdict', 'inconclusive')}", va="top", fontsize=10)
    for ax in (cost, ops, uptake):
        ax.grid(axis="y", alpha=0.2)
    _finish(fig, report, output, "cost-approvals-uptake")


def render(report_path: Path, output_dir: Path) -> list[Path]:
    report = _validate(json.loads(report_path.read_text(encoding="utf-8")))
    output_dir.mkdir(parents=True, exist_ok=True)
    for plotter in (plot_fixes, plot_curves, plot_paired, plot_cost_uptake):
        plotter(report, output_dir)
    return [output_dir / f"{stem}.{ext}" for stem in ("verified-fixes", "cumulative-fixes", "paired-outcomes", "cost-approvals-uptake") for ext in ("svg", "png")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_json", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    for path in render(args.report_json, args.output_dir):
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
