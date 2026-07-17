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

// Stat tile for the questionnaire run-detail header (latest UI).
const stat = (n, label) =>
  `<div style="border:1px solid ${T.border};border-radius:10px;padding:11px 14px;background:${T.surface}">
     <div style="font-size:24px;font-weight:700;letter-spacing:-.02em;line-height:1.1">${n}</div>
     <div style="font-size:12px;color:${T.muted};margin-top:3px">${label}</div></div>`;

// One answered questionnaire item — badge + question + answer + citation, with an
// optional change note and Approve action, matching the run-detail layout.
const qItem = (tone, label, n, q, answer, cite, note, approve) =>
  `<article style="border:1px solid ${T.border};border-radius:12px;padding:16px 20px;display:grid;gap:9px">
     <div class="row" style="align-items:flex-start">${badge(tone, label)}<strong style="font-size:15.5px;line-height:1.35">${n}. ${q}</strong></div>
     <p class="answer" style="font-size:14.5px">${answer}</p>
     ${note ? `<div style="font-size:13px;color:${T.muted}">${note}</div>` : ""}
     <div style="font-size:12.5px;color:${T.subtle}">↳ ${cite}</div>
     ${approve ? `<div style="margin-top:2px"><span class="btnS">Approve</span></div>` : ""}
   </article>`;

// Latest UI: the run-detail page — breadcrumb, title + flow + export actions, a
// stat-tile row, then the answered items. Example: a vendor security review, whose
// first answer reuses the SSO page the demo (slides 8-11) just created.
const questionnairesBody = `
<div style="font-size:13.5px;color:${T.accent};margin-bottom:10px">&larr; Questionnaires</div>
<section class="surface">
  <div class="between" style="margin-bottom:18px">
    <div class="row"><h2 style="font-size:20px">Acme Corp — Vendor Security Review</h2>${badge("neutral", "magpie-sales")}</div>
    <div class="row"><span class="btnS">Approve all reused</span><span class="mono">Export .md</span><span class="mono">Export .csv</span></div></div>
  <div style="display:grid;grid-template-columns:repeat(6,1fr);gap:10px;margin-bottom:22px">
    ${stat("12", "Total")}${stat("4", "Approved")}${stat("7", "Awaiting approval")}${stat("0", "In progress")}${stat("1", "Unanswerable")}${stat("6", "Reused")}
  </div>
  <div style="display:grid;gap:12px">
    ${qItem("ok", "reused", 1,
      "Do you support single sign-on (SSO / SAML)?",
      "Yes. Magpie signs in through Auth0, so it works with any OIDC provider — Google, Microsoft Entra, Okta and more — and SAML single sign-on with SCIM provisioning is supported. Console access can be locked to your identity provider.",
      "magpie-sales/authentication-and-sso.md — SSO &amp; provisioning", "", false)}
    ${qItem("amber", "changed", 2,
      "Where is customer data stored, and is it encrypted in transit and at rest?",
      "All knowledge lives in your own Git repositories and Postgres — self-hosted, so nothing leaves your infrastructure. Traffic is TLS-encrypted in transit; encryption at rest is inherited from your database and disk.",
      "security/data-handling.md — Storage &amp; encryption",
      "Re-answered: cited section “Storage &amp; encryption” changed on 2026-07-14.", false)}
    ${qItem("neutral", "answered", 3,
      "What is your data retention and deletion policy?",
      "The knowledge base is plain Markdown in Git, so retention and deletion follow your repository policy — remove a document and it leaves the index on the next re-index, with full history preserved in Git.",
      "security/data-handling.md — Retention &amp; deletion", "", true)}
  </div>
</section>`;

// ---- demo: one coherent thread ------------------------------------------
// The whole demo (deck slides 8-11) follows a single scenario: the single sign-on
// (SSO) question that comes back as a LOW gap in slide 8's transcript is
// clustered, drafted, PR'd, merged & re-indexed, then re-asked and answered.

const demoClusterBody = `
<section class="surface">
  <div class="sh"><h2>Suggested clusters</h2><span class="pill">1 new</span></div>
  <article style="border:1px solid ${T.border};border-radius:12px;padding:18px 20px">
    <div class="between" style="margin-bottom:8px">
      <strong style="font-size:17px">Authentication &amp; SSO</strong>
      <div class="row"><span class="fpill">Magpie Sales</span><span class="pill">3 gaps</span></div></div>
    <p style="font-size:15px;color:${T.muted}">People keep asking how sign-in works and whether single sign-on is supported — the knowledge base doesn't say yet.</p>
    <ul style="list-style:none;margin-top:6px">
      ${clusterGap("Does Markdown Magpie support single sign-on (SSO / SAML)?")}
      ${clusterGap("Which identity providers can we use?")}
      ${clusterGap("Can we lock console access to our own IdP?")}
    </ul>
    <div style="margin-top:16px"><span class="btnP">Draft proposal</span></div>
  </article>
</section>`;

const demoDraftBody = `
<section class="surface">
  <div class="between" style="align-items:flex-start;margin-bottom:12px">
    <div><h2 style="font-size:20px">Authentication &amp; Single Sign-On</h2>
      <div class="path" style="margin-top:4px">magpie-sales/authentication-and-sso.md</div></div>
    ${badge("ok", "ready")}</div>
  <p style="font-size:16px;line-height:1.6;color:${T.muted};margin-bottom:16px">Drafted from the
    <b>Authentication &amp; SSO</b> gap — explains how sign-in works and which providers are supported,
    grounded in the deployment docs.</p>
  <pre style="background:${T.surfaceMuted};border:1px solid ${T.border};border-radius:10px;padding:18px 20px;
    font-family:ui-monospace,Menlo,monospace;font-size:14px;line-height:1.65;color:${T.text};white-space:pre-wrap"># Authentication &amp; Single Sign-On

## Sign-in
Magpie authenticates through Auth0, so it works with any OIDC identity
provider — Google, Microsoft Entra, Okta and more.

## SSO &amp; provisioning
SAML single sign-on and SCIM provisioning are supported, and console
access can be locked to your organisation's identity provider.</pre>
</section>`;

const demoMergedBody = `
<section class="surface">
  <div class="between" style="align-items:flex-start;margin-bottom:16px">
    <div><h2 style="font-size:20px">Authentication &amp; Single Sign-On</h2>
      <div class="path" style="margin-top:4px">magpie-sales/authentication-and-sso.md</div></div>
    ${badge("ok", "merged")}</div>
  <div style="display:grid;gap:12px;font-size:15.5px">
    <div class="row"><span style="color:${T.ok.fg};font-weight:700">✓</span> Merged PR #142 into <span class="mono">main</span></div>
    <div class="row"><span style="color:${T.ok.fg};font-weight:700">✓</span> Re-indexed 4 sections into Magpie Sales</div>
    <div class="row"><span style="color:${T.ok.fg};font-weight:700">✓</span> Resolved 3 gaps in the Authentication &amp; SSO cluster</div>
  </div>
</section>`;

const demoPayoffBody = `
<section class="surface">
  <div class="between" style="align-items:flex-start;margin-bottom:14px">
    <h2 style="font-size:20px;max-width:74%;line-height:1.3">Does Markdown Magpie support single sign-on (SSO / SAML)?</h2>
    <div class="row"><span class="fpill">Magpie Sales</span>${badge("ok", "HIGH")}</div></div>
  <p class="answer"><b>Yes.</b> Magpie signs in through Auth0, so it works with any OIDC provider — Google, Microsoft
    Entra, Okta and more — and <b>SAML single sign-on</b> with SCIM provisioning is supported. Console access can be
    locked to your own identity provider.</p>
  <div style="margin:20px 0 10px;font-size:14px;color:${T.muted};font-weight:600">1 citation</div>
  ${cite("Authentication &amp; Single Sign-On", "magpie-sales/authentication-and-sso.md", "92%")}
  <div style="margin-top:16px;font-size:15px;color:${T.ok.fg};font-weight:600">↳ Answered from a page that didn't exist an hour ago.</div>
</section>`;

// A GitHub-styled pull-request mock (slide 10). Uses GitHub's palette, not the
// console theme — it is deliberately a different surface (the PR review view).
const demoPr = `
<div style="font-size:24px;font-weight:400;line-height:1.3;margin-bottom:10px;color:#1f2328">
  Add authentication &amp; SSO page <span style="color:#59636e;font-weight:300">#142</span></div>
<div style="display:inline-flex;align-items:center;gap:7px;background:#1a7f37;color:#fff;font-size:14px;font-weight:600;border-radius:99px;padding:6px 15px;margin-bottom:16px">● Open</div>
<div style="color:#59636e;font-size:15px;margin-bottom:20px"><b style="color:#1f2328">magpie-bot</b> wants to merge 1 commit into
  <span style="font-family:ui-monospace,Menlo,monospace">main</span> from
  <span style="font-family:ui-monospace,Menlo,monospace">magpie/authentication-and-sso</span></div>
<div style="border:1px solid #d1d9e0;border-radius:10px;overflow:hidden;margin-bottom:20px">
  <div style="background:#f6f8fa;border-bottom:1px solid #d1d9e0;padding:10px 15px;font-size:14px;color:#59636e">1 changed file</div>
  <div style="display:flex;justify-content:space-between;padding:12px 15px;font-size:14px;font-family:ui-monospace,Menlo,monospace">
    <span>magpie-sales/authentication-and-sso.md</span><span><span style="color:#1a7f37;font-weight:600">+38</span> <span style="color:#59636e">−0</span></span></div></div>
<div style="border:1px solid #d1d9e0;border-radius:12px;padding:18px 20px">
  <div style="display:flex;align-items:center;gap:11px;color:#1f2328;font-size:16px;font-weight:600;margin-bottom:6px">
    <span style="width:24px;height:24px;border-radius:50%;background:#1a7f37;color:#fff;display:grid;place-items:center;font-size:14px">✓</span>
    1 approval · No conflicts with the base branch</div>
  <p style="color:#59636e;font-size:14px;margin:0 0 16px 35px">Merging resolves 3 open knowledge gaps and re-indexes the destination.</p>
  <span style="display:inline-block;background:#1f883d;color:#fff;font-size:15px;font-weight:600;border-radius:8px;padding:10px 18px;margin-left:35px">Merge pull request</span></div>`;

const ghPage = (body) => `<!doctype html><html><head><meta charset="utf-8"/>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:-apple-system,"Segoe UI",Inter,sans-serif;
  background:#fff;color:#1f2328;padding:26px 30px;-webkit-font-smoothing:antialiased;}</style></head><body>${body}</body></html>`;

// A seed plan (slide 16): the planning agent explores a flow's sources and
// proposes a charter + one document per topic, each drafted into review on
// approval. Example: seeding a Magpie Support KB from the Magpie source.
const seedDoc = (title, bullets) =>
  `<article style="border:1px solid ${T.border};border-radius:12px;padding:15px 18px">
     <div class="between" style="margin-bottom:8px"><strong style="font-size:15.5px">${title}</strong>${badge("blue", "proposed")}</div>
     <ul style="margin:0;padding-left:18px;color:${T.muted};font-size:13.5px;line-height:1.7">${bullets.map((b) => `<li>${b}</li>`).join("")}</ul>
   </article>`;

const seedPlanBody = `
<div style="font-size:13.5px;color:${T.accent};margin-bottom:10px">&larr; Seed</div>
<section class="surface">
  <div class="between" style="margin-bottom:16px">
    <div class="row"><h2 style="font-size:20px">Review plan</h2>${badge("neutral", "Magpie Support")}<span class="pill" style="font-size:12.5px">6 documents</span></div>
    <span class="btnP">Approve plan</span></div>
  <div style="border:1px solid ${T.border};border-radius:10px;padding:14px 16px;margin-bottom:18px;background:${T.surfaceMuted}">
    <div style="font-size:11.5px;text-transform:uppercase;letter-spacing:.05em;color:${T.subtle};font-weight:700;margin-bottom:6px">Charter — what this knowledge base should cover</div>
    <p style="font-size:14px;line-height:1.55;color:${T.text};margin:0">From the Markdown Magpie source, this plan proposes six pages covering the queue-only AI model, the knowledge loop, hybrid retrieval and operations — grounded in the code, ready to review before a word is drafted.</p>
  </div>
  <div style="display:grid;gap:12px">
    ${seedDoc("The Knowledge Loop: Ask → Gap → Draft → Review", [
      "How low-confidence answers &amp; feedback become gap candidates",
      "How gaps cluster and draft into grounded proposals",
      "How proposals publish as PRs and re-index on merge"
    ])}
    ${seedDoc("Hybrid Retrieval: Keyword + Vector Search", [
      "When embeddings are computed and stored for a flow",
      "How keyword and vector results are fused and ranked"
    ])}
    ${seedDoc("Deploying &amp; Operating Magpie", [
      "Services: API, watcher, web and Postgres",
      "Queue-only execution and the watcher's job runners"
    ])}
  </div>
</section>`;

// Insights (slide 13): the pipeline-health dashboard — KPI tiles, the open-gap
// backlog trend, and the verification-success gauge. The real page also has a
// question-journey Sankey and throughput/latency charts; this legible subset
// stands in for it. Numbers are illustrative.
const insightsBody = `
<section class="surface">
  <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px">
    ${stat("1,240", "Questions asked")}${stat("82%", "High confidence")}${stat("63", "Gaps merged")}${stat("64%", "Verified closed")}
  </div>
  <div style="display:grid;grid-template-columns:1.5fr 1fr;gap:16px">
    <div style="border:1px solid ${T.border};border-radius:12px;padding:16px 18px">
      <div style="font-size:15px;font-weight:600">Open-gap backlog</div>
      <div style="font-size:12.5px;color:${T.muted};margin-bottom:14px">Net-open gaps · last 30 days</div>
      <svg viewBox="0 0 440 150" width="100%" height="150" preserveAspectRatio="none" style="display:block">
        <line x1="0" y1="149" x2="440" y2="149" stroke="${T.border}" stroke-width="1"/>
        <path d="M0,126 C60,120 100,42 150,34 C210,26 250,72 300,96 C360,124 410,128 440,128 L440,150 L0,150 Z" fill="${T.accentBg}"/>
        <path d="M0,126 C60,120 100,42 150,34 C210,26 250,72 300,96 C360,124 410,128 440,128" fill="none" stroke="${T.accent}" stroke-width="3"/>
      </svg>
      <div style="font-size:12.5px;color:${T.subtle};margin-top:12px">Spiked mid-June — now trending down as the loop keeps up.</div>
    </div>
    <div style="border:1px solid ${T.border};border-radius:12px;padding:16px 18px;display:flex;flex-direction:column;align-items:center">
      <div style="font-size:15px;font-weight:600;align-self:flex-start;margin-bottom:8px">Verification success</div>
      <svg viewBox="0 0 130 130" width="140" height="140">
        <circle cx="65" cy="65" r="50" fill="none" stroke="${T.border}" stroke-width="15"/>
        <circle cx="65" cy="65" r="50" fill="none" stroke="${T.ok.fg}" stroke-width="15" stroke-linecap="round" stroke-dasharray="201 314" transform="rotate(-90 65 65)"/>
        <text x="65" y="63" text-anchor="middle" font-size="27" font-weight="700" fill="${T.text}">64%</text>
        <text x="65" y="83" text-anchor="middle" font-size="12" fill="${T.muted}">closed</text>
      </svg>
      <div style="font-size:12px;color:${T.subtle};text-align:center;margin-top:8px">Merged proposals whose gap-closure check confirmed the fix.</div>
    </div>
  </div>
</section>`;

// name -> [full html, cssWidth, cssHeight]. Height ~matches the deck frame's
// crop band at that width so there is little wasted space.
const pages = {
  ask: [page("Ask · cited answer", askBody), 900, 640],
  gaps: [page("Gaps · weak answers → proposals", gapsBody), 900, 560],
  proposals: [page("Proposals · human review", proposalsBody), 900, 560],
  questionnaires: [page("Questionnaire", questionnairesBody), 940, 700],
  "demo-cluster": [page("Gaps · cluster forming", demoClusterBody), 760, 520],
  "demo-draft": [page("Proposals · drafted fix", demoDraftBody), 760, 470],
  "demo-pr": [ghPage(demoPr), 760, 460],
  "demo-merged": [page("Proposals · merged & re-indexed", demoMergedBody), 760, 340],
  "demo-payoff": [page("Ask · now answered", demoPayoffBody), 900, 480],
  "seed-plan": [page("Seed · proposed plan", seedPlanBody), 900, 720],
  insights: [page("Insights · pipeline health", insightsBody), 940, 470]
};

await mkdir(TMP, { recursive: true });
await mkdir(OUT, { recursive: true });

for (const [name, [html, w, h]] of Object.entries(pages)) {
  const file = join(TMP, `${name}.html`);
  const shot = join(OUT, `${name}.png`);
  await writeFile(file, html);
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
