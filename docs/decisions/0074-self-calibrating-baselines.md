# ADR-0074: Self-Calibrating Baselines (Median + MAD)

## Status: Accepted

## Context
Every monitoring threshold goes stale: traffic patterns shift, deployments change capacity, and hand-picked constants become either noisy or blind.

## Decision
Sentinel Mode thresholds self-calibrate using rolling median + MAD (median absolute deviation) baselines over 256-sample windows. MAD is robust to outliers by construction. Trigger rule: value > median + k×MAD×1.4826 AND value > absolute floor. Degenerate cases (constant series where MAD=0) fall back to relative jump detection (1.5× median).

## Consequences
* Zero configuration: thresholds adapt to each deployment's traffic personality
* Robust against outlier poisoning (MAD ignores extreme values)
* O(n log n) copy-sort of ≤256 floats at 1 Hz: negligible
