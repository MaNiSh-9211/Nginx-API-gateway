# ADR-0002 — Lua-FFI data plane over a native C-API module

**Status:** Accepted (native module kept as **Experimental**)

## Context

Given Rust-on-NGINX (ADR-0001), there are two ways to invoke Rust per request:

1. **LuaJIT FFI** — OpenResty runs Lua in `access_by_lua`/`log_by_lua`; the Lua
   calls into a Rust `cdylib` via LuaJIT's FFI (a direct C call).
2. **Native NGINX C-API module** — Rust registers an `NGX_HTTP_ACCESS_PHASE`
   handler using the `ngx` crate; no Lua at all.

The repository contains both: `services/gateway/edge/rust-ext` (FFI) and `ngx-rust-native`
(native). We must pick one to ship and verify.

## Decision

Ship the **LuaJIT-FFI** data plane (`services/gateway/edge/rust-ext` + `services/gateway/edge/lua/gateway.lua`).
Keep `ngx-rust-native` as a clearly-marked experiment, excluded from the build.

The FFI surface is a small, stable C ABI (`process_request`, `report_telemetry`,
`release_slot`, `get_metrics_string`, `free_metrics_string`, `init_extension`),
mirrored by an `ffi.cdef` in Lua.

## Alternatives considered

- **Native C-API module (`ngx` crate).** The theoretical win is removing the Lua
  hop. We rejected it because:
  - The `ngx` crate (0.2.x) is early; it pins to a specific NGINX source tree
    and ABI, making builds brittle across NGINX versions.
  - It required downloading and configuring NGINX source at image-build time.
  - Its manifest was missing most dependencies (it did not actually build), and
    pieces like request-body reading for the WAF and a `/metrics` handler were
    not wired.
  - The measured upside is small: a LuaJIT-FFI call is on the order of tens of
    nanoseconds — negligible beside ~200 ns of WAF and ~50 ns of auth.
- **All logic in Lua (no Rust).** Simplest to wire, but interpreted Lua is the
  wrong tool for constant-time HMAC, base64, and zero-alloc scanning, and gives
  up Rust's safety. Rejected.

## Consequences

- A proven, widely-operated pattern (OpenResty + FFI, as used by large CDNs and
  Kong) with a thin, auditable glue layer.
- The Rust crate compiles cleanly and is unit-tested independent of NGINX.
- Cost: one Lua hop per request (tens of ns) and the discipline of keeping
  `ffi.cdef` in lock-step with `lib.rs`.
- The native module remains a documented future direction; promoting it requires
  a benchmark proving a real P99 win (see `ngx-rust-native/README.md`).
