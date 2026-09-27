// sinkhole-guard v2 plugin — detects reasoning-sinkhole, context-overflow, and
// out-of-context (OOC) sessions; writes findings; sinkhole gets an in-place
// recovery prompt; overflow/OOC get a fresh recovery session pointed at the
// findings file, a best-effort task_complete nudge on the old session, and a
// hard stop of the old session.
//
// Detection logic:
//   - "sinkhole": N recent assistant turns with huge reasoning and zero
//     visible text/tool output -> context is poisoned. (v1 shape: finish=length
//     budget consumed; v2 shape: no finish in context events, so a
//     SINKHOLE_REASONING_FLOOR-char reasoning-only heuristic is used instead.)
//   - "overflow": recent tool results with ContextOverflowError-style error
//     text -> session exceeds model context limit.
//   - "ooc": message-level error matching the OOC pattern (v1 shape:
//     finish=error + error "request (N tokens) exceeds the available context
//     size (M tokens)"); in v2 context events messages carry no finish/error,
//     so OOC is captured via the compaction hook (failed auto-compaction
//     carries the same provider error) and/or the env-gated proactive
//     est-tokens check (SINKHOLE_MAX_CONTEXT).
//
// v2 context-event message shape (verified 2026-09-26 via hookprobe):
//   assistant: {id, role:"assistant", content:[{type:"reasoning"|"text"|"tool-call", ...}]}
//   tool:      {id, role:"tool",      content:[{type:"tool-result", name, result:{type:"content"|"error", ...}}]}
//   (v1-shape messages with .info/.parts are also accepted for compatibility)
//
// Test hook: SINKHOLE_FAKE_OOC=1 forces OOC detection on local-provider
// sessions (live verification without burning 131k tokens).

import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

const findingsDir = process.env.SINKHOLE_FINDINGS_DIR || join(homedir(), "opencode", "findings");
const LOG_PREFIX = "[sinkhole-guard]";

// Config (env-overridable)
const SINKHOLE_TURNS = parseInt(process.env.SINKHOLE_TURNS || "3", 10);
const LOCAL_PROVIDERS = (process.env.SINKHOLE_LOCAL_PROVIDERS || "llama-server").split(",").map(s => s.trim());
const OUTPUT_CAP_TOKENS = parseInt(process.env.SINKHOLE_OUTPUT_CAP || "4096", 10);
const MIN_REASONING_CHARS = parseInt(process.env.SINKHOLE_MIN_REASONING || "200", 10);
const REASONING_FLOOR = parseInt(process.env.SINKHOLE_REASONING_FLOOR || "12000", 10);
const FAKE_OOC = process.env.SINKHOLE_FAKE_OOC === "1";
// Proactive est-tokens check. 2026-09-27: the 120000 default caused a false
// positive — estTokens() summed the FULL history of v2 context events
// (including pre-compaction messages the model no longer sees), so a healthy
// 47%-full session over-counted to ~175k and was hard-stopped with a duplicate
// recovery session. Fix (same day): estTokens() now counts only the last
// SINKHOLE_EST_WINDOW (40) messages — the effective post-compaction window
// (that event: last-40 ≈57k vs UI 47% of the 128k window ≈60k) — and
// opencode.jsonc sets SINKHOLE_MAX_CONTEXT=106000 (≈83% of the 128k window;
// effective fire point ~100.7k, below native compaction ~119k).
const MAX_CONTEXT_TOKENS = parseInt(process.env.SINKHOLE_MAX_CONTEXT || "0", 10);
const EST_WINDOW = Math.max(1, parseInt(process.env.SINKHOLE_EST_WINDOW || "40", 10));

// Stop-drain (2026-09-27): a queued user task (OpenChamber queues prompts while
// the session is busy) can be delivered the moment the old session is
// interrupted — the interrupt is treated as "free" and the queued task starts a
// new run. The guard then watches the old session for DRAIN_WINDOW_MS after
// each stop: every new user message is appended to the recovery session's todo
// list and answered with another stop, until the old session stays stopped.
// 0 disables the drain (old behavior).
const DRAIN_WINDOW_MS = parseInt(process.env.SINKHOLE_DRAIN_WINDOW || "60000", 10);
const DRAIN_MAX = parseInt(process.env.SINKHOLE_DRAIN_MAX || "10", 10);
// N17: optional post-recovery deletion of the old (poisoned) session, default OFF.
// When ON and the recovery chain has confirmed the old session is fully stopped
// (and a recovery session exists to carry the work), the plugin best-effort
// deletes the old session so it does not linger. Off by default so the
// contaminated session stays available for the user to review.
const DELETE_OLD = process.env.SINKHOLE_DELETE_OLD_SESSION === "1";
const NUDGE_PREFIX = "POISONED SESSION (";

const OOC_ERROR_RE = /exceeds the available context size|context size \(\d+\)|too large to compact|too many tokens|prompt is too long/i;
const OVERFLOW_RE = /overflow|context exceeds|too large to compact/i;
const TOOL_PART_TYPES = ["tool", "tool-result", "tool-call"];

const recovered = new Set();

// Stop-drain state: sessionID -> drain state. Populated by handlePoison right
// after a hard stop; the context hook routes that session's events through
// drainStep (defined in setup, where ctx is in scope) until the session stays
// stopped for one drain window. (2026-09-27: this registry was once
// referenced-but-undefined, crashing every reply with
// "ReferenceError: drainRegistry is not defined".)
const drainRegistry = new Map();

// Title-probe flag: flipped true after the one-time ctx.session.get/list shape
// probe in the context hook (debug helper for the recovery-session title work).
let titleProbed = false;

function log(level, msg) {
  const line = `${LOG_PREFIX} ${level}: ${msg}`;
  if (level === "error") console.error(line);
  else console.warn(line);
}

function ensureFindingsDir() {
  try { mkdirSync(findingsDir, { recursive: true }); } catch { /* exists */ }
}

function roleOf(msg) {
  return msg?.info?.role || msg?.role || "";
}

function finishOf(msg) {
  return msg?.info?.finish || msg?.finish || null;
}

function partsOf(msg) {
  return msg?.parts || msg?.content || [];
}

function partText(p) {
  if (p?.type === "text") return p.text || "";
  return "";
}

function partErrorText(p) {
  // v1 shape: p.state = {status:"error", error|text}
  const st = p?.state;
  if (st) {
    if (st.status === "error") return st.error || st.text || "";
    if (st.status === "completed" || st.status === "success") return "";
  }
  // v2 shape: p.result = {type:"content"|"error", value:[{type:"text",text}]} or string
  const r = p?.result;
  if (r) {
    if (typeof r === "string") return r;
    const texts = [];
    if (Array.isArray(r.value)) for (const v of r.value) if (typeof v?.text === "string") texts.push(v.text);
    if (r.type === "error") return r.error || r.message || texts.join(" ") || JSON.stringify(r).slice(0, 500);
    return texts.join(" ");
  }
  return "";
}

function userTextsOf(messages) {
  // Set of trimmed user-message texts in a context event (v2 content parts or
  // v1-style .info.content). Used to detect queued user tasks that arrive on a
  // hard-stopped session: a user text not in the detection-time baseline is new.
  const out = new Set();
  for (const m of messages || []) {
    if (roleOf(m) !== "user") continue;
    const t = (partsOf(m).map(partText).join(" ") || m?.info?.content || m?.text || "").trim();
    if (t) out.add(t);
  }
  return out;
}

function partIsError(p) {
  const st = p?.state;
  if (st) return st.status === "error";
  const r = p?.result;
  return !!(r && typeof r === "object" && r.type === "error");
}

function isReasoningOnlyTurn(msg) {
  const role = roleOf(msg);
  if (role !== "assistant") return false;
  const parts = partsOf(msg);
  // Has any tool call?
  if (parts.some(p => TOOL_PART_TYPES.includes(p?.type))) return false;
  // Has any visible text output (not just reasoning)?
  if (parts.some(p => partText(p).length > MIN_REASONING_CHARS)) return false;
  // v1 shape: output budget consumed
  if (finishOf(msg) === "length") return true;
  // v2 shape: context events carry no finish - huge reasoning-only turn heuristic
  const reasoningChars = parts.filter(p => p?.type === "reasoning").reduce((n, p) => n + (p.text || "").length, 0);
  return reasoningChars >= REASONING_FLOOR;
}

function isOverflowTurn(msg) {
  const role = roleOf(msg);
  if (role !== "assistant" && role !== "tool") return false;
  for (const p of partsOf(msg)) {
    if (!TOOL_PART_TYPES.includes(p?.type)) continue;
    if (!partIsError(p)) continue;
    if (OVERFLOW_RE.test(partErrorText(p))) return true;
  }
  return false;
}

function extractOverflowError(messages) {
  for (let i = Math.max(0, messages.length - 6); i < messages.length; i++) {
    for (const p of partsOf(messages[i])) {
      if (!TOOL_PART_TYPES.includes(p?.type)) continue;
      if (!partIsError(p)) continue;
      const text = partErrorText(p);
      if (OVERFLOW_RE.test(text)) return text.slice(0, 300);
    }
  }
  return "";
}

function oocErrorText(msg) {
  const err = msg?.info?.error ?? msg?.error;
  if (!err) return "";
  if (typeof err === "string") return err;
  return err.message || err.type || "";
}

function isOocTurn(msg) {
  if (roleOf(msg) !== "assistant") return false;
  if (finishOf(msg) !== "error") return false;
  return OOC_ERROR_RE.test(oocErrorText(msg));
}

function lastAssistant(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) === "assistant") return messages[i];
  }
  return null;
}

// Count recent reasoning-only assistant turns (tool/user messages between them
// do not break the streak - v2 interleaves role=tool messages).
function countSinkhole(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0 && count < SINKHOLE_TURNS; i--) {
    const role = roleOf(messages[i]);
    if (role !== "assistant") continue;
    if (isReasoningOnlyTurn(messages[i])) count++;
    else break;
  }
  return count;
}

function countOverflow(messages) {
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (roleOf(messages[i]) !== "assistant" && roleOf(messages[i]) !== "tool") continue;
    if (isOverflowTurn(messages[i])) count++;
    else if (roleOf(messages[i]) === "assistant") break;
  }
  return count;
}

// Effective-window token estimate: counts only the last EST_WINDOW messages
// (the effective post-compaction window — see SINKHOLE_MAX_CONTEXT comment
// above for why a full-history sum over-counts on v2 context events).
function estTokens(messages) {
  let chars = 0;
  for (const m of messages.slice(-EST_WINDOW)) {
    for (const p of partsOf(m)) {
      if (p?.type === "text" || p?.type === "reasoning") chars += (p.text || "").length;
      else if (TOOL_PART_TYPES.includes(p?.type)) chars += JSON.stringify(p.state || p.result || "").length;
    }
  }
  return Math.ceil(chars / 4);
}

function providerOf(model) {
  // model might be { providerID, id } or "provider/model"
  if (typeof model === "string") return model.split("/")[0] || "";
  return model?.providerID || "";
}

// Recovery-session title: "RECOVERED: <old session title>" (user requirement
// 2026-09-27). A RECOVERED:-prefixed old title is stripped first so we never
// produce "RECOVERED: RECOVERED: X"; if the title is already taken by another
// session, " 2", " 3", ... is appended. Any API failure falls back to the
// id-based title (previous behavior), and nothing here may throw.
async function recoveryTitleFor(ctx, sid, poison) {
  const fallback = `RECOVERED: ${poison} in ${sid}`;
  let oldTitle = null;
  try {
    if (typeof ctx.session?.get === "function") {
      const s = await ctx.session.get({ sessionID: sid });
      if (s && typeof s.title === "string" && s.title) oldTitle = s.title;
    }
  } catch (e) {
    log("info", "recoveryTitleFor get err: " + e.message);
  }
  if (!oldTitle) {
    try {
      const all = typeof ctx.session?.list === "function" ? await ctx.session.list() : null;
      const hit = Array.isArray(all) ? all.find(s => s && s.id === sid) : null;
      if (hit && typeof hit.title === "string" && hit.title) oldTitle = hit.title;
    } catch (e) {
      log("info", "recoveryTitleFor list err: " + e.message);
    }
  }
  const clean = oldTitle ? oldTitle.replace(/^(?:RECOVERED:\s*)+/, "").trim() : "";
  if (!clean) return fallback;
  let title = `RECOVERED: ${clean}`;
  try {
    const all = typeof ctx.session?.list === "function" ? await ctx.session.list() : null;
    const taken = new Set();
    if (Array.isArray(all)) for (const s of all) if (s && typeof s.title === "string") taken.add(s.title);
    let n = 1;
    while (taken.has(title) && n < 50) {
      n++;
      title = `RECOVERED: ${clean} ${n}`;
    }
  } catch (e) {
    log("info", "recoveryTitleFor dedupe err: " + e.message);
  }
  return title;
}

export default {
  id: "sinkhole-guard",
  setup: async (ctx) => {
    ensureFindingsDir();
    const startupDeadline = Date.now() + 5000;

    const hasCreate = typeof ctx.session?.create === "function";
    if (!hasCreate) log("warn", "ctx.session.create unavailable - recovery-session chain disabled (findings + hard-stop only)");
    log("info", "ctx.session fns: " + Object.keys(ctx.session || {}).filter(k => typeof ctx.session[k] === "function").join(","));
    if (MAX_CONTEXT_TOKENS > 0) log("info", `proactive est-tokens check on (limit=${MAX_CONTEXT_TOKENS})`);
    if (FAKE_OOC) log("warn", "FAKE_OOC test mode ON (SINKHOLE_FAKE_OOC=1)");

    // N17: optional post-recovery cleanup of the old (contaminated) session.
    // Default OFF. Called ONLY from drain.finish once the stop-drain window has
    // confirmed the old session is quiescent — i.e. no queued user comment
    // arrived during the window. Deleting earlier (right after the first hard
    // stop) would break the stop-drain — the very mechanism that captures queued
    // user comments and forwards them to the recovery session — and could delete
    // a session the user is still actively commenting on.
    // Best-effort with a guaranteed manual-cleanup floor:
    //   S1: ctx.session.delete / .remove (in-process, feature-detect)
    //   S2: `opencode session delete <id>` (CLI, skipped under the offline harness)
    //   S3: append a manual-cleanup note to the findings file
    async function maybeDeleteOld(sid, findingsPath, newSid) {
      if (!DELETE_OLD) return;
      log("warn", `${sid}: old-session cleanup requested (SINKHOLE_DELETE_OLD_SESSION=1)`);
      const note = (line) => {
        try { appendFileSync(findingsPath, `\n- Old-session cleanup: ${line}\n`); }
        catch { /* best effort */ }
      };
      const del = ["delete", "remove"].map((k) => ctx.session?.[k]).find((f) => typeof f === "function");
      if (typeof del === "function") {
        try {
          await del.call(ctx.session, { sessionID: sid });
          note(`deleted via ctx.session (recovery session ${newSid} carries the work)`);
          log("info", `${sid}: old session deleted via ctx.session`);
          return;
        } catch (e) {
          log("warn", `${sid}: ctx.session delete failed: ${e.message}`);
        }
      }
      if (process.env.SINKHOLE_HARNESS !== "1") {
        try {
          await new Promise((resolve, reject) => {
            execFile("opencode", ["session", "delete", sid],
              { timeout: 10000, maxBuffer: 1024 * 1024 },
              (error, stdout, stderr) =>
                error ? reject(new Error(String(stderr || error.message || error).slice(0, 160))) : resolve());
          });
          note(`deleted via opencode CLI (recovery session ${newSid} carries the work)`);
          log("info", `${sid}: old session deleted via opencode CLI`);
          return;
        } catch (e) {
          log("warn", `${sid}: CLI delete failed: ${e.message}`);
        }
      }
      note(`MANUAL: no delete mechanism available in this build - run \`opencode session delete ${sid}\` (or delete in the GUI); recovery session ${newSid} carries the work`);
      log("warn", `${sid}: old-session cleanup not possible here - manual note appended`);
    }

    // One stop-drain step: first event after the stop learns the user-text
    // baseline (compaction path); afterwards any user text NOT in the baseline
    // is a queued task -> append to the recovery session's todo + re-stop, and
    // reset the window. Window expiry calls drain.finish (registry cleanup +
    // findings note).
    async function drainStep(sid, drain, messages) {
      if (!drain.baselineFetched) {
        drain.baseline = userTextsOf(messages);
        drain.baselineFetched = true;
        if (drain.deadline) clearTimeout(drain.deadline);
        drain.deadline = setTimeout(() => drain.finish(true), DRAIN_WINDOW_MS);
        return;
      }
      let fresh = null;
      for (const t of userTextsOf(messages)) {
        if (!drain.baseline.has(t) && !t.startsWith(NUDGE_PREFIX) && !t.startsWith("DRAIN:")) {
          fresh = t;
          break;
        }
      }
      if (!fresh) return;
      drain.baseline.add(fresh);
      drain.count++;
      log("warn", `${sid}: queued user task during stop (drain #${drain.count}): ${fresh.slice(0, 120)}`);
      try {
        await ctx.session.prompt({
          sessionID: drain.newSid,
          text: `DRAIN: the poisoned session ${sid} just received this queued user task while we were stopping it. Add it to the BOTTOM of your todo list (process it after your current work if they conflict), then continue: ${fresh.slice(0, 2000)}`,
        });
        log("info", `${sid}: queued task appended to recovery session ${drain.newSid}`);
      } catch (e) {
        log("error", `${sid}: could not append queued task to recovery session: ${e.message}`);
      }
      try {
        await ctx.session.interrupt({ sessionID: sid });
        log("warn", `${sid}: re-stopped (drain #${drain.count})`);
      } catch (e) {
        log("warn", `${sid}: re-stop failed: ${e.message}`);
      }
      if (drain.deadline) clearTimeout(drain.deadline);
      if (drain.count >= DRAIN_MAX) {
        log("error", `${sid}: stop-drain max iterations (${DRAIN_MAX}) - MANUAL action may be required`);
        drain.finish(false);
        return;
      }
      drain.deadline = setTimeout(() => drain.finish(true), DRAIN_WINDOW_MS);
    }

    async function handlePoison(sid, poison, errText, model, findingsBodyExtra, baselineUserTexts) {
      log("warn", `${sid}: poison=${poison}${errText ? ` err=${errText.slice(0, 120)}` : ""}`);
      recovered.add(sid);

      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const findingsPath = join(findingsDir, `${poison}_${sid}_${stamp}.md`);
      const body = [
        `# Sinkhole-guard recovery — ${sid}`,
        ``,
        `- Detected: ${new Date().toISOString()}`,
        `- Pattern: ${poison === "overflow" ? "context overflow (tool error)" : poison === "ooc" ? "out-of-context (provider rejected request: context limit)" : "reasoning sinkhole (recent reasoning-only turns)"}`,
        `- Model: ${providerOf(model)}/${model?.id || "unknown"}`,
        `- Output cap: ${OUTPUT_CAP_TOKENS} tokens`,
        errText ? `- Error: ${errText}` : null,
        ``,
        `## What happened`,
        ``,
        poison === "sinkhole"
          ? `Recent turns burned output budget on reasoning with zero text/tool output. Further "continue" prompts feed the same sinkhole.`
          : `The session hit the model context limit. Auto-compaction re-errors; the session can never recover on its own.`,
        ``,
        `## Recovery`,
        ``,
        poison === "sinkhole"
          ? `In-place recovery prompt injected. Abandon this session if the pattern continues.`
          : `A fresh recovery session was created and seeded with this findings file; the old session got a best-effort task_complete nudge, then was hard-stopped.`,
        ...(findingsBodyExtra || []),
        ``,
      ].filter(Boolean).join("\n");

      try {
        writeFileSync(findingsPath, body);
        log("info", `${sid}: findings written to ${findingsPath}`);
      } catch (e) {
        log("error", `${sid}: could not write findings: ${e.message}`);
        recovered.delete(sid);
        return;
      }

      // Recoverable class: in-place recovery prompt (no hard stop)
      if (poison === "sinkhole") {
        const seed = `RECOVERY: This session has a reasoning sinkhole (recent reasoning-only turns, no visible output). Read findings: ${findingsPath}. Stop the current pattern; take a different approach or abandon this session.`;
        try {
          await ctx.session.prompt({ sessionID: sid, noReply: true, text: seed });
          log("warn", `${sid}: recovery prompt injected (findings at ${findingsPath})`);
        } catch (e) {
          log("error", `${sid}: recovery prompt failed: ${e.message}`);
        }
        return;
      }

      // Unrecoverable classes (overflow / ooc): fresh-session chain.
      // Title: "RECOVERED: <old session title>" (numbered on duplicate,
      // RECOVERED:-prefix stripped; id-based fallback if API unavailable).
      const title = await recoveryTitleFor(ctx, sid, poison);
      let newSid = null;
      let seeded = false;

      if (hasCreate) {
        try {
          const res = await ctx.session.create({ title });
          newSid = res && typeof res === "object" ? (res.id || res.sessionID || res.session_id || null) : (typeof res === "string" ? res : null);
          if (newSid) log("info", `${sid}: recovery session created: ${newSid}`);
          else log("warn", `${sid}: session.create returned no id: ${JSON.stringify(res).slice(0, 120)}`);
        } catch (e) {
          log("error", `${sid}: session.create failed: ${e.message}`);
        }
      }

      if (newSid) {
        const seed = `This session continues work from a poisoned session (${sid}, ${poison}). Read the findings file FIRST: ${findingsPath}\nThen continue the work described there. Keep reasoning short; report results in 5 lines max.`;
        try {
          await ctx.session.prompt({ sessionID: newSid, text: seed });
          seeded = true;
          log("warn", `${sid}: recovery session ${newSid} seeded with findings pointer`);
        } catch (e) {
          log("error", `${sid}: seeding recovery session failed: ${e.message}`);
        }
      }

      // Best-effort task_complete nudge on the old session (before the hard stop)
      try {
        await ctx.session.prompt({
          sessionID: sid,
          noReply: true,
          text: `POISONED SESSION (${poison}): work is being continued in a recovery session. Call the task_complete tool now with a one-line summary of what was done (see ${findingsPath}), then stop.`,
        });
        log("info", `${sid}: task_complete nudge injected`);
      } catch (e) {
        log("warn", `${sid}: task_complete nudge failed (best effort): ${e.message}`);
      }

      // Hard stop the old session
      let stopped = false;
      try {
        await ctx.session.interrupt({ sessionID: sid });
        stopped = true;
        log("warn", `${sid}: hard-stopped (interrupt)`);
      } catch (e) {
        log("warn", `${sid}: interrupt failed: ${e.message}`);
      }

      // Stop-drain: queued user tasks can be delivered the moment the
      // interrupt lands (the interrupt counts as "free"), re-activating the
      // dead session. While the drain window is open, every new user message
      // on the old session is appended to the recovery session's todo list and
      // answered with another stop, until the session stays stopped.
      if (DRAIN_WINDOW_MS > 0 && newSid) {
        const drain = {
          newSid,
          findingsPath,
          baseline: new Set(baselineUserTexts || []),
          baselineFetched: baselineUserTexts != null,
          count: 0,
          deadline: null,
        };
        drain.finish = (quiescent) => {
          if (drain.deadline) { clearTimeout(drain.deadline); drain.deadline = null; }
          drainRegistry.delete(sid);
          try {
            appendFileSync(drain.findingsPath,
              `\n- Stop-drain: ${drain.count} queued task(s) absorbed into ${drain.newSid}; old session ${sid} fully stopped.\n`);
          } catch { /* best effort */ }
          log("info", `${sid}: stop-drain complete (${drain.count} queued task(s) absorbed)`);
          // N17: only delete the old session once stop-drain confirms it is
          // QUIESCENT (window closed with no further queued user comment). The
          // max-iterations path calls finish(false) — the session may still be
          // receiving comments, so it is NOT quiescent and is left for manual
          // review (this is also what keeps the old session available so the
          // user can see exactly what happened before it was removed).
          if (quiescent) maybeDeleteOld(sid, drain.findingsPath, drain.newSid);
        };
        drainRegistry.set(sid, drain);
        drain.deadline = setTimeout(() => drain.finish(true), DRAIN_WINDOW_MS);
        log("info", `${sid}: stop-drain armed (window=${DRAIN_WINDOW_MS}ms, max=${DRAIN_MAX})`);
      }

      try {
        appendFileSync(findingsPath,
          `\n## Chain result\n` +
          `- Recovery session: ${newSid || "NONE (create unavailable/failed)"}${seeded ? " (seeded)" : newSid ? " (seed FAILED)" : ""}\n` +
          `- Old session ${sid}: ${stopped ? "hard-stopped" : "hard-stop FAILED - MANUAL action required"}\n`
        );
      } catch { /* best effort */ }
    }

    await ctx.session.hook("context", async (event) => {
      if (Date.now() < startupDeadline) return;

      const sid = event.sessionID;
      if (!sid) return;
      if (!titleProbed) {
        titleProbed = true;
        try {
          if (typeof ctx.session?.get === "function") {
            const s = await ctx.session.get({ sessionID: sid });
            log("info", "session.get shape: " + JSON.stringify(Object.keys(s || {})) + " title=" + JSON.stringify((s || {}).title));
          }
          const all = await ctx.session.list();
          log("info", "session.list n=" + (Array.isArray(all) ? all.length : "?") + " entryKeys=" + JSON.stringify(Object.keys(Array.isArray(all) && all[0] ? all[0] : {})));
        } catch (e) {
          log("info", "title probe err: " + e.message);
        }
      }
      const drain = drainRegistry.get(sid);
      if (drain) {
        await drainStep(sid, drain, event.messages || []);
        return;
      }
      if (recovered.has(sid)) return;

      // Only evaluate for local providers
      const provider = providerOf(event.model);
      if (!LOCAL_PROVIDERS.includes(provider)) return;

      const messages = event.messages;
      if (!messages || messages.length < 3) return;

      const sinkholeCount = countSinkhole(messages);
      const overflowCount = countOverflow(messages);
      const lastAsst = lastAssistant(messages);
      let oocErr = FAKE_OOC
        ? "FAKE_OOC (SINKHOLE_FAKE_OOC=1) - live verification"
        : (isOocTurn(lastAsst) ? oocErrorText(lastAsst).slice(0, 300) : "");
      if (!oocErr && MAX_CONTEXT_TOKENS > 0) {
        const est = estTokens(messages);
        if (est > MAX_CONTEXT_TOKENS * 0.95) oocErr = `proactive: est ${est} tokens vs limit ${MAX_CONTEXT_TOKENS}`;
      }

      const poison = overflowCount > 0 ? "overflow" : oocErr ? "ooc" : sinkholeCount >= SINKHOLE_TURNS ? "sinkhole" : null;
      if (!poison) return;

      const errText = overflowCount > 0 ? extractOverflowError(messages) : oocErr;
      await handlePoison(sid, poison, errText, event.model, null, userTextsOf(messages));
    });

    // OOC via failed auto-compaction (v2: context events carry no message-level
    // finish/error, but compaction failures surface the same provider error).
    try {
      await ctx.session.hook("compaction", async (event) => {
        if (Date.now() < startupDeadline) return;
        const sid = event?.sessionID;
        if (!sid || recovered.has(sid)) return;
        const evErr = event?.error ?? event?.data?.error;
        const errText = evErr ? (typeof evErr === "string" ? evErr : evErr.message || evErr.type || JSON.stringify(evErr).slice(0, 300)) : "";
        if (!OOC_ERROR_RE.test(errText)) return;
        log("warn", `${sid}: OOC via compaction event: ${errText.slice(0, 160)}`);
        await handlePoison(sid, "ooc", errText.slice(0, 300), event?.model || null, null, null);
      });
    } catch (e) {
      log("warn", `compaction hook unavailable: ${e.message}`);
    }
  },
};
