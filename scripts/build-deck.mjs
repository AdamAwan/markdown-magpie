// Builds presentation/index.html as a single self-contained file with all
// images inlined as base64 data URIs. Re-run after changing assets or content.
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OPT = join(ROOT, "presentation/assets/opt");
const EXAMPLE = join(ROOT, "presentation/assets/example");

const img = {};
for (const f of readdirSync(OPT)) {
  const key = f.replace(/\.(jpg|jpeg|png)$/i, "");
  const b64 = readFileSync(join(OPT, f)).toString("base64");
  img[key] = `data:image/jpeg;base64,${b64}`;
}
// Demo screenshots (slides 8–10). Kept at native format/resolution rather than
// downscaled into opt/, because they are text-heavy captures that must stay legible.
const mimeOf = (f) => (/\.png$/i.test(f) ? "image/png" : "image/jpeg");
for (const f of readdirSync(EXAMPLE)) {
  const key = f.replace(/\.(jpg|jpeg|png)$/i, "");
  const b64 = readFileSync(join(EXAMPLE, f)).toString("base64");
  img[key] = `data:${mimeOf(f)};base64,${b64}`;
}
const A = (k) => img[k] ?? "";

// ---- helpers -------------------------------------------------------------
const frame = (src, { tall = false, auto = false, label = "localhost:3000 — Knowledge Console", pos = "top" } = {}) => `
  <div class="bf ${tall ? "bf--tall" : ""} ${auto ? "bf--auto" : ""}">
    <div class="bf__bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="bf__url">${label}</span></div>
    <div class="bf__view"><img src="${src}" alt="" style="object-position:center ${pos}"/></div>
  </div>`;

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Markdown Magpie — won't lie, leak, or rot</title>
<style>
  :root{
    --ink:#17211d; --muted:#65716b; --line:#d9ded6; --line-2:#b9c4bc;
    --paper:#ffffff; --wash:#f5f7f2; --wash-2:#edf4f5;
    --accent:#285f74; --accent-2:#4aa3bd; --accent-soft:#e5f1f4;
    --ok:#3d6b43; --warn:#92522f; --bad:#9a3a2d;
    --font:"Inter",ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;
  }
  *{box-sizing:border-box;}
  html,body{margin:0;height:100%;}
  body{font-family:var(--font);background:#0d1411;color:var(--ink);overflow:hidden;}
  .deck{position:fixed;inset:0;}
  .slide{position:absolute;inset:0;display:none;flex-direction:column;justify-content:center;
    padding:clamp(36px,5vw,84px);opacity:0;transition:opacity .45s ease;overflow:hidden;}
  .slide.active{display:flex;opacity:1;}
  .slide.light{background:var(--wash);color:var(--ink);}
  .slide.ink{background:radial-gradient(120% 120% at 80% -10%,#1d2c27 0%,#121a17 60%,#0d1411 100%);color:#eef2ec;}
  .wrap{width:100%;max-width:1180px;margin:0 auto;}

  /* typography */
  h1{font-size:clamp(34px,5.4vw,68px);line-height:1.03;letter-spacing:-.022em;margin:.1em 0 .35em;font-weight:650;}
  h2{font-size:clamp(26px,3.6vw,46px);line-height:1.08;letter-spacing:-.02em;margin:0 0 .5em;font-weight:650;}
  .kicker{color:var(--accent);font-weight:600;font-size:clamp(13px,1.35vw,17px);letter-spacing:.04em;text-transform:uppercase;}
  .ink .kicker{color:var(--accent-2);}
  .sub{font-size:clamp(16px,1.9vw,24px);color:var(--muted);line-height:1.45;max-width:34ch;}
  .ink .sub{color:#aebcb4;}
  .neg{color:var(--bad);} .ink .neg{color:#e8917f;}

  /* brand + chrome */
  .brand{display:flex;align-items:center;gap:13px;margin-bottom:26px;}
  .brand img{width:42px;height:42px;border-radius:10px;}
  .brand .nm{font-weight:600;font-size:19px;letter-spacing:-.01em;}
  .progress{position:fixed;top:0;left:0;height:3px;background:linear-gradient(90deg,var(--accent),var(--accent-2));z-index:50;transition:width .3s ease;}
  .hud{position:fixed;bottom:18px;right:22px;z-index:50;display:flex;align-items:center;gap:12px;
    font-size:12.5px;color:var(--muted);background:rgba(255,255,255,.7);backdrop-filter:blur(6px);
    border:1px solid var(--line);border-radius:99px;padding:6px 12px;}
  .slide.ink ~ .hud{}
  .hud b{color:var(--ink);font-weight:600;}
  .hint{position:fixed;bottom:18px;left:22px;z-index:50;font-size:12px;color:var(--muted);
    background:rgba(255,255,255,.6);border:1px solid var(--line);border-radius:99px;padding:6px 12px;}

  /* cards */
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:clamp(14px,1.6vw,22px);}
  .card{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:clamp(18px,2vw,26px);}
  .ink .card{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12);}
  .card .ic{width:42px;height:42px;border-radius:11px;background:var(--accent-soft);color:var(--accent);
    display:grid;place-items:center;font-size:21px;margin-bottom:14px;}
  .ink .card .ic{background:rgba(74,163,189,.16);color:var(--accent-2);}
  .card h3{margin:0 0 8px;font-size:clamp(18px,2vw,25px);letter-spacing:-.01em;}
  .card p{margin:0;color:var(--muted);font-size:clamp(13px,1.4vw,16px);line-height:1.5;}
  .ink .card p{color:#aebcb4;}
  .chip{display:inline-block;margin-top:14px;font-size:12px;font-weight:600;color:var(--accent);
    background:var(--accent-soft);padding:4px 11px;border-radius:99px;}
  .ink .chip{color:var(--accent-2);background:rgba(74,163,189,.14);}

  /* split layout */
  .split{display:grid;grid-template-columns:0.92fr 1.08fr;gap:clamp(22px,3vw,48px);align-items:center;}
  .split.rev{grid-template-columns:1.08fr .92fr;}
  ul.feat{list-style:none;padding:0;margin:.6em 0 0;display:grid;gap:14px;}
  ul.feat li{display:flex;gap:12px;font-size:clamp(15px,1.65vw,20px);line-height:1.4;}
  ul.feat li .b{flex:0 0 auto;width:24px;height:24px;border-radius:7px;background:var(--accent-soft);
    color:var(--accent);display:grid;place-items:center;font-size:13px;font-weight:700;margin-top:2px;}
  ul.feat li b{color:var(--ink);} ul.feat li span{color:var(--muted);}
  .ink ul.feat li b{color:#eef2ec;} .ink ul.feat li span{color:#aebcb4;}

  /* browser frame for screenshots */
  .bf{border:1px solid var(--line-2);border-radius:12px;overflow:hidden;background:#fff;
    box-shadow:0 30px 60px -34px rgba(23,33,29,.55);}
  .bf__bar{display:flex;align-items:center;gap:7px;padding:9px 13px;background:#eef1ec;border-bottom:1px solid var(--line);}
  .bf__bar .d{width:10px;height:10px;border-radius:50%;background:#cdd5cc;}
  .bf__url{margin-left:12px;font-size:12px;color:var(--muted);}
  .bf__view{height:clamp(300px,46vh,520px);overflow:hidden;}
  .bf--tall .bf__view{height:clamp(340px,62vh,640px);}
  .bf--auto .bf__view{height:auto;max-height:clamp(360px,58vh,560px);}
  .bf__view img{width:100%;display:block;}

  /* generic two-tone diagram blocks */
  .flowrow{display:flex;align-items:stretch;gap:12px;flex-wrap:wrap;}
  .node{flex:1;min-width:120px;background:var(--paper);border:1px solid var(--line);border-radius:12px;
    padding:16px;text-align:center;font-size:clamp(13px,1.4vw,16px);}
  .node .t{font-weight:600;display:block;margin-bottom:4px;}
  .node small{color:var(--muted);}
  .node.raw{background:#f4efe7;border-color:#e3d9c6;}
  .node.users{background:var(--accent-soft);border-color:#bfdde4;}
  .arrow{align-self:center;color:var(--accent);font-size:22px;}
  .divider{flex:0 0 88px;align-self:stretch;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;}
  .divider .ln{flex:1;width:0;border-left:2px dashed var(--accent);}
  .divider .lock{font-size:17px;background:var(--accent-soft);border:1px solid #bfdde4;border-radius:99px;width:36px;height:36px;display:grid;place-items:center;}
  .divider .cap{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--accent);text-align:center;line-height:1.25;}
  .node .mk{width:22px;height:22px;border-radius:6px;vertical-align:-5px;margin-right:6px;}

  /* matrix table */
  table.matrix{width:100%;border-collapse:collapse;font-size:clamp(13px,1.5vw,18px);}
  table.matrix th,table.matrix td{text-align:left;padding:14px 16px;border-bottom:1px solid var(--line);}
  table.matrix th{color:var(--muted);font-weight:600;font-size:13px;text-transform:uppercase;letter-spacing:.05em;}
  table.matrix td.src{font-weight:600;}
  table.matrix td .ar{color:var(--accent);font-weight:700;}
  table.matrix tr:last-child td{border-bottom:none;}

  /* steps */
  .steps{display:grid;grid-template-columns:repeat(3,1fr);gap:18px;margin-top:8px;}
  .step{background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:24px;}
  .step .n{width:34px;height:34px;border-radius:9px;background:var(--ink);color:#fff;display:grid;place-items:center;font-weight:700;margin-bottom:14px;}
  .step h3{margin:0 0 6px;font-size:20px;} .step p{margin:0;color:var(--muted);font-size:15px;line-height:1.5;}
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#0f1714;color:#cfe6dd;
    padding:3px 7px;border-radius:6px;}

  /* MCP / Claude transcript */
  .chat{background:#0f1714;border:1px solid rgba(255,255,255,.12);border-radius:16px;padding:22px;max-width:760px;}
  .chat .turn{margin-bottom:16px;} .chat .role{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:#7f968c;margin-bottom:6px;}
  .chat .you{color:#eef2ec;font-size:clamp(15px,1.7vw,19px);}
  .chat .tool{display:inline-flex;align-items:center;gap:8px;background:rgba(74,163,189,.14);color:#9fd3e2;
    border:1px solid rgba(74,163,189,.3);border-radius:9px;padding:7px 12px;font-family:ui-monospace,monospace;font-size:13px;}
  .chat .ans{color:#dfe8e3;font-size:clamp(14px,1.55vw,18px);line-height:1.5;}
  .chat .cites{margin-top:12px;display:grid;gap:7px;}
  .chat .cite{display:flex;gap:8px;align-items:baseline;font-size:13px;color:#a9bcb3;}
  .chat .cite .pth{font-family:ui-monospace,monospace;color:#9fd3e2;}
  .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:99px;}
  .badge.hi{background:rgba(61,107,67,.25);color:#9fd9a6;}
  .badge.lo{background:rgba(154,58,45,.3);color:#e8917f;}
  .live{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#e8917f;}
  .live .dot{width:9px;height:9px;border-radius:50%;background:#e8917f;animation:pulse 1.4s infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  /* demo: MCP screenshot pair (slide 8) + payoff shot (slide 10) */
  .mcpshots{display:grid;grid-template-columns:1fr 1fr;gap:clamp(16px,2vw,26px);margin-top:22px;align-items:start;}
  .mcpshot{margin:0;}
  .mcpshot img{width:100%;display:block;border-radius:10px;border:1px solid rgba(255,255,255,.14);
    box-shadow:0 18px 36px -28px rgba(0,0,0,.6);}
  .mcpshot figcaption{margin-top:11px;font-size:14px;line-height:1.45;color:#aebcb4;}
  .mcpshot figcaption .badge{margin-right:7px;vertical-align:1px;}
  .payoff{margin:0;}
  .payoff img{width:100%;display:block;border-radius:12px;border:1px solid rgba(255,255,255,.14);
    box-shadow:0 22px 44px -30px rgba(0,0,0,.7);}

  /* filmstrip */
  .strip{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;}
  .strip figure{margin:0;}
  .strip .shot{border:1px solid var(--line-2);border-radius:10px;overflow:hidden;height:clamp(150px,22vh,230px);background:#fff;
    box-shadow:0 18px 36px -28px rgba(23,33,29,.5);}
  .strip .shot img{width:100%;display:block;object-fit:cover;object-position:top;}
  .strip figcaption{margin-top:9px;font-size:13px;color:var(--muted);}
  .strip figcaption b{color:var(--ink);display:block;font-size:14px;}
  .strip .seq{display:grid;grid-template-columns:auto 1fr;gap:7px;align-items:center;}
  .strip .seq .n{width:20px;height:20px;border-radius:6px;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:grid;place-items:center;}

  /* demo: two readable screenshots side by side (slides 9–10) */
  .demoduo{display:grid;grid-template-columns:1fr 1fr;gap:clamp(20px,2.8vw,42px);margin-top:24px;align-items:start;}
  .demoduo figure{margin:0;}
  .demoduo figcaption{display:flex;align-items:center;gap:9px;margin-bottom:13px;font-size:clamp(14px,1.5vw,16px);color:var(--muted);line-height:1.4;}
  .demoduo figcaption .n{flex:0 0 auto;width:24px;height:24px;border-radius:7px;background:var(--accent);color:#fff;font-size:12px;font-weight:700;display:grid;place-items:center;}
  .demoduo figcaption b{color:var(--ink);}

  .pillars{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;}
  .pillar{display:flex;gap:14px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px;}
  .pillar .ic{flex:0 0 auto;width:44px;height:44px;border-radius:11px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:22px;}
  .pillar h3{margin:0 0 5px;font-size:19px;} .pillar p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.5;}

  .footnote{margin-top:22px;font-size:13px;color:var(--muted);}
  .ink .footnote{color:#8aa094;}
  .big-quote{font-size:clamp(20px,2.4vw,30px);line-height:1.3;font-weight:500;letter-spacing:-.01em;}

  .overlay{position:fixed;inset:0;background:rgba(13,20,17,.96);z-index:80;display:none;padding:40px;overflow:auto;}
  .overlay.show{display:block;}
  .grid{display:grid;grid-template-columns:repeat(4,1fr);gap:14px;max-width:1100px;margin:0 auto;}
  .grid .t{aspect-ratio:16/9;border:1px solid rgba(255,255,255,.15);border-radius:8px;background:#16211c;color:#cfe6dd;
    padding:12px;font-size:12px;cursor:pointer;overflow:hidden;}
  .grid .t b{color:#fff;display:block;font-size:13px;margin-bottom:4px;}
  .grid .t:hover{border-color:var(--accent-2);}
</style>
</head>
<body>
<div class="progress" id="progress"></div>
<div class="deck" id="deck">

  <!-- 1 TITLE -->
  <section class="slide ink" data-title="Title">
    <div class="wrap">
      <div class="brand"><img src="${A("icon")}" alt="Markdown Magpie"/><span class="nm">Markdown Magpie</span></div>
      <div class="kicker">A living knowledge layer for the things you can't just paste into a chatbot</div>
      <h1>Knowledge that won't<br/><span class="neg">lie</span>, <span class="neg">leak</span>, or <span class="neg">rot</span>.</h1>
      <p class="sub">Grounded in your real source material. Curated through review. Getting better every time someone asks.</p>
    </div>
  </section>

  <!-- 2 PROBLEM -->
  <section class="slide light" data-title="The problem">
    <div class="wrap">
      <div class="kicker">The problem</div>
      <h2>Sharing what we know keeps failing the same three ways.</h2>
      <p class="sub" style="max-width:60ch">We've all built knowledge bases. The hard part was never writing the first page — it's keeping it <b>true</b>, keeping it <b>safe</b>, and keeping it <b>alive</b> once the author moves on.</p>
      <div class="cards" style="margin-top:30px">
        <div class="card"><div class="ic">🥀</div><h3>It rots</h3><p>Docs drift out of date the moment they're written. Nobody owns the upkeep, so trust quietly erodes.</p></div>
        <div class="card"><div class="ic">🔓</div><h3>It leaks</h3><p>Pointing AI at raw code and internal files risks exposing things end users were never meant to see.</p></div>
        <div class="card"><div class="ic">🎭</div><h3>It lies</h3><p>A confident chatbot with no sources will fill the gaps by guessing — and you can't tell when.</p></div>
      </div>
    </div>
  </section>

  <!-- 3 INSIGHT -->
  <section class="slide light" data-title="The insight">
    <div class="wrap">
      <div class="kicker">The idea</div>
      <h2>Don't dump the knowledge. Put a curated layer <em>on top</em> of the source.</h2>
      <div class="flowrow" style="margin-top:34px">
        <div class="node raw"><span class="t">Raw material</span><small>code · internal docs · restricted folders · messy wikis</small></div>
        <div class="arrow">→</div>
        <div class="node users" style="flex:1.2"><span class="t"><img class="mk" src="${A("icon")}" alt=""/>Markdown Magpie</span><small>parses, indexes, answers with citations, curates via review</small></div>
        <div class="divider"><div class="ln"></div><div class="lock">🔒</div><div class="cap">no raw<br/>access</div><div class="ln"></div></div>
        <div class="node"><span class="t">End users</span><small>a clean, cited knowledge base — and nothing more</small></div>
      </div>
      <p class="footnote">The raw material stays on one side of the wall. People get the distilled, verifiable knowledge — never the source it was distilled from.</p>
    </div>
  </section>

  <!-- 4 THREE PROMISES -->
  <section class="slide ink" data-title="Three promises">
    <div class="wrap">
      <div class="kicker">The spine</div>
      <h2>Three promises — one for each way knowledge fails.</h2>
      <div class="cards" style="margin-top:26px">
        <div class="card"><div class="ic">⚖️</div><h3>Won't <span class="neg">lie</span></h3><p>Every answer cites file, heading &amp; commit, logs its own confidence, and says "I don't know" rather than guessing.</p><span class="chip">grounded · cited · abstains</span></div>
        <div class="card"><div class="ic">🛡️</div><h3>Won't <span class="neg">leak</span></h3><p>Raw material never reaches end users. Every change to the knowledge is a reviewed Git pull request with full history.</p><span class="chip">curated · PR-gated · audited</span></div>
        <div class="card"><div class="ic">♻️</div><h3>Won't <span class="neg">rot</span></h3><p>It finds its own gaps, drafts fixes, raises PRs. Crunch consolidates, de-dupes &amp; flags contradictions.</p><span class="chip">self-improves · self-prunes</span></div>
      </div>
    </div>
  </section>

  <!-- 5 WON'T LIE -->
  <section class="slide light" data-title="Won't lie">
    <div class="wrap split">
      <div>
        <div class="kicker">Won't lie</div>
        <h2>Grounded by construction.</h2>
        <ul class="feat">
          <li><span class="b">1</span><div><b>Every claim is cited</b> <span>— back to the exact file, heading and commit it came from.</span></div></li>
          <li><span class="b">2</span><div><b>Confidence is scored &amp; shown</b> <span>— a HIGH/LOW badge on every answer, not buried.</span></div></li>
          <li><span class="b">3</span><div><b>It abstains</b> <span>— if the source doesn't cover it, it says so instead of inventing an answer.</span></div></li>
        </ul>
        <p class="footnote">Ask something it can't support and you get an honest "not enough here" — which becomes a tracked gap (see "won't rot").</p>
      </div>
      ${frame(A("02-ask-cited"), { label: "localhost:3000 — Ask · cited answer", pos: "top" })}
    </div>
  </section>

  <!-- 6 WON'T LEAK -->
  <section class="slide light" data-title="Won't leak">
    <div class="wrap split rev">
      ${frame(A("04-proposal"), { label: "localhost:3000 — Proposals · human review", pos: "top" })}
      <div>
        <div class="kicker">Won't leak</div>
        <h2>The raw material stays behind the wall.</h2>
        <ul class="feat">
          <li><span class="b">✓</span><div><b>Users never touch the source</b> <span>— no code, internal docs or restricted folders. Just the curated answer.</span></div></li>
          <li><span class="b">✓</span><div><b>Every change is a reviewed PR</b> <span>— an admin approves it, exactly like a code review, before it ships.</span></div></li>
          <li><span class="b">✓</span><div><b>Full audit &amp; history</b> <span>— diffable, reversible, attributable. It's just Git.</span></div></li>
        </ul>
        <p class="footnote">This is what makes it safe to point at sensitive corpora that you could never hand to a generic chatbot.</p>
      </div>
    </div>
  </section>

  <!-- 7 WON'T ROT -->
  <section class="slide light" data-title="Won't rot">
    <div class="wrap split">
      <div>
        <div class="kicker">Won't rot</div>
        <h2>It maintains itself.</h2>
        <ul class="feat">
          <li><span class="b">①</span><div><b>Detects its own gaps</b> <span>— clusters low-confidence answers &amp; unhelpful feedback into themes.</span></div></li>
          <li><span class="b">②</span><div><b>Drafts grounded fixes</b> <span>— writes proposed Markdown with evidence &amp; a rationale, ready for review.</span></div></li>
          <li><span class="b">③</span><div><b>Crunch prunes</b> <span>— consolidates duplicates, flags contradictions &amp; stale docs.</span></div></li>
        </ul>
        <p class="footnote"><b>Usage is the maintenance signal.</b> The more it's asked, the faster it finds and fills its own weak spots.</p>
      </div>
      ${frame(A("03-gaps"), { label: "localhost:3000 — Gaps · weak answers → proposals", pos: "top" })}
    </div>
  </section>

  <!-- 8 DEMO: FROM INSIDE CLAUDE -->
  <section class="slide ink" data-title="Demo · in Claude">
    <div class="wrap">
      <div class="kicker">Demo · part 1 — in Claude</div>
      <h2 style="margin:.1em 0 0">It meets people where they already work.</h2>
      <div class="mcpshots">
        <figure class="mcpshot">
          <img src="${A("mcp-high-confidence")}" alt="kb_ask answering FlowerBI's key features with high confidence"/>
          <figcaption><span class="badge hi">HIGH</span>Ask what's covered — a cited answer, straight inside the chat.</figcaption>
        </figure>
        <figure class="mcpshot">
          <img src="${A("mcp-low-confidence-2")}" alt="kb_ask abstaining and flagging a knowledge gap"/>
          <figcaption><span class="badge lo">LOW</span>Ask what's missing — it abstains honestly and flags a knowledge gap.</figcaption>
        </figure>
      </div>
      <p class="footnote">Same engine, exposed as MCP tools (<span class="mono">kb_ask</span>, <span class="mono">kb_search</span>, <span class="mono">kb_feedback</span>) — so the knowledge shows up in Claude, Codex, or any agent, and every weak answer feeds back as a gap.</p>
    </div>
  </section>

  <!-- 9 DEMO: BACKSTAGE · DETECT & DRAFT -->
  <section class="slide light" data-title="Demo · detect & draft">
    <div class="wrap">
      <div class="kicker">Demo · part 2 — backstage</div>
      <h2>That gap becomes a reviewed improvement.</h2>
      <div class="demoduo">
        <figure>
          <figcaption><span class="n">1</span><span><b>Cluster the gaps</b> — weak answers group into themes.</span></figcaption>
          ${frame(A("web-gap-cluster"), { auto: true, label: "localhost:3000 — Gaps · suggested clusters" })}
        </figure>
        <figure>
          <figcaption><span class="n">2</span><span><b>Draft a fix</b> — grounded Markdown with a rationale.</span></figcaption>
          ${frame(A("web-proposal"), { auto: true, label: "localhost:3000 — Proposals · drafted fix" })}
        </figure>
      </div>
      <p class="footnote">It detects its own weak spots and drafts the fix — you never start from a blank page.</p>
    </div>
  </section>

  <!-- 10 DEMO: BACKSTAGE · REVIEW & SHIP -->
  <section class="slide light" data-title="Demo · review & ship">
    <div class="wrap">
      <div class="kicker">Demo · part 2 — backstage</div>
      <h2>Reviewed like code, then merged in.</h2>
      <div class="demoduo">
        <figure>
          <figcaption><span class="n">3</span><span><b>Raise PRs</b> — each fix is a reviewable pull request.</span></figcaption>
          ${frame(A("web-raised-prs"), { auto: true, label: "github.com — Pull requests" })}
        </figure>
        <figure>
          <figcaption><span class="n">4</span><span><b>Merge &amp; re-index</b> — approved, merged, re-indexed.</span></figcaption>
          ${frame(A("web-merged-in"), { auto: true, label: "localhost:3000 — Knowledge Console · re-indexed" })}
        </figure>
      </div>
      <p class="footnote">Every change is a Git PR an admin approves — diffable, reversible, attributable. The raw source never leaves the wall.</p>
    </div>
  </section>

  <!-- 11 DEMO: THE PAYOFF -->
  <section class="slide ink" data-title="Demo · the payoff">
    <div class="wrap split">
      <div>
        <div class="kicker">Demo · part 3 — the payoff</div>
        <h2>Ask again — now it knows.</h2>
        <ul class="feat">
          <li><span class="b">✓</span><div><b>The same question that drew a blank</b> <span>now returns a complete, grounded answer.</span></div></li>
          <li><span class="b">✓</span><div><b>No engineer wrote that page</b> <span>— the loop drafted it from real usage.</span></div></li>
          <li><span class="b">✓</span><div><b>It still went through review</b> <span>before it ever shipped to a user.</span></div></li>
        </ul>
        <p class="footnote">All real: captured against a live FlowerBI knowledge base while building these slides.</p>
      </div>
      <figure class="payoff">
        <img src="${A("mcp-result-of-learning")}" alt="kb_ask now returning a full example FlowerBI star schema after the gap was filled"/>
      </figure>
    </div>
  </section>

  <!-- 12 CHEAP & YOURS -->
  <section class="slide light" data-title="Cheap & yours">
    <div class="wrap">
      <div class="kicker">…and it's cheap, and it's yours</div>
      <h2>No lock-in. Runs on what you already pay for.</h2>
      <div class="pillars" style="margin-top:24px">
        <div class="pillar"><div class="ic">🔌</div><div><h3>Vendor-neutral</h3><p>Swap chat, embedding, git &amp; execution providers — Azure OpenAI, Anthropic, OpenAI-compatible, local. No model lock-in.</p></div></div>
        <div class="pillar"><div class="ic">🧩</div><div><h3>MCP-native</h3><p>Knowledge lands inside the tools people already use, instead of being one more tab nobody opens.</p></div></div>
        <div class="pillar"><div class="ic">💸</div><div><h3>Bring your own agent</h3><p>A watcher lets Claude Code / Codex run the AI jobs under subscriptions you already hold — flat-rate seats become KB compute.</p></div></div>
        <div class="pillar"><div class="ic">📄</div><div><h3>Just Markdown + Git</h3><p>The whole knowledge base is plain files in a repo. Portable, forkable, future-proof — no black box.</p></div></div>
      </div>
    </div>
  </section>

  <!-- 13 WIDE APPLICATIONS -->
  <section class="slide light" data-title="Applications">
    <div class="wrap">
      <div class="kicker">Wide applications</div>
      <h2>One engine. Point it at any pile of source material.</h2>
      <table class="matrix" style="margin-top:18px">
        <thead><tr><th>Source material</th><th></th><th>Becomes a knowledge base for…</th></tr></thead>
        <tbody>
          <tr><td class="src">Product Code</td><td><span class="ar">→</span></td><td>Internal product questions, answered with citations into the code.</td></tr>
          <tr><td class="src">Product Code + Azure Docs + Company Policies</td><td><span class="ar">→</span></td><td>Security questionnaires — grounded, consistent, defensible.</td></tr>
          <tr><td class="src">Product Code + Customer Knowledge Base</td><td><span class="ar">→</span></td><td>Front-line support, with every answer cited to the product itself.</td></tr>
          <tr><td class="src">Employee Handbook + HR Policies</td><td><span class="ar">→</span></td><td>Employee onboarding — new joiners self-serve on policies, benefits and process instead of pinging HR.</td></tr>
          <tr><td class="src">IT Runbooks + Known Issues</td><td><span class="ar">→</span></td><td>IT self-service — staff find known fixes themselves, with cited resolutions instead of raising a ticket.</td></tr>
          <tr><td class="src">Product Docs + Pricing and Competitor Notes</td><td><span class="ar">→</span></td><td>Sales and pre-sales — consistent, cited answers to RFPs and prospect questions.</td></tr>
          <tr><td class="src">Product Knowledge Base</td><td><span class="ar">→</span></td><td>Tames a large, messy knowledge base into a refined, de-duplicated, contradiction-free distillation.</td></tr>
        </tbody>
      </table>
      <p class="footnote">Each gets its own curated layer and its own reviewer — same loop, different source.</p>
    </div>
  </section>

  <!-- 14 EASY SETUP -->
  <section class="slide light" data-title="Easy setup">
    <div class="wrap">
      <div class="kicker">Easy to set up</div>
      <h2>Point it at a repo. That's the setup.</h2>
      <div class="steps" style="margin-top:8px">
        <div class="step"><div class="n">1</div><h3>Name a source</h3><p>Give it a Git repo (or several) of source material to learn from.</p></div>
        <div class="step"><div class="n">2</div><h3>Name a destination</h3><p>A repo where the curated knowledge base lives and PRs are raised.</p></div>
        <div class="step"><div class="n">3</div><h3>Let the loop run</h3><p>It indexes, answers, finds gaps, drafts fixes — you review. That's it.</p></div>
      </div>
      <p class="footnote">No bespoke pipeline per use case — the same loop you just saw, configured in a few lines.</p>
    </div>
  </section>

  <!-- 15 CTA -->
  <section class="slide ink" data-title="Call to action">
    <div class="wrap">
      <div class="brand"><img src="${A("icon")}" alt=""/><span class="nm">Markdown Magpie</span></div>
      <h1 style="max-width:18ch">Pick one source. Let it run.</h1>
      <p class="big-quote" style="max-width:30ch;color:#cfe6dd">Knowledge that won't lie, won't leak, and won't rot — built on the source you already have.</p>
      <p class="footnote">Let's choose a first pilot — questions over the Product Code is the obvious one — and stand up a cited, self-maintaining KB.</p>
    </div>
  </section>

</div>

<div class="hud"><span id="counter">1 / 13</span> · <b id="hud-title">Title</b></div>
<div class="hint">← → navigate &nbsp;·&nbsp; <b>O</b> overview &nbsp;·&nbsp; <b>F</b> fullscreen</div>

<div class="overlay" id="overlay"><div class="grid" id="grid"></div></div>

<script>
  const slides = Array.from(document.querySelectorAll(".slide"));
  const total = slides.length;
  let i = 0;
  const progress = document.getElementById("progress");
  const counter = document.getElementById("counter");
  const hudTitle = document.getElementById("hud-title");
  function show(n){
    i = Math.max(0, Math.min(total-1, n));
    slides.forEach((s,k)=>s.classList.toggle("active", k===i));
    progress.style.width = ((i+1)/total*100)+"%";
    counter.textContent = (i+1)+" / "+total;
    hudTitle.textContent = slides[i].dataset.title || "";
    if(location.hash !== "#"+(i+1)) history.replaceState(null,"","#"+(i+1));
  }
  function next(){show(i+1);} function prev(){show(i-1);}
  const overlay=document.getElementById("overlay"), grid=document.getElementById("grid");
  slides.forEach((s,k)=>{const t=document.createElement("div");t.className="t";
    t.innerHTML="<b>"+(k+1)+". "+(s.dataset.title||"")+"</b>";
    t.onclick=()=>{toggleOverview(false);show(k);};grid.appendChild(t);});
  function toggleOverview(force){const open = force ?? !overlay.classList.contains("show");
    overlay.classList.toggle("show", open);}
  document.addEventListener("keydown",(e)=>{
    if(["ArrowRight","PageDown"," "].includes(e.key)){e.preventDefault();next();}
    else if(["ArrowLeft","PageUp"].includes(e.key)){e.preventDefault();prev();}
    else if(e.key==="Home"){show(0);} else if(e.key==="End"){show(total-1);}
    else if(e.key.toLowerCase()==="o"){toggleOverview();}
    else if(e.key==="Escape"){toggleOverview(false);}
    else if(e.key.toLowerCase()==="f"){if(!document.fullscreenElement)document.documentElement.requestFullscreen();else document.exitFullscreen();}
  });
  document.getElementById("deck").addEventListener("click",(e)=>{
    if(overlay.classList.contains("show"))return;
    const x=e.clientX/window.innerWidth; if(x>0.62)next(); else if(x<0.38)prev();
  });
  window.addEventListener("hashchange",()=>{const n=parseInt(location.hash.slice(1));if(n)show(n-1);});
  show(parseInt(location.hash.slice(1))-1 || 0);
</script>
</body>
</html>`;

writeFileSync(join(ROOT, "presentation/index.html"), HTML);
const kb = Math.round(Buffer.byteLength(HTML) / 1024);
console.log(`Wrote presentation/index.html (${kb} KB, ${slides_count(HTML)} slides)`);
function slides_count(h){return (h.match(/class="slide /g)||[]).length;}
