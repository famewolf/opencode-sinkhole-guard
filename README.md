# opencode-sinkhole-guard

A defensive OpenCode plugin that watches a session for the two failure modes that can turn a local (GPU) model run into a **runaway, unrecoverable loop** — and intervenes before it burns hours of compute and leaves a dead session behind.

It is the **last line of defense** for long-running, unattended local-agent sessions.

## What it detects

The plugin hooks the session's `context` (and `compaction`) events and classifies each turn. It only acts on sessions using the configured **local** providers (default `llama-server`), so it never interferes with cloud runs.

### 1. Reasoning "sinkhole"
A turn that produces a very long reasoning block but **no visible text and no tool calls** (the model is "talking to itself" and going nowhere). After `SINKHOLE_TURNS` consecutive such turns, the session is considered stuck in a reasoning loop.

- **v1** signals `finish = "length"` (truncated output, no content).
- **v2** signals a reasoning part at/above `SINKHOLE_REASONING_FLOOR` chars with no text > 200 chars and no tool parts.

### 2. Context overflow / out-of-context (OOC)
A tool-part **error** whose text matches `overflow | context exceeds | too large to compact` — i.e. the request is structurally too large.

- **v1** also catches a message-level `finish = "error"` carrying a `provider.invalid-request` / OOC error (the exact shape of the incident).
- **v2** catches a failed `compaction` event with an OOC error, and — when enabled — a **proactive** check that the estimated token count is approaching the model's context limit.

## Why (the incident this exists for)

Session `ses_f239075d3ffe…` (a 131k-context `llama-server/coder` run) hit an out-of-context 400:

```
request (137039 tokens) exceeds the available context size (131072 tokens), try increasing it
```

The combined effect of a broken retry counter in the auto-resume plugin plus a compaction that kept failing was a **death spiral**: **193** synthetic `continue` injections, **46** failed auto-compactions, and a session that was never usable again. The injected messages weren't visible in the UI, so the only way to discover the loop was to audit the SQLite store by hand.

`opencode-sinkhole-guard` is what would have broken that loop: it detects the OOC condition, and instead of letting `continue`-injections spin forever, it **recovers the work into a fresh session and hard-stops the poisoned one**.

## What it does when it fires

### For **overflow / OOC** (unrecoverable in-place) — the recovery chain:
1. **Writes a findings file** to `SINKHOLE_FINDINGS_DIR` (default `~/opencode/findings/`): `ooc_<session>_<timestamp>.md` with the error, model, and what to do next.
2. **Creates a fresh "RECOVERED" session** (via `ctx.session.create`) whose first message points it at that findings file: *"Read the findings file FIRST … then continue the work described there."*
3. Sends a best-effort **`task_complete`** nudge to the old (poisoned) session.
4. **Hard-stops the old session** (`ctx.session.interrupt`).
5. Appends the recovery chain's result (new session id) to the findings file.

The work is not lost — it is handed to a clean session that starts with a tiny context and reads the findings.

### For a **reasoning sinkhole** (recoverable in-place):
It injects a single corrective prompt nudge (no new session, no hard-stop) — the model is usually just stuck and a nudge gets it moving again.

A session that has already been recovered is remembered (per-run) and never re-triggered.

## Configuration (env vars)

All optional; sensible defaults shown.

| Variable | Default | Meaning |
|---|---|---|
| `SINKHOLE_TURNS` | `3` | Consecutive reasoning-only turns before a sinkhole is declared. |
| `SINKHOLE_LOCAL_PROVIDERS` | `llama-server` | Comma-list of providers the guard watches (only these). |
| `SINKHOLE_OUTPUT_CAP` | `4096` | Output token cap used to spot a truncated (length) turn. |
| `SINKHOLE_MIN_REASONING` | `200` | Minimum reasoning chars to count a turn as "reasoning-only". |
| `SINKHOLE_REASONING_FLOOR` | `12000` | v2: reasoning chars at/above which a turn counts as a sinkhole turn. |
| `SINKHOLE_MAX_CONTEXT` | `0` (off) | v2: proactive check — estimated tokens at/above this trips OOC *before* the 400. |
| `SINKHOLE_FINDINGS_DIR` | `~/opencode/findings/` | Where findings files are written. |
| `SINKHOLE_FAKE_OOC` | `0` | **Test mode** — force an OOC on the first local turn (used by the live probe). Never enable in real use. |

## Installation

Drop the directory into your OpenCode plugins folder and register it in `opencode.jsonc`:

```jsonc
{
  "plugin": [
    "file:///<path>/opencode/plugins/sinkhole-guard"
  ]
}
```

The plugin loads on server start (and is hot-reloaded when `opencode.jsonc` changes). No other setup is required.

## Verification

- **Offline harness** (`guard_v2_harness.mjs`): 30 assertions covering v1 + v2 message shapes, sinkhole/overflow/OOC detection, the full recovery chain, and the FAKE_OOC path — all pass.
- **Live probe** (standalone OpenCode v2 server, `SINKHOLE_FAKE_OOC=1`): the full chain fired end-to-end — findings written, a RECOVERED session created and seeded with the findings pointer, a `task_complete` nudge injected, and the poisoned session hard-stopped.

## Relation to `opencode-auto-resume`

`auto-resume` *reacts to stalls* by injecting `continue`; this guard *detects the failure mode that makes `continue` useless (or worse) and recovers the session properly*. They are complementary: the companion PR to `auto-resume` fixes its retry-counter reset and adds an OOC lock so it stops looping; this guard is the backstop that catches what slips through and hands the work to a fresh session.
