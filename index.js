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
const MAX_CONTEXT_TOKENS = parseInt(process.env.SINKHOLE_MAX_CONTEXT || "0", 10); // 0 = proactive est-tokens check off

const OOC_ERROR_RE = /exceeds the available context size|context size \(\d+\)|too large to compact|too many tokens|prompt is too long/i;
const OVERFLOW_RE = /overflow|context exceeds|too large to compact/i;
const TOOL_PART_TYPES = ["tool", "tool-result", "tool-call"];

const recovered = new Set();

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

function estTokens(messages) {
  let chars = 0;
  for (const m of messages) {
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

export default {
  id: "sinkhole-guard",
  setup: async (ctx) => {
    ensureFindingsDir();
    const startupDeadline = Date.now() + 5000;

    const hasCreate = typeof ctx.session?.create === "function";
    if (!hasCreate) log("warn", "ctx.session.create unavailable - recovery-session chain disabled (findings + hard-stop only)");
    if (MAX_CONTEXT_TOKENS > 0) log("info", `proactive est-tokens check on (limit=${MAX_CONTEXT_TOKENS})`);
    if (FAKE_OOC) log("warn", "FAKE_OOC test mode ON (SINKHOLE_FAKE_OOC=1)");

    async function handlePoison(sid, poison, errText, model, findingsBodyExtra) {
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

      // Unrecoverable classes (overflow / ooc): fresh-session chain
      const title = `RECOVERED: ${poison} in ${sid}`;
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
      if (!sid || recovered.has(sid)) return;

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
      await handlePoison(sid, poison, errText, event.model);
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
        await handlePoison(sid, "ooc", errText.slice(0, 300), event?.model || null);
      });
    } catch (e) {
      log("warn", `compaction hook unavailable: ${e.message}`);
    }
  },
};
