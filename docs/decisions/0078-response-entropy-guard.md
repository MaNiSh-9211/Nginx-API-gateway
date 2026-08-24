# ADR-0078: Response Entropy Guard

## Status: Accepted

## Context
The most dangerous upstream failure mode is returning 200 OK with garbage. Health checks pass, status codes look fine, but users see broken data.

## Decision
Shannon entropy of response bodies detects silent failure. Healthy JSON APIs have ~4.5 bits/byte; identical error pages have ~0. A rolling per-upstream entropy window detects collapse when median drops below 30% of baseline.

## Consequences
* Catches failures invisible to status-code monitoring
* Rolling window self-calibrates per-upstream
* Zero false positives on legitimate low-entropy responses (checked against MIN_HEALTHY_ENTROPY)
