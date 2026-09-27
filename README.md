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
   **Title:** `RECOVERED: <old session title>` (looked up via `ctx.session.get`, falling back to `list`). A `RECOVERED:-`-prefixed old title is stripped first (never `RECOVERED: RECOVERED: X`); if the title is already taken, ` 2`, ` 3`, … is appended. If the title API is unavailable, falls back to `RECOVERED: <pattern> in <session-id>`.
3. Sends a best-effort **`task_complete`** nudge to the old (poisoned) session.
4. **Hard-stops the old session** (`ctx.session.interrupt`).
5. **Arms the stop-drain** (see below): queued user tasks can re-activate the
   just-stopped session; each is absorbed into the recovery session and
   answered with another stop.
6. Appends the recovery chain's result (new session id) to the findings file.
7. **Optional cleanup** (`SINKHOLE_DELETE_OLD_SESSION=1`, off by default): once the
   old session is confirmed fully stopped (the stop-drain window has expired
   *quiescently* — never while queued tasks are still being absorbed), the old
   session is deleted; the RECOVERED session carries the work. It stays off by
   default so the poisoned session remains available to review what happened.

The work is not lost — it is handed to a clean session that starts with a tiny context and reads the findings.

### For a **reasoning sinkhole** (recoverable in-place):
It injects a single corrective prompt nudge (no new session, no hard-stop) — the model is usually just stuck and a nudge gets it moving again.

A session that has already been recovered is remembered (per-run) and never re-triggered.

### Stop-drain: queued tasks that re-activate a stopped session

When a poisoned session is hard-stopped, user prompts that were queued while it
was busy (OpenChamber queues prompts until a session goes idle) can be delivered
the moment it becomes "free" — the interrupt itself counts as free — and start
a new run on the dead session, where they would spin until the next OOM and
could trigger a *second* recovery session.

While `SINKHOLE_DRAIN_WINDOW` is open after every stop, the guard watches the
old session:

- any **new** user message (not present at stop time) is appended to the
  recovery session's todo list — *"add this task to the BOTTOM of your todo
  list"* — and the old session is **interrupted again**;
- the window resets with every absorbed task and closes when the old session
  stays stopped for one full window; the outcome is appended to the findings
  file (`Stop-drain: N queued task(s) absorbed … fully stopped`).

Baseline = the user-message texts present in the detection-time context event
(the compaction path learns the baseline from the first context event after
the stop). The `task_complete` nudge and drain prompts are excluded by prefix.
Caveats: re-sending an old task's *exact* text is not treated as new, and if a
queued task arrives before the nudge run it may execute once on the old
session.

## Configuration (env vars)

All optional; sensible defaults shown.

| Variable | Default | Meaning |
|---|---|---|
| `SINKHOLE_TURNS` | `3` | Consecutive reasoning-only turns before a sinkhole is declared. |
| `SINKHOLE_LOCAL_PROVIDERS` | `llama-server` | Comma-list of providers the guard watches (only these). |
| `SINKHOLE_OUTPUT_CAP` | `4096` | Output token cap used to spot a truncated (length) turn. |
| `SINKHOLE_MIN_REASONING` | `200` | Minimum reasoning chars to count a turn as "reasoning-only". |
| `SINKHOLE_REASONING_FLOOR` | `12000` | v2: reasoning chars at/above which a turn counts as a sinkhole turn. |
| `SINKHOLE_MAX_CONTEXT` | `0` (off) | v2: proactive check — effective-window est-tokens above 95% of this trips OOC *before* the provider's 400. **Re-enabled 2026-09-27 at `106000`** (≈83% of the 128k window; fires ~100.7k, below native compaction ~119k) after the estimator was fixed — the earlier FP (full-history over-count of a healthy 47%-full session) cannot recur. |
| `SINKHOLE_EST_WINDOW` | `40` | Number of most-recent messages counted by the est-tokens estimate (the effective post-compaction window — v2 context events carry the full history, so a full-history sum over-counts). |
| `SINKHOLE_DRAIN_WINDOW` | `60000` | Stop-drain window in ms after each stop (0 = off, old behavior). |
| `SINKHOLE_DRAIN_MAX` | `10` | Max drain iterations before a manual-action warning. |
| `SINKHOLE_DELETE_OLD_SESSION` | `0` (off) | Optional post-recovery cleanup: delete the old (poisoned) session once it is confirmed fully stopped (quiescent stop-drain expiry; never on the max-iterations path). Deletion tries `ctx.session.delete`, then the `opencode` CLI; if this build exposes neither, a MANUAL-cleanup note is appended to the findings. Off by default so the old session stays available for review. |
| `SINKHOLE_FINDINGS_DIR` | `~/opencode/findings/` | Where findings files are written. |
| `SINKHOLE_FAKE_OOC` | `0` | **Test mode** — force an OOC on the first local turn (used by the live probe). Never enable in real use. |

If the number of knobs keeps growing, these may move into a dedicated
`sinkhole-guard` settings file; for now every option is a plain env var.

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

- **Offline harness** (`guard_v2_harness.mjs`): 37 assertions across three passes — v1 + v2 message shapes, sinkhole/overflow/OOC detection, the full recovery chain, the FAKE_OOC path, and the optional old-session delete (S1 `ctx.session.delete` + S3 MANUAL-fallback) — all pass.
- **Live probe** (standalone OpenCode v2 server, `SINKHOLE_FAKE_OOC=1`): the full chain fired end-to-end — findings written, a RECOVERED session created and seeded with the findings pointer, a `task_complete` nudge injected, and the poisoned session hard-stopped.

## Relation to `opencode-auto-resume`

`auto-resume` *reacts to stalls* by injecting `continue`; this guard *detects the failure mode that makes `continue` useless (or worse) and recovers the session properly*. They are complementary: the companion PR to `auto-resume` fixes its retry-counter reset and adds an OOC lock so it stops looping; this guard is the backstop that catches what slips through and hands the work to a fresh session.
