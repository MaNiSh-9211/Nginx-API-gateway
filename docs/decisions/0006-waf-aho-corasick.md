# ADR-0006 — WAF built on Aho-Corasick multi-pattern matching

**Status:** Accepted

## Context

We want an inline WAF that blocks the common, high-signal attacks (injection,
traversal, scanners) on the hot path without becoming a latency sink or a false-
positive generator. It must scan the URI (including query string), request
bodies, and the User-Agent, and it must resist trivial encoding bypasses.

## Decision

Implement the WAF in Rust using **Aho-Corasick** automata (the `aho-corasick`
crate):

- Two compiled automata (built once, `lazy_static`): an **injection** set
  (`../`, `<script`, `union select`, `' or '1'='1`, `/etc/passwd`, SSRF schemes,
  template-injection markers, …) and a **scanner User-Agent** set (`sqlmap`,
  `nikto`, `nmap`, …), both ASCII-case-insensitive.
- **Single-pass, allocation-light** matching: one traversal finds any of N
  patterns in O(text length), independent of pattern count.
- **Recursive URL-decoding** (up to 3 passes) before matching to defeat
  `%253Cscript` double-encoding bypasses.
- **Per-IP rate limit** for unauthenticated traffic (default 100 RPS, override
  via `WAF_IP_RATE_LIMIT_RPS`). Authenticated traffic uses per-user limits
  (ADR-0007) instead.
- **Full request URI** is scanned (path + query), not just the normalized path,
  so query-string payloads are caught (see `lib.rs` query/route split).
- **Size guards** (URI/header/UA/body caps) short-circuit obviously abusive
  requests with 400.
- Runs **before auth** so unauthenticated attackers are cheap to reject; a
  belt-and-suspenders NGINX-level `..` guard sits in front of Lua too.

## Alternatives considered

- **Regex rule sets (e.g. one regex per rule).** Flexible, but N regexes = N
  scans, with catastrophic-backtracking risk (ReDoS) turning the WAF into a DoS
  vector. Aho-Corasick is linear and backtrack-free.
- **ModSecurity + OWASP CRS.** Comprehensive and well-known, but heavyweight,
  higher latency, and a large false-positive tuning burden; integrating it into
  this Rust/OpenResty path adds significant operational complexity. We favor a
  small, fast, high-signal core and leave deep inspection to a dedicated WAF
  upstream if needed.
- **Offload to a cloud WAF only.** Useful at the edge (ADR-0018) but we still
  want a cheap inline backstop that travels with the gateway.

## Consequences

- Linear-time, low-latency screening with no ReDoS exposure.
- Easy to extend (add a pattern to a list).
- Cost: a curated pattern list is less expressive than full rule engines (it will
  not catch novel/obfuscated attacks a CRS might). It is positioned as a fast
  first line, composable with an external WAF for defense in depth. Pattern
  changes require a redeploy (they are compiled in), which is acceptable for a
  security-sensitive, reviewed list.
