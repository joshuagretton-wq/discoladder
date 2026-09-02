# DiscoLadder

A voice sparring partner for practising high-stakes conversations. You talk to a
realistic, role-played buyer or interviewer over your browser — it listens, replies
with sub-second latency, and can be interrupted like a real person. When you hang up,
the call is scored against a rubric by Claude, and the tool remembers your patterns
across sessions so it gets more useful the more you use it.

Two practice modes ship today:

- **Discovery** — practise running a discovery call. A role-played fund buyer (Jamie
  the pundit, a guarded finance brain, a time-poor GP) makes you work to get concrete.
  Scored on the "ladder descent" (market → fund → roles → money), mandate test, dodge
  detection, and more.
- **Interview / concision** — a warm, patient interviewer runs a ~5-minute screening
  call off a candidate's CV, with genuine follow-ups. Scored on how **concise and direct**
  the answers are — it flags rambling, wind-ups, and filler, and rewrites the worst answer
  tighter. Ships with a sample candidate (`personas/interviewer.md`); to practise with
  your own CV, see [Personas](#personas-are-just-files).

See [PROJECT_PLAN.md](PROJECT_PLAN.md) for the design and roadmap.

---

## What you need

Two **paid, pay-as-you-go** API keys (both separate from any chat subscription):

| Key | From | Used for |
|-----|------|----------|
| `OPENAI_API_KEY` | [platform.openai.com](https://platform.openai.com) — add billing credit; **not** ChatGPT Plus | Realtime voice |
| `ANTHROPIC_API_KEY` | [console.anthropic.com](https://console.anthropic.com) — **not** Claude Pro/Max | Scorecard + memory |

Plus **Node.js 18+** and a Chromium browser (Chrome recommended) with a microphone.

Rough cost: ~£3–6 per practice hour of voice, plus a few pennies per scorecard.

---

## Setup

```bash
git clone <your-repo-url> discoladder
cd discoladder
npm install
cp .env.example .env      # then paste your two keys into .env
npm start
```

Open **http://localhost:3000** in Chrome, pick who you're calling, press **Start call**,
allow the microphone, and talk.

> Mic access needs a secure context — `localhost` counts, so `http://localhost:3000` is fine.

---

## Using it

1. **Pick a persona** from the dropdown (the interviewer is the default).
2. **Start call**, allow your mic. The buyer/interviewer opens the conversation.
3. **Just talk.** Watch the two orbs — they glow with whoever's speaking (you = blue,
   them = purple). The live transcript is tucked in the **Transcript** dropdown so it
   doesn't distract you — the point is to listen, not read.
4. **Hang up** (End call). The call is scored against the rubric for that mode and the
   scorecard appears (~30–45s while Claude thinks it through). It's also saved.
5. **Do it again.** From the second call onward the persona *remembers you* — it avoids
   repeating questions and leans on your weak spots (see Memory below).

---

## Personas are just files

Each persona is an editable Markdown file in `personas/`. Add a buyer after every real
call, tune their behaviour, or write a new interviewer — no code changes. The server
loads them on the fly.

A persona file:

- Starts with a `# Name` heading (shown in the picker).
- May declare its scoring mode with a comment: `<!-- mode: concision -->`.
  Omit it and the persona defaults to **discovery** mode.
- Contains the behavioural instructions the voice model follows.

Mode → rubric mapping lives in `server/server.js` (`MODES`): `discovery` →
`rubric/scorecard.md`, `concision` → `rubric/concision.md`. The rubric files are
plain Markdown you can edit.

**Practising the interview with your own CV:** the shipped `personas/interviewer.md` uses
a fictional candidate (Murphy Cooper). To use your own, copy it to
`personas/interviewer-me.md`, replace the CV and name with yours, and select it in the
picker. Files matching `personas/*-me.md` are gitignored, so your CV stays local and
never gets committed.

---

## Cross-session memory

After each scored call, a background step (Claude Sonnet — fast and cheap, runs *after*
your scorecard so it never slows it down) updates a running profile at
`memory/<mode>.md`: your score trend, which topics have been covered, your recurring
weaknesses, and your verbal tics. On your next call, that profile is injected into the
persona's prompt, so it opens knowing you.

Your first call in a mode is a fresh start; the memory kicks in from the second call on.
`memory/` and `sessions/` are gitignored — they're personal and never committed.

---

## Configuration (`.env`)

| Variable | Default | Notes |
|----------|---------|-------|
| `OPENAI_API_KEY` | — | required |
| `ANTHROPIC_API_KEY` | — | required |
| `OPENAI_REALTIME_MODEL` | `gpt-realtime` | if it 404s, try `gpt-4o-realtime-preview` |
| `OPENAI_REALTIME_VOICE` | `cedar` | also `marin`, `ash`, `alloy`, … |
| `ANTHROPIC_MODEL` | `claude-opus-5` | the scorecard model |
| `MEMORY_MODEL` | `claude-sonnet-5` | the background memory-update model |
| `PORT` | `3000` | |

The personas are instructed to speak in a British English accent; change that in
`server/server.js` (`VOICE_GUARD`).

---

## Layout

```
server/server.js        mints the ephemeral voice token, runs scoring + memory
public/index.html       the app
public/app.js           UI, orbs, transcript, scorecard render
public/voice/provider.js  swappable voice interface (OpenAI Realtime today)
personas/*.md           editable buyers / interviewers (one per file)
rubric/*.md             the scoring rubrics, per mode
sessions/               saved scorecards (gitignored)
memory/                 per-mode profile of you (gitignored)
```

---

## Troubleshooting

- **"OPENAI_API_KEY is not set"** — you haven't created `.env` or it's empty.
- **Session mint 404s** — set `OPENAI_REALTIME_MODEL=gpt-4o-realtime-preview` in `.env`.
- **You hear nothing** — check the tab isn't muted and your system output device is right;
  make sure you allowed the mic; use `http://localhost:3000` (not a file path or LAN IP).
- **Scoring says a key is missing** — add `ANTHROPIC_API_KEY` to `.env` and restart.

---

## Notes

Voice runs on the OpenAI Realtime API (speech-to-speech, WebRTC) behind a thin swappable
interface in `public/voice/provider.js`, so a different voice engine (e.g. ElevenLabs)
can drop in later without touching the personas or scoring. Scoring and memory run on the
Anthropic Messages API. Nothing but your own machine is involved — the server runs locally
and holds your keys; the browser only ever gets a short-lived voice token.
