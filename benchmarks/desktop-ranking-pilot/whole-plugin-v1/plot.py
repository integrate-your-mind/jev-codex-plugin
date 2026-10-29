#!/usr/bin/env python3
"""Render descriptive plots from a whole-plugin-pilot report JSON."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np


ARMS = ("plugin-off", "cheap", "plugin-on")
COLORS = {"plugin-off": "#64748b", "cheap": "#0f766e", "plugin-on": "#7c3aed"}
UPTAKE = ("observed", "ignored", "unknown")


def _validate(report: Any) -> dict[str, Any]:
    if not isinstance(report, dict) or report.get("schemaVersion") != "whole-plugin-report-v1":
        raise ValueError("expected schemaVersion 'whole-plugin-report-v1'")
    by_arm = report.get("byArm")
    if not isinstance(by_arm, dict) or any(arm not in by_arm for arm in ARMS):
        raise ValueError("byArm must contain plugin-off, cheap, and plugin-on")
    if not isinstance(report.get("paired", []), list):
        raise ValueError("paired must be an array")
    for arm in ARMS:
        if not isinstance(by_arm[arm], dict):
            raise ValueError(f"byArm.{arm} must be an object")
        uptake = by_arm[arm].get("uptake", {})
        if not isinstance(uptake, dict):
            raise ValueError(f"byArm.{arm}.uptake must be an object")
    return report


def _count(value: Any) -> int:
    return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else 0


def _number(value: Any) -> float | None:
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def _labels(report: dict[str, Any]) -> list[str]:
    return [f"{arm}\n(n={_count(report['byArm'][arm].get('sourceValidCompleted'))} source-valid)" for arm in ARMS]


def _save(fig: plt.Figure, output_dir: Path, stem: str) -> None:
    for extension in ("svg", "png"):
        fig.savefig(output_dir / f"{stem}.{extension}", bbox_inches="tight", dpi=160)
    plt.close(fig)


def plot_fixes(report: dict[str, Any], output_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 5.2))
    positions = np.arange(len(ARMS))
    values: list[float] = []
    bounds: list[tuple[float, float] | None] = []
    for arm in ARMS:
        data = report["byArm"][arm]
        fixes = _number(data.get("verifiedFixes"))
        values.append(fixes if fixes is not None else 0)
        fb = data.get("fixBounds") or {}
        lo, hi = _number(fb.get("lower")), _number(fb.get("upper"))
        bounds.append((lo, hi) if lo is not None and hi is not None and lo <= hi else None)
    ax.bar(positions, values, color=[COLORS[a] for a in ARMS], width=0.62)
    for i, arm in enumerate(ARMS):
        data = report["byArm"][arm]
        fixes = _number(data.get("verifiedFixes"))
        completed = _count(data.get("sourceValidCompleted"))
        assigned = _count(data.get("assigned"))
        if bounds[i] and fixes is not None:
            lo, hi = bounds[i]
            ax.errorbar(i, fixes, yerr=[[max(0, fixes - lo)], [max(0, hi - fixes)]], fmt="none", ecolor="#111827", capsize=5)
        text = f"{fixes:g}/{completed}" if fixes is not None else f"unknown/{completed}"
        if assigned > completed:
            text += f"\n{assigned - completed} pending/invalid"
        ax.text(i, values[i] + 0.08, text, ha="center", va="bottom", fontsize=9)
    ax.set_xticks(positions, _labels(report))
    ax.set_ylabel("Independently verified fixes")
    ax.set_title("Verified fixes (bounds include unresolved assigned outcomes)")
    ax.set_ylim(bottom=0)
    ax.grid(axis="y", alpha=0.22)
    fig.tight_layout()
    _save(fig, output_dir, "verified-fixes")


def plot_curves(report: dict[str, Any], output_dir: Path) -> None:
    fig, ax = plt.subplots(figsize=(8.5, 5.2))
    plotted = False
    pending_note: list[str] = []
    for arm in ARMS:
        data = report["byArm"][arm]
        curve = data.get("curve")
        if isinstance(curve, list) and curve:
            points = []
            for point in curve:
                if not isinstance(point, dict):
                    continue
                elapsed, fixes = _number(point.get("elapsedMs")), _number(point.get("fixes"))
                if elapsed is not None and fixes is not None and elapsed >= 0 and fixes >= 0:
                    points.append((elapsed / 60_000, fixes))
            points.sort(key=lambda p: p[0])
            if points:
                ax.step([p[0] for p in points], [p[1] for p in points], where="post", color=COLORS[arm], linewidth=2, label=arm)
                ax.scatter([p[0] for p in points], [p[1] for p in points], color=COLORS[arm], s=18)
                plotted = True
        assigned = _count(data.get("assigned"))
        completed = _count(data.get("completed"))
        if assigned > completed:
            pending_note.append(f"{arm}: {assigned - completed} pending/invalid")
    if plotted:
        ax.legend(frameon=False)
        ax.set_ylim(bottom=0)
        ax.set_xlim(left=0)
    else:
        ax.text(0.5, 0.55, "No scored observations; no performance curve", ha="center", va="center", transform=ax.transAxes)
        ax.set_axis_off()
    ax.set_xlabel("Observed elapsed time from assignment (minutes)")
    ax.set_ylabel("Cumulative verified fixes")
    ax.set_title("Cumulative verified fixes over observed all-assigned elapsed time")
    if pending_note:
        ax.text(0.01, -0.22, "Pending elapsed is unknown: " + "; ".join(pending_note), transform=ax.transAxes, fontsize=8, va="top")
    fig.tight_layout()
    _save(fig, output_dir, "cumulative-fixes")


def plot_paired(report: dict[str, Any], output_dir: Path) -> None:
    paired = report.get("paired", [])
    rows = [row for row in paired if isinstance(row, dict)]
    fig_h = max(3.4, 0.55 * max(1, len(rows)) + 1.6)
    fig, ax = plt.subplots(figsize=(9.2, fig_h))
    palette = {"verified-fix": "#15803d", "not-fixed": "#dc2626", "infrastructure-invalid": "#d97706", "unknown": "#94a3b8"}
    labels = {"verified-fix": "verified fix", "not-fixed": "not fixed", "infrastructure-invalid": "infra invalid", "unknown": "unknown"}
    for y, row in enumerate(rows):
        arms = row.get("arms", {}) if isinstance(row.get("arms"), dict) else {}
        for x, arm in enumerate(ARMS):
            result = arms.get(arm)
            verdict = result.get("verdict") if isinstance(result, dict) else None
            key = verdict if verdict in palette else "unknown"
            ax.scatter(x, y, s=170, color=palette[key], edgecolor="white", linewidth=0.8, zorder=2)
            ax.text(x, y, labels[key], ha="center", va="center", color="white" if key != "unknown" else "#111827", fontsize=7)
    ax.set_xticks(range(3), ARMS)
    ax.set_yticks(range(len(rows)), [str(row.get("taskId", "unknown task")) for row in rows])
    ax.invert_yaxis()
    ax.set_xlim(-0.55, 2.55)
    ax.set_ylim(len(rows) - 0.5, -0.5) if rows else ax.set_ylim(0.5, -0.5)
    ax.set_title("Paired task outcomes by assigned arm")
    ax.set_xlabel("Missing or unresolved outcomes remain unknown")
    ax.grid(axis="x", alpha=0.18)
    fig.tight_layout()
    _save(fig, output_dir, "paired-outcomes")


def plot_cost_uptake(report: dict[str, Any], output_dir: Path) -> None:
    fig, axes = plt.subplots(2, 2, figsize=(11, 8))
    positions = np.arange(3)
    labels = ARMS
    # USD is shown only when the report marks both measurements complete.
    cost_ax = axes[0, 0]
    for i, arm in enumerate(ARMS):
        data = report["byArm"][arm]
        coding, jev = _number(data.get("codingUsd")), _number(data.get("jevUsd"))
        complete = data.get("costComplete") is True and coding is not None and jev is not None
        if complete:
            cost_ax.bar(i, coding, color=COLORS[arm], width=0.55, label="coding" if i == 0 else None)
            if jev:
                cost_ax.bar(i, jev, bottom=coding, color="#f59e0b", width=0.55, label="Jev" if i == 0 else None)
            cost_ax.text(i, coding + jev + 0.01, f"${coding + jev:.2f}", ha="center", fontsize=8)
        else:
            cost_ax.text(i, 0.5, "unknown", ha="center", va="center", rotation=90, color="#475569", fontsize=9)
    cost_ax.set_title("Measured cost (USD); unknown stays unknown")
    cost_ax.set_ylabel("USD")
    cost_ax.set_xticks(positions, labels)
    handles, legend_labels = cost_ax.get_legend_handles_labels()
    if handles:
        cost_ax.legend(handles, legend_labels, frameon=False, fontsize=8)
    cost_ax.grid(axis="y", alpha=0.2)

    ops_ax = axes[0, 1]
    for offset, key, color in ((-0.18, "approvals", "#2563eb"), (0.18, "consultations", "#f59e0b"), (0.0, "deliveries", "#16a34a")):
        ops_ax.bar(positions + offset, [_count(report["byArm"][arm].get(key)) for arm in ARMS], width=0.17, color=color, label=key)
    ops_ax.set_title("Approvals, consultations, and deliveries")
    ops_ax.set_xticks(positions, labels)
    ops_ax.legend(frameon=False, fontsize=8)
    ops_ax.grid(axis="y", alpha=0.2)

    uptake_ax = axes[1, 0]
    bottom = np.zeros(3)
    uptake_colors = {"observed": "#15803d", "ignored": "#64748b", "unknown": "#f59e0b"}
    for category in UPTAKE:
        counts = np.array([_count((report["byArm"][arm].get("uptake") or {}).get(category)) for arm in ARMS])
        uptake_ax.bar(positions, counts, bottom=bottom, color=uptake_colors[category], label=category)
        bottom += counts
    uptake_ax.set_title("Advice uptake observations")
    uptake_ax.set_xticks(positions, labels)
    uptake_ax.legend(frameon=False, fontsize=8)
    uptake_ax.grid(axis="y", alpha=0.2)

    note_ax = axes[1, 1]
    note_ax.axis("off")
    note_ax.text(0.02, 0.92, f"Study: {report.get('studyId', 'unknown')}\nPhase: {report.get('phase', 'unknown')}\nAttempts: {_count(report.get('attempted'))} assigned; {_count(report.get('completed'))} completed; {_count(report.get('pending'))} pending\n\nSubscription capacity is not dollars.\nAdvice counts do not establish benefit.", va="top", fontsize=10)
    fig.suptitle("Cost, process, and advice uptake", y=0.99)
    fig.tight_layout()
    _save(fig, output_dir, "cost-approvals-uptake")


def render(report_path: Path, output_dir: Path) -> list[Path]:
    report = _validate(json.loads(report_path.read_text(encoding="utf-8")))
    output_dir.mkdir(parents=True, exist_ok=True)
    plotters = (plot_fixes, plot_curves, plot_paired, plot_cost_uptake)
    for plotter in plotters:
        plotter(report, output_dir)
    return [output_dir / f"{stem}.{ext}" for stem in ("verified-fixes", "cumulative-fixes", "paired-outcomes", "cost-approvals-uptake") for ext in ("svg", "png")]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("report_json", type=Path)
    parser.add_argument("output_dir", type=Path)
    args = parser.parse_args()
    files = render(args.report_json, args.output_dir)
    for path in files:
        print(path)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
