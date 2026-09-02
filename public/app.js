import { OpenAIRealtimeProvider } from "./voice/provider.js";

const personaSel = document.getElementById("persona");
const startBtn = document.getElementById("start");
const endBtn = document.getElementById("end");
const statusEl = document.getElementById("status");
const dotEl = document.getElementById("dot");
const stageEl = document.getElementById("stage");
const orbYou = document.getElementById("orbYou");
const orbBuyer = document.getElementById("orbBuyer");
const orbBuyerName = document.getElementById("orbBuyerName");
const txlist = document.getElementById("txlist");
const cardEl = document.getElementById("card");

let provider = null;
let transcript = []; // [{who, text}] of completed turns, for scoring
let personaModes = {}; // id -> mode, for labelling the other party

function setStatus(state, detail) {
  statusEl.textContent = detail ? `${state} — ${detail}` : state;
  dotEl.className = "dot " + state;
}

// Real-time audio levels → orb glow/scale.
function onLevels(you, buyer) {
  orbYou.style.setProperty("--l", you.toFixed(3));
  orbBuyer.style.setProperty("--l", buyer.toFixed(3));
}

// Completed turns only — collected for scoring and listed in the dropdown.
function onTranscript(who, text, final) {
  if (!final || !text.trim()) return;
  const clean = text.trim();
  transcript.push({ who, text: clean });
  const el = document.createElement("div");
  el.className = "turn " + who;
  el.innerHTML = `<div class="who">${who === "you" ? "You" : "Buyer"}</div><div class="text"></div>`;
  el.querySelector(".text").textContent = clean;
  txlist.appendChild(el);
  txlist.scrollTop = txlist.scrollHeight;
}

function otherLabel() {
  return personaModes[personaSel.value] === "concision" ? "Interviewer" : "Buyer";
}

async function loadPersonas() {
  try {
    const list = await (await fetch("/api/personas")).json();
    if (Array.isArray(list) && list.length) {
      personaModes = Object.fromEntries(list.map((p) => [p.id, p.mode]));
      personaSel.innerHTML = list.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    } else {
      personaSel.innerHTML = `<option value="">Generic buyer</option>`;
    }
  } catch {
    personaSel.innerHTML = `<option value="">Generic buyer</option>`;
  }
  orbBuyerName.textContent = otherLabel();
}

async function start() {
  startBtn.disabled = true;
  personaSel.disabled = true;
  cardEl.classList.remove("show");
  transcript = [];
  txlist.innerHTML = "";
  provider = new OpenAIRealtimeProvider({
    onStatus: setStatus,
    onTranscript,
    onLevels,
    persona: personaSel.value,
  });
  try {
    await provider.connect();
    stageEl.classList.remove("idle");
    endBtn.disabled = false;
  } catch (err) {
    setStatus("error", err.message);
    startBtn.disabled = false;
    personaSel.disabled = false;
    provider = null;
  }
}

async function end() {
  provider?.disconnect();
  provider = null;
  stageEl.classList.add("idle");
  onLevels(0, 0);
  endBtn.disabled = true;

  if (transcript.length) await score();

  startBtn.disabled = false;
  personaSel.disabled = false;
}

async function score() {
  cardEl.className = "card show";
  cardEl.innerHTML = `<div class="scoring">Scoring your call against the rubric… (Claude takes ~30–45s to think it through)</div>`;
  try {
    const res = await fetch("/api/score", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ persona: personaSel.value || "generic", transcript }),
    });
    const data = await res.json();
    if (!res.ok) {
      cardEl.innerHTML = `<div class="scoring">Couldn't score: ${data.error || res.status}</div>`;
      return;
    }
    renderCard(data);
  } catch (err) {
    cardEl.innerHTML = `<div class="scoring">Couldn't score: ${err.message}</div>`;
  }
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

// Pick the scorecard view by shape: concision cards have `answers`, discovery has `ladder`.
function renderCard(s) {
  if (s && Array.isArray(s.answers)) return renderConcision(s);
  return renderDiscovery(s);
}

function renderConcision(s) {
  const chip = (v) => `<span class="${v}">${String(v || "").toUpperCase()}</span>`;
  const answers = (s.answers || [])
    .map(
      (a) => `<div class="qa">
        <div class="q">${chip(a.verdict)} <b>Q:</b> ${esc(a.question)}</div>
        <div class="note">${esc(a.note)}</div>
        ${a.tighter ? `<div class="tighter"><b>Tighter:</b> ${esc(a.tighter)}</div>` : ""}
      </div>`
    )
    .join("");
  const filler = (s.filler?.examples || []).map(esc).join(", ") || "—";
  const drill = (s.drill || []).map((d) => `<li>${esc(d)}</li>`).join("");

  cardEl.innerHTML = `
    <h2><span class="score">${esc(s.overall_score)}/10</span> concision drill</h2>
    <div class="sumline">${esc(s.headline)}</div>
    <div class="grid">
      <div class="metric">
        <div class="label">Directness</div>
        <div class="val">Led with the answer: <b>${esc(s.directness?.led_with_answer_rate)}</b>. ${esc(s.directness?.note)}</div>
      </div>
      <div class="metric">
        <div class="label">Filler & hedging</div>
        <div class="val">${filler}<br>${esc(s.filler?.note)}</div>
      </div>
      <div class="metric">
        <div class="label">Tightest answer</div>
        <div class="val">${esc(s.tightest_answer)}</div>
      </div>
      <div class="metric">
        <div class="label">Most bloated → cut to</div>
        <div class="val"><span class="padded">${esc(s.most_bloated?.quote)}</span><br><b>→</b> ${esc(s.most_bloated?.cut_to)}</div>
      </div>
    </div>
    <div class="metric">
      <div class="label">Answer by answer</div>
      <div class="qalist">${answers || "<div class='note'>No answers captured.</div>"}</div>
    </div>
    <div class="metric">
      <div class="label">Drill this next</div>
      <div class="val"><ul>${drill || "<li>—</li>"}</ul></div>
    </div>`;
}

function renderDiscovery(s) {
  const passFail = (b) => (b ? `<span class="pass">PASSED</span>` : `<span class="fail">FAILED</span>`);
  const yesNo = (b) => (b ? "yes" : `<span class="miss">no</span>`);
  const missed = (s.missed || []).map((m) => `<li class="miss">${esc(m)}</li>`).join("");
  const carry = (s.carry_forward_objections || []).map((m) => `<li>${esc(m)}</li>`).join("");
  const dodges = (s.dodges || []).map((d) => `<li>${d.buyer_caught ? "⚠️ " : ""}${esc(d.moment)}</li>`).join("");
  const names = (s.harvesting?.names_collected || []).map(esc).join(", ") || "—";

  cardEl.innerHTML = `
    <h2><span class="score">${esc(s.overall_score)}/10</span> ${esc(s.persona)}</h2>
    <div class="sumline">${esc(s.summary_line)}</div>
    <div class="grid">
      <div class="metric">
        <div class="label">Ladder descent</div>
        <div class="val"><b>${esc(s.ladder?.rungs_reached)}/${esc(s.ladder?.rungs_total)} rungs.</b> ${esc(s.ladder?.detail)}</div>
      </div>
      <div class="metric">
        <div class="label">Mandate test</div>
        <div class="val">${passFail(s.mandate_test?.passed)} — ${esc(s.mandate_test?.evidence)}</div>
      </div>
      <div class="metric">
        <div class="label">Past-behaviour question</div>
        <div class="val">Asked: ${yesNo(s.past_behaviour_question?.asked)}. ${esc(s.past_behaviour_question?.evidence)}</div>
      </div>
      <div class="metric">
        <div class="label">Harvesting</div>
        <div class="val">Names: ${names}. Intros requested: ${yesNo(s.harvesting?.intros_requested)}. Cashed "what do you need?": ${yesNo(s.harvesting?.cashed_what_do_you_need)}. ${esc(s.harvesting?.detail)}</div>
      </div>
      <div class="metric">
        <div class="label">Punditry resistance</div>
        <div class="val">~${esc(s.punditry_resistance?.market_altitude_minutes)} min market vs ~${esc(s.punditry_resistance?.fund_specific_minutes)} min fund-specific. ${esc(s.punditry_resistance?.note)}</div>
      </div>
      <div class="metric">
        <div class="label">Best question</div>
        <div class="val">${esc(s.best_question)}</div>
      </div>
      <div class="metric">
        <div class="label">Missed / drill this</div>
        <div class="val"><ul>${missed || "<li>—</li>"}</ul></div>
      </div>
      <div class="metric">
        <div class="label">Dodges & carry-forward</div>
        <div class="val"><ul>${dodges || "<li>none caught</li>"}</ul><ul>${carry || "<li>no open objections</li>"}</ul></div>
      </div>
    </div>`;
}

startBtn.addEventListener("click", start);
endBtn.addEventListener("click", end);
personaSel.addEventListener("change", () => { orbBuyerName.textContent = otherLabel(); });
loadPersonas();
