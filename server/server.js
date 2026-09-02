import "dotenv/config";
import express from "express";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_REALTIME_MODEL || "gpt-realtime";
const VOICE = process.env.OPENAI_REALTIME_VOICE || "cedar";
const SCORE_MODEL = process.env.ANTHROPIC_MODEL || "claude-opus-5";
// Cheaper/faster model for the background memory update (a summarisation task).
const MEMORY_MODEL = process.env.MEMORY_MODEL || "claude-sonnet-5";
const MEMORY_DIR = path.join(ROOT, "memory");

// Preferred picker order.
const PERSONA_ORDER = ["interviewer", "jamie", "matt-murphy", "time-poor-gp"];

// Universal voice guard — appended to every persona regardless of mode.
const VOICE_GUARD = `

---
How to sound like a real human on the phone:
- Speak in a natural British English accent — contemporary London / RP, the way a London professional actually sounds. British phrasing and rhythm throughout.
- Keep your turns short and conversational, the way people actually talk on a call. Leave a natural beat before you respond; don't jump on the end of every sentence.
- Stay fully in character throughout. Never mention being an AI, a model, or a simulation.`;

// Discovery-mode only: how a buyer answers a founder's call.
const DISCOVERY_OPEN = `
- The founder has called YOU. Open the way a real person answers a scheduled call: a brief warm greeting, a moment of rapport, confirm you've got a few minutes — and let the founder introduce themselves and explain why they're calling. Do NOT launch into business or start probing in the first minute; let the conversation warm up first.`;

// Fallback when no persona is chosen.
const GENERIC_BUYER = `You are a busy, mildly sceptical B2B buyer taking a discovery call from a founder you don't know well. You'll chat about the market but you're slippery on specifics and make the caller work to get anything concrete.`;

// --- Persona files -------------------------------------------------------
function loadPersona(id) {
  const safe = String(id).replace(/[^a-z0-9-]/gi, "");
  if (!safe) return null;
  const file = path.join(ROOT, "personas", safe + ".md");
  if (!fs.existsSync(file)) return null;
  const text = fs.readFileSync(file, "utf8");
  const nameMatch = text.match(/^#\s+(.+)$/m);
  const modeMatch = text.match(/<!--\s*mode:\s*([a-z]+)\s*-->/i);
  return {
    id: safe,
    name: nameMatch ? nameMatch[1].trim() : safe,
    mode: modeMatch ? modeMatch[1].toLowerCase() : "discovery",
    instructions: text,
  };
}

function listPersonas() {
  const dir = path.join(ROOT, "personas");
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .map((f) => loadPersona(f.replace(/\.md$/, "")))
    .filter(Boolean)
    .map((p) => ({ id: p.id, name: p.name, mode: p.mode }))
    .sort((a, b) => {
      const ia = PERSONA_ORDER.indexOf(a.id);
      const ib = PERSONA_ORDER.indexOf(b.id);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
}

// --- Session log ---------------------------------------------------------
function loadHistory(mode, limit = 8) {
  const dir = path.join(ROOT, "sessions");
  if (!fs.existsSync(dir)) return "(no prior sessions)";
  const parsed = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
      } catch {
        return null;
      }
    })
    .filter((r) => r && (r.mode || "discovery") === mode);
  const recent = parsed.slice(-limit).map((r) => {
    const s = r.scorecard || {};
    const note =
      mode === "concision"
        ? (s.drill || []).join("; ")
        : (s.missed || []).join("; ");
    return `- ${r.ts} • ${r.persona} • ${s.overall_score ?? "?"}/10 • ${note || "—"}`;
  });
  return recent.length ? recent.join("\n") : "(no prior sessions)";
}

// --- Cross-session memory (per-mode profile of the caller) ----------------
function loadProfile(mode) {
  const file = path.join(MEMORY_DIR, `${mode}.md`);
  try {
    return fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  } catch {
    return "";
  }
}

// Runs in the background after a scorecard — merges the latest session into a
// compact running profile the persona reads on the next call.
async function updateProfile(mode, transcript, scorecard) {
  if (!process.env.ANTHROPIC_API_KEY) return;
  const prev = loadProfile(mode) || "(none yet)";
  const convo = transcript
    .map((t) => `${t.who === "you" ? "CALLER" : "OTHER"}: ${t.text}`)
    .join("\n");
  const kind =
    mode === "concision"
      ? "answering interview questions concisely and sharply"
      : "running discovery calls with buyers";
  const system = `You maintain a running coaching profile of one person (the user) who is practising ${kind}. You are given the PREVIOUS profile and the LATEST session (its transcript and scorecard). Output an UPDATED profile in markdown, under 250 words, that MERGES the two — consolidate rather than append, drop stale one-offs, and keep only patterns that matter. Capture: (1) recurring strengths and weaknesses, especially anything repeating across sessions; (2) specific verbal habits or filler they overuse, quoted; (3) topics and questions already covered, so they are not repeated next time; (4) their score trend. Be concrete and grounded in what actually happened. Output ONLY the profile markdown, no preamble.`;
  const user = `PREVIOUS PROFILE:\n${prev}\n\nLATEST SCORECARD:\n${JSON.stringify(scorecard)}\n\nLATEST TRANSCRIPT:\n${convo}`;

  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MEMORY_MODEL,
      max_tokens: 1200,
      thinking: { type: "disabled" },
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  const data = await r.json();
  if (!r.ok) {
    console.error("Profile update failed:", data?.error?.message || data);
    return;
  }
  const text = (data.content || []).find((b) => b.type === "text")?.text;
  if (!text) return;
  fs.mkdirSync(MEMORY_DIR, { recursive: true });
  fs.writeFileSync(path.join(MEMORY_DIR, `${mode}.md`), text.trim() + "\n");
}

// --- Scorecard schemas ---------------------------------------------------
const DISCOVERY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    persona: { type: "string" },
    overall_score: { type: "number" },
    ladder: {
      type: "object",
      additionalProperties: false,
      properties: {
        rungs_reached: { type: "integer" },
        rungs_total: { type: "integer" },
        detail: { type: "string" },
      },
      required: ["rungs_reached", "rungs_total", "detail"],
    },
    past_behaviour_question: {
      type: "object",
      additionalProperties: false,
      properties: { asked: { type: "boolean" }, evidence: { type: "string" } },
      required: ["asked", "evidence"],
    },
    harvesting: {
      type: "object",
      additionalProperties: false,
      properties: {
        names_collected: { type: "array", items: { type: "string" } },
        intros_requested: { type: "boolean" },
        cashed_what_do_you_need: { type: "boolean" },
        detail: { type: "string" },
      },
      required: ["names_collected", "intros_requested", "cashed_what_do_you_need", "detail"],
    },
    mandate_test: {
      type: "object",
      additionalProperties: false,
      properties: { passed: { type: "boolean" }, evidence: { type: "string" } },
      required: ["passed", "evidence"],
    },
    punditry_resistance: {
      type: "object",
      additionalProperties: false,
      properties: {
        market_altitude_minutes: { type: "number" },
        fund_specific_minutes: { type: "number" },
        note: { type: "string" },
      },
      required: ["market_altitude_minutes", "fund_specific_minutes", "note"],
    },
    dodges: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { moment: { type: "string" }, buyer_caught: { type: "boolean" } },
        required: ["moment", "buyer_caught"],
      },
    },
    best_question: { type: "string" },
    missed: { type: "array", items: { type: "string" } },
    carry_forward_objections: { type: "array", items: { type: "string" } },
    summary_line: { type: "string" },
  },
  required: [
    "persona", "overall_score", "ladder", "past_behaviour_question", "harvesting",
    "mandate_test", "punditry_resistance", "dodges", "best_question", "missed",
    "carry_forward_objections", "summary_line",
  ],
};

const CONCISION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    persona: { type: "string" },
    overall_score: { type: "number" },
    headline: { type: "string" },
    answers: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          question: { type: "string" },
          verdict: { type: "string", enum: ["tight", "padded", "evasive"] },
          note: { type: "string" },
          tighter: { type: "string" },
        },
        required: ["question", "verdict", "note", "tighter"],
      },
    },
    directness: {
      type: "object",
      additionalProperties: false,
      properties: { led_with_answer_rate: { type: "string" }, note: { type: "string" } },
      required: ["led_with_answer_rate", "note"],
    },
    filler: {
      type: "object",
      additionalProperties: false,
      properties: { examples: { type: "array", items: { type: "string" } }, note: { type: "string" } },
      required: ["examples", "note"],
    },
    tightest_answer: { type: "string" },
    most_bloated: {
      type: "object",
      additionalProperties: false,
      properties: { quote: { type: "string" }, cut_to: { type: "string" } },
      required: ["quote", "cut_to"],
    },
    drill: { type: "array", items: { type: "string" } },
  },
  required: [
    "persona", "overall_score", "headline", "answers", "directness",
    "filler", "tightest_answer", "most_bloated", "drill",
  ],
};

const MODES = {
  discovery: { rubricFile: "scorecard.md", schema: DISCOVERY_SCHEMA },
  concision: { rubricFile: "concision.md", schema: CONCISION_SCHEMA },
};

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(ROOT, "public")));

app.get("/api/personas", (_req, res) => res.json(listPersonas()));

// Mint an ephemeral Realtime token, configured for the chosen persona + mode.
app.get("/api/session", async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(500).json({ error: "OPENAI_API_KEY is not set. Copy .env.example to .env." });
  }
  const persona = req.query.persona ? loadPersona(req.query.persona) : null;
  const mode = persona?.mode || "discovery";
  let instructions = (persona ? persona.instructions : GENERIC_BUYER) + VOICE_GUARD;
  if (mode === "discovery") instructions += DISCOVERY_OPEN;
  // Cross-session memory: let the persona "remember" this caller from past calls.
  const profile = loadProfile(mode);
  if (profile) {
    instructions +=
      `\n\n---\nWHAT YOU KNOW ABOUT THIS PERSON FROM PAST CALLS (you've spoken before — use it naturally: don't re-ask questions already covered, and pitch the conversation to where he is; never read this back to him or mention that you have notes):\n${profile}`;
  }
  // Interview answers are longer with natural mid-thought pauses — wait longer before responding.
  const silenceMs = mode === "concision" ? 1100 : 800;
  try {
    const r = await fetch("https://api.openai.com/v1/realtime/client_secrets", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        session: {
          type: "realtime",
          model: MODEL,
          instructions,
          audio: {
            input: {
              transcription: { model: "whisper-1" },
              turn_detection: { type: "server_vad", threshold: 0.5, prefix_padding_ms: 300, silence_duration_ms: silenceMs },
            },
            output: { voice: VOICE },
          },
        },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Realtime token mint failed:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Failed to mint token." });
    }
    const secret = data.value || data.client_secret?.value;
    res.json({ client_secret: secret, model: MODEL, persona: persona?.id || "generic", mode });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

// Score a hung-up call: transcript + the mode's rubric + history -> Claude.
app.post("/api/score", async (req, res) => {
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(500).json({ error: "ANTHROPIC_API_KEY is not set. Add it to .env." });
  }
  const { persona = "session", transcript = [] } = req.body || {};
  if (!Array.isArray(transcript) || transcript.length === 0) {
    return res.status(400).json({ error: "Empty transcript — nothing to score." });
  }

  const p = loadPersona(persona);
  const mode = p?.mode || "discovery";
  const cfg = MODES[mode] || MODES.discovery;
  const rubric = fs.readFileSync(path.join(ROOT, "rubric", cfg.rubricFile), "utf8");

  // In discovery the CALLER is the founder; in concision the CALLER is the one answering.
  const convo = transcript
    .map((t) => `${t.who === "you" ? "CALLER" : "OTHER"}: ${t.text}`)
    .join("\n");
  const userContent =
    `PERSONA: ${persona}\n\nPRIOR SESSIONS (most recent last):\n${loadHistory(mode)}\n\nTRANSCRIPT:\n${convo}`;

  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: SCORE_MODEL,
        max_tokens: 6000,
        system: rubric,
        messages: [{ role: "user", content: userContent }],
        output_config: { format: { type: "json_schema", schema: cfg.schema } },
      }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("Scorecard call failed:", data);
      return res.status(r.status).json({ error: data?.error?.message || "Scorecard call failed." });
    }
    if (data.stop_reason === "refusal") {
      return res.status(422).json({ error: "Scoring was declined by the safety system." });
    }
    const textBlock = (data.content || []).find((b) => b.type === "text");
    let scorecard;
    try {
      scorecard = JSON.parse(textBlock.text);
    } catch {
      return res.status(502).json({ error: "Could not parse the scorecard the model returned." });
    }

    const dir = path.join(ROOT, "sessions");
    fs.mkdirSync(dir, { recursive: true });
    const record = { ts: new Date().toISOString(), persona, mode, scorecard };
    fs.writeFileSync(path.join(dir, `${Date.now()}-${persona}.json`), JSON.stringify(record, null, 2));

    res.json(scorecard);

    // Update the cross-session memory in the background — don't block the response.
    updateProfile(mode, transcript, scorecard).catch((e) =>
      console.error("Profile update error:", e?.message || e)
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err?.message || err) });
  }
});

app.listen(PORT, () => {
  console.log(`\n  DiscoLadder running → http://localhost:${PORT}`);
  console.log(`  Voice: ${MODEL} / ${VOICE}   Scorecard: ${SCORE_MODEL}\n`);
});
