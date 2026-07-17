// Renders the console product screenshots used by the pitch deck (slides 5-7 +
// the Questionnaires slide). Each shot is a deterministic, self-contained mock-up
// of one *content surface* from the current Knowledge Console — deliberately
// stripped of the sidebar / topbar chrome so the meaningful content (the cited
// answer, the gap cluster, the proposal, the questionnaire items) fills the deck's
// browser frame and stays legible. The frame's URL bar supplies the app context.
//
// Styling derives from apps/web/src/theme/theme.ts (the design-token source of
// truth — the app itself moved to Emotion CSS-in-JS in PR #147). The *content* is
// real: questions, answers, citations, gap clusters, proposal titles and
// questionnaire runs were taken from the live knowledge base.
//
// Captured at 2x device scale so text is crisp when the frame downscales it.
import { mkdir, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const OUT = join(ROOT, "presentation/assets/opt");
const TMP = join(ROOT, "tmp/static-ui-shots");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";

// ---- theme tokens (mirrors apps/web/src/theme/theme.ts) -------------------
const T = {
  text: "#17211d", muted: "#5b6962", subtle: "#8a948f",
  page: "#f5f7f2", surface: "#ffffff", surfaceMuted: "#f6f8f3",
  border: "#e4e8e0", borderStrong: "#cbd3cb",
  accent: "#285f74", accentBg: "#e5f1f4", accentBorder: "#b7d0d8", brandAccent: "#62702f",
  primary: "#20322b", primaryText: "#ffffff",
  ok: { fg: "#3d6b43", bg: "#eef6ec", bd: "#bcd6bd" },
  amber: { fg: "#7a5d24", bg: "#faf5e9", bd: "#d8c496" },
  blue: { fg: "#2d5775", bg: "#f2f7fb", bd: "#c4d3e0" },
  neutral: { fg: "#5b6962", bg: "#f6f8f3", bd: "#e0e5db" }
};

const badge = (tone, label) => {
  const c = T[tone] ?? T.ok;
  return `<span class="badge" style="color:${c.fg};background:${c.bg};border-color:${c.bd}">${label}</span>`;
};

// Content-only page: a padded console-page background holding one surface stack.
// Larger type than the live app (this is a presentation crop, not the full UI).
function page(eyebrow, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0;}
  body{font-family:Inter,ui-sans-serif,system-ui,"Segoe UI",sans-serif;background:${T.page};color:${T.text};
    -webkit-font-smoothing:antialiased;padding:26px 30px;}
  .eyebrow{font-size:13px;text-transform:uppercase;letter-spacing:.07em;color:${T.brandAccent};font-weight:700;margin-bottom:14px;}
  .surface{background:${T.surface};border:1px solid ${T.border};border-radius:14px;box-shadow:0 1px 2px rgba(23,33,29,.05);
    padding:22px 26px;margin-bottom:16px;}
  .sh{display:flex;align-items:center;gap:11px;margin-bottom:16px;}
  .sh h2{font-size:19px;font-weight:600;letter-spacing:-.01em;}
  .pill{font-size:13px;color:${T.muted};background:${T.surfaceMuted};border:1px solid ${T.border};border-radius:99px;padding:3px 11px;}
  .badge{display:inline-block;font-size:13px;font-weight:600;border:1px solid;border-radius:99px;padding:3px 11px;letter-spacing:.01em;}
  .fpill{font-size:13px;color:${T.accent};background:${T.accentBg};border:1px solid ${T.accentBorder};border-radius:99px;padding:3px 12px;font-weight:600;}
  .btnP{display:inline-block;background:${T.primary};color:${T.primaryText};border-radius:9px;padding:11px 20px;font-size:15px;font-weight:600;}
  .btnS{display:inline-block;background:${T.surface};color:${T.text};border:1px solid ${T.borderStrong};border-radius:9px;padding:9px 15px;font-size:14px;font-weight:500;}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:14px;color:${T.accent};}
  .path{font-family:ui-monospace,Menlo,monospace;font-size:13px;color:${T.subtle};}
  .answer{font-size:17px;line-height:1.62;color:${T.text};}
  .row{display:flex;align-items:center;gap:10px;}
  .between{display:flex;align-items:center;justify-content:space-between;gap:14px;}
</style></head><body>
  <div class="eyebrow">${eyebrow}</div>
  ${body}
</body></html>`;
}

// ---- fixtures (real content) ----------------------------------------------
const cite = (heading, path, rel) =>
  `<div class="between" style="border:1px solid ${T.border};border-radius:10px;padding:12px 15px">
     <div><div style="font-size:15px;font-weight:600">${heading}</div><div class="path" style="margin-top:3px">${path}</div></div>
     <span class="mono" style="color:${T.muted}">${rel}</span></div>`;

const askBody = `
<section class="surface">
  <div class="between" style="align-items:flex-start;margin-bottom:14px">
    <h2 style="font-size:20px;max-width:74%;line-height:1.3">What guarantees does Markdown Magpie make about its answers — how does it avoid making things up?</h2>
    <div class="row"><span class="fpill">Magpie Sales</span>${badge("ok", "HIGH")}</div></div>
  <p class="answer">Markdown Magpie prevents made-up answers by <b>grounding every response in its indexed Markdown</b>.
    Every answer carries <b>citations</b> back to the exact file, heading and commit, plus a scored
    <b>confidence level</b> from retrieval relevance. When confidence is low it flags a <b>knowledge gap</b>
    instead of guessing.</p>
  <div style="margin:20px 0 10px;font-size:14px;color:${T.muted};font-weight:600">3 citations</div>
  <div style="display:grid;gap:10px">
    ${cite("1. Won't Lie (Grounded Answers)", "handling-…-internal-knowledge-base-obje.md", "70%")}
    ${cite("7. “How can we trust that Magpie’s answers are accurate?”", "handling-customer-objections-in-the-magpie-sales-process.md", "68%")}
    ${cite("Summary", "competitive-landscape-differentiation.md", "67%")}
  </div>
  <div style="margin-top:18px;border-top:1px solid ${T.border};padding-top:14px;font-size:14.5px;color:${T.muted}">
    <div style="font-weight:600;color:${T.text};margin-bottom:7px">How this was answered</div>
    <div>· Routing: flow pinned by the caller</div>
    <div>· Retrieval: 5 seed sections, 3 in the final pool</div>
    <div>· Grounding verification: ran — every claim supported by the retrieved context</div>
  </div>
</section>`;

const clusterGap = (g) =>
  `<li style="display:flex;justify-content:space-between;gap:14px;padding:11px 0;border-top:1px solid ${T.border};font-size:15px">
     <span>${g}</span><span class="btnS" style="padding:5px 11px;font-size:13px;white-space:nowrap">Move to…</span></li>`;

const gapsBody = `
<section class="surface">
  <div class="sh"><h2>Suggested clusters</h2><span class="pill">6</span></div>
  <article style="border:1px solid ${T.border};border-radius:12px;padding:18px 20px">
    <div class="between" style="margin-bottom:8px">
      <strong style="font-size:17px">Date grouping &amp; period aggregation in FlowerBI</strong>
      <div class="row"><span class="fpill">FlowerBI KB</span><span class="pill">4 gaps</span></div></div>
    <p style="font-size:15px;color:${T.muted}">These questions all ask how to bucket or aggregate data by time period in FlowerBI.</p>
    <ul style="list-style:none;margin-top:6px">
      ${clusterGap("How to group records by week using FlowerBI's query syntax or date truncation")}
      ${clusterGap("How to group records by month using FlowerBI's query syntax or date truncation")}
      ${clusterGap("Whether FlowerBI supports built-in date period aggregation (day, week, month)")}
      ${clusterGap("How to group or bucket dates (e.g. by year, month, day) in FlowerBI queries")}
    </ul>
    <div style="margin-top:16px"><span class="btnP">Draft proposal</span></div>
  </article>
</section>`;

const proposalsBody = `
<section class="surface">
  <div class="between" style="align-items:flex-start;margin-bottom:12px">
    <div><h2 style="font-size:20px">Competitive Win/Loss Intelligence</h2>
      <div class="path" style="margin-top:4px">magpie-sales/competitive-win-loss-intelligence.md</div></div>
    ${badge("blue", "pr-opened")}</div>
  <p style="font-size:16px;line-height:1.6;color:${T.muted};margin-bottom:16px">Addresses the gap
    <i>“Win/loss data against specific competitors”</i> and the triggering question
    <i>“Which competitor do we lose to most often, and why?”</i> — describing what the sources
    <i>do</i> contain before drawing conclusions.</p>
  <div class="row" style="margin-bottom:16px;flex-wrap:wrap">
    <span class="btnS">Mark Ready</span><span class="btnS">Publish branch</span>
    <span class="btnS">Accept / Merge</span><span class="fpill">PR #128 open</span></div>
  <pre style="background:${T.surfaceMuted};border:1px solid ${T.border};border-radius:10px;padding:18px 20px;
    font-family:ui-monospace,Menlo,monospace;font-size:14px;line-height:1.65;color:${T.text};white-space:pre-wrap"># Competitive Win/Loss Intelligence

## What the sources cover
The positioning framework ("won't lie, won't leak, won't rot") and the
competitive landscape summary give a defensible, cited comparison — without
inventing win/loss numbers the knowledge base does not hold.</pre>
</section>`;

const qRow = (name, reused, total, sel) =>
  `<div class="between" style="padding:13px 14px;border-radius:10px;${sel ? `background:${T.surfaceMuted};border:1px solid ${T.border}` : `border-bottom:1px solid ${T.border}`}">
     <div class="row"><strong style="font-size:16px">${name}</strong>${badge("neutral", "magpie-sales")}
       <span style="font-size:14.5px;color:${T.muted}">${reused} reused / ${total} total</span></div>
     ${badge("ok", "complete")}</div>`;

const qItem = (tone, label, n, q, answer, cite, note) =>
  `<article style="border:1px solid ${T.border};border-radius:12px;padding:17px 20px;display:grid;gap:9px">
     <div class="row" style="align-items:flex-start">${badge(tone, label)}<strong style="font-size:16px;line-height:1.35">${n}. ${q}</strong></div>
     <p class="answer" style="font-size:15px">${answer}</p>
     ${note ? `<div style="font-size:13.5px;color:${T.muted}">${note}</div>` : ""}
     <div style="font-size:13px;color:${T.subtle}">↳ ${cite}</div>
   </article>`;

const questionnairesBody = `
<section class="surface">
  <div class="sh"><h2>Questionnaire runs</h2></div>
  <div style="display:grid;gap:6px;margin-bottom:20px">
    ${qRow("Sales QA #3", 3, 14, true)}
    ${qRow("Sales QA #2", 0, 14)}
    ${qRow("Sales QA #1", 0, 14)}
  </div>
  <div class="between" style="margin-bottom:14px">
    <h2 style="font-size:18px;font-weight:600">Sales QA #3</h2>
    <div class="row"><span class="btnS">Approve all reused</span>
      <span class="mono">Export .md</span><span class="mono">Export .csv</span></div></div>
  <div style="display:grid;gap:12px">
    ${qItem("amber", "changed", 1,
      "When a prospect claims Magpie is “too pricey for what we'd get out of it”, how should we respond?",
      "Validate the budget concern, then reframe: Magpie replaces manual synchronization and error resolution — if each developer saves a few hours a month, the payback quickly outweighs the subscription cost.",
      "markdown-magpie-sales-playbook.md — Handling Price Objections",
      "Re-answered: new relevant content appeared — “Handling Price Objections” on 2026-07-15.")}
    ${qItem("ok", "reused", 2,
      "What is the single biggest differentiator versus a generic AI chatbot?",
      "Grounded, cited answers: every response links back to source Markdown (file, heading, commit), so buyers can trust and audit it — a generic chatbot cannot.",
      "competitive-landscape-differentiation.md — Summary", "")}
  </div>
</section>`;

// name -> [eyebrow, body, cssWidth, cssHeight]. Height ~matches the deck frame's
// crop band at that width so there is little wasted space.
const pages = {
  ask: ["Ask · cited answer", askBody, 900, 640],
  gaps: ["Gaps · weak answers → proposals", gapsBody, 900, 560],
  proposals: ["Proposals · human review", proposalsBody, 900, 560],
  questionnaires: ["Questionnaires · batch answers", questionnairesBody, 900, 900]
};

await mkdir(TMP, { recursive: true });
await mkdir(OUT, { recursive: true });

for (const [name, [eyebrow, body, w, h]] of Object.entries(pages)) {
  const file = join(TMP, `${name}.html`);
  const shot = join(OUT, `${name}.png`);
  await writeFile(file, page(eyebrow, body));
  const result = spawnSync(
    CHROME,
    [
      "--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run",
      "--no-default-browser-check", "--force-color-profile=srgb", "--force-device-scale-factor=2",
      `--window-size=${w},${h}`, `--screenshot=${shot}`,
      `file:///${resolve(file).replaceAll("\\", "/")}`
    ],
    { encoding: "utf8" }
  );
  if (result.status !== 0) throw new Error(result.stderr || `Chrome failed for ${name}`);
  console.log(`saved ${shot} (${w}x${h} @2x)`);
}
