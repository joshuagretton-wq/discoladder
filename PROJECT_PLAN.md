# DiscoLadder — Project Plan

**One line:** A voice sparring partner for discovery calls. You talk to a realistic practice buyer, it talks back (and interrupts), and when you hang up you get a scorecard against your own rubric — with the tool remembering your patterns across sessions and engineering situations that force your weak move.

The core belief driving the design: **the best discovery is a natural, curious conversation between two people — not a MEDDIC checklist.** So this tool trains the conversation, then scores it after the fact. It never turns the live call into a framework.

---

## The four components, one loop

| # | Component | What it is | Tech |
|---|-----------|-----------|------|
| 1 | **Persona engine** | Each practice buyer is a system prompt built from real material (transcripts distilled into behaviour). 4 at launch. | Editable `.md` files |
| 2 | **Voice loop** | Browser ↔ realtime speech-to-speech. Sub-second, barge-in both ways. Persona rides in the session config. | **OpenAI Realtime API** (recommended — see below) |
| 3 | **Scorecard engine** | On hang-up, the transcript + rubric go to a second model call; returns a structured scorecard in seconds. | **Claude** (nuanced judgement) |
| 4 | **Session log** | Scorecards accumulate → trend chart + pattern memory ("3rd consecutive miss — drill this"). | Local JSON in `sessions/` |

The loop: **talk → transcribe → hang up → score → log → next persona adapts to your weak move.**

---

## Voice provider — recommendation

**Recommend: OpenAI Realtime API for v1**, with the voice layer isolated behind one thin module so ElevenLabs voices can drop in later.

| | OpenAI Realtime | ElevenLabs Agents | Vapi |
|---|---|---|---|
| Model type | **True speech-to-speech** (one model) | Cascaded STT→LLM→TTS | Orchestration layer |
| Barge-in / overlap | **Best — native, emotion preserved** | Good | Good |
| Voice distinctiveness | Good, limited set | **Best — character-grade voices** | Uses others' TTS |
| Build simplicity | **One API, one key, browser WebRTC** | Agent config + BYO-LLM | More infra (telephony-first) |
| Bring-your-own-LLM | No (voice+brain fused) | Yes | Yes |
| Transcripts | Yes (events) | Yes | Yes |

**Why Realtime wins for v1:** the thing that makes objection practice feel real is *natural interruption and overlapping speech with emotional tone* — a fused speech-to-speech model does that best, and it's also the straightest build (single API, browser WebRTC, one ephemeral-token step). Voice distinctiveness matters but is secondary to interaction realism.

**When we'd switch:** if the four personas start to blur vocally, v2 swaps the voice module to ElevenLabs for character-grade voices (keeping the persona prompt + scorecard exactly as-is). Architecting for the swap now costs nothing.

**Cost (rough — to confirm against current pricing):** on the order of **£3–6 per practice hour** for Realtime audio, plus pennies for each Claude scorecard call. Well inside "a pound or two per hour" for meaningful practice.

---

## File structure

```
DiscoLadder/
  index.html            # single-page app: mic button, live call UI, scorecard view
  app.js                # voice loop, WebRTC wiring, session state
  voice/
    provider.js         # thin swappable interface (openai | elevenlabs)
  personas/
    jamie.md            # the pundit — fast, generous on market, slippery on specifics
    matt-murphy.md      # guarded finance brain — short answers, won't fill silences
    deal-partner.md     # sceptical — challenges your credibility
    time-poor-gp.md     # interrupts, gives you 8 minutes
  rubric/
    scorecard.md        # the rubric prompt (verbatim from today's coaching)
  server/
    server.js           # tiny: mints ephemeral Realtime token + runs Claude scorecard
  sessions/             # accumulated scorecards (JSON) — the memory
  README.md             # API-key setup, run instructions
  .env.example
```

Why the tiny server: the browser must not hold the real API key. `server/server.js` mints a short-lived ephemeral token for the WebRTC handshake and runs the scorecard call server-side. Everything else is the single page.

---

## The rubric (the scorecard, verbatim from today)

- **Ladder descent** (core metric): how far down — market → their fund → named companies → specific roles → time & money. Score per rung, with the quotes that got you there.
- **Past-behaviour question**: did you ask how their last relevant hire *actually* happened?
- **Harvesting**: names collected, intros requested, "what do you need from me?" moments cashed.
- **Mandate test**: did you convert sentiment into a concrete test of demand?
- **Punditry resistance**: minutes at market-commentary altitude vs fund-specific.
- **Dodge detection**: moments the buyer caught you + unanswered objections carried forward.

Scorecard shape (example): *"Jamie, second call" — 7.5/10 • Rungs 4/5 • Best question … • Mandate test PASSED • Missed: past-behaviour (3rd consecutive miss — drill this) • Dodge caught • Carry-forward: year-three tenure.*

---

## Build phases

- **Phase 0 — Walking skeleton — ✅ DONE.** Browser connects to Realtime (GA API), you talk to a generic buyer, hear a reply, barge-in works both ways, both sides transcribed. Loop proven end-to-end.
- **Phase 1 — Personas + scorecard — ✅ DONE.** Four persona files (Jamie, Matt Murphy, sceptical deal partner, time-poor GP) wired to the session config via a picker; hang-up sends transcript + rubric + prior-session history to Claude (Opus 5, guaranteed-JSON via `output_config.format`); scorecard renders on screen and saves to `sessions/`. Verified end-to-end against a synthetic Jamie transcript.
- **Phase 2 — Memory + adaptation (a day).** Scorecards accumulate → trend chart; "Nth consecutive miss" detection feeds a *focus instruction* into the next persona prompt (e.g. Jamie mentions Raj's hiring in passing to see if you finally grab it). This is the point of the whole product.

---

## Status — working MVP (paused here)

Voice loop, persona (Jamie default, British `cedar` voice), speaking-orb visualizer, transcript-in-dropdown, and the Claude scorecard all working end to end. The format is deliberately simple and low-distraction. Good enough to practise against daily.

## Backlog — future fixes & evolvements

- **Deep Jamie (NEXT UP — the priority).** Build Jamie out with real context and knowledge so a call surfaces *genuine, multi-layered pain that has to be uncovered* — not one obvious need. Give him layered, interlocking problems that only reveal under good questioning: e.g. the bench gap since Anthony and Raj left, portfolio companies leaning on him for talent he can't supply, an unspoken retention/succession worry, LP expectations he's quietly behind on, a hire that went wrong last year he won't volunteer. Each rung down should expose another layer, and he should have grounded, consistent facts a sharp caller can pin him to — so the ladder has real depth and the scorecard has real material. **Nail Jamie before advancing Matt or the GP.**
- **Listening-first — ✅ mostly addressed.** Live transcript replaced by the speaking-orb visualizer; transcript moved to a collapsed dropdown. Remaining option if wanted: hide the transcript entirely until hang-up.
- **Barge-in truncation.** When you interrupt the buyer, the saved transcript may still contain words the voice never actually said. Finalize the transcript at what was *actually spoken* so the scorecard scores said-words, not generated-but-cut text.
- **Voice quality / per-persona voices.** `cedar` + British-accent instruction is the current default; later, give each persona its own voice (and consider A/B-ing ElevenLabs character voices) so they sound distinct.

---

## Decisions

1. **Voice provider** — ✅ **OpenAI Realtime** for v1, behind a swappable `voice/provider.js` so ElevenLabs can drop in for v2.
2. **Scorecard model** — ✅ **Claude** for the scoring call.
3. **Personas at launch** — Jamie + Matt-Murphy-type + sceptical deal partner + time-poor GP. *(Open: any to add/drop.)*
4. **Storage** — local JSON files in `sessions/` for v1, zero infra. *(Open: hosted store can come later.)*
