import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = process.cwd();
const OUT = join(ROOT, "presentation/assets");
const TMP = join(ROOT, "tmp/static-ui-shots");
const CHROME = process.env.CHROME_PATH ?? "C:/Program Files/Google/Chrome/Application/chrome.exe";
const css = readFileSync(join(ROOT, "apps/web/src/app/styles.css"), "utf8");
const logo = resolve(ROOT, "apps/web/public/magpie.jpeg").replaceAll("\\", "/");

const nav = [
  ["ask", "Q", "Ask", "2"],
  ["knowledge", "K", "Knowledge", "18"],
  ["gaps", "G", "Gaps", "3"],
  ["proposals", "P", "Proposals", "2"],
  ["jobs", "J", "Jobs", "1"],
  ["crunch", "Cr", "Crunch", "0"],
  ["config", "C", "Config", ""],
  ["dataflow", "D", "Data Flow", ""],
  ["prompts", "Pr", "Prompts", ""],
  ["mcp", "M", "Connect (MCP)", ""]
];

const titles = {
  ask: ["Ask", "Ask questions against curated Markdown and get cited answers."],
  gaps: ["Gaps", "Cluster weak answers and draft grounded improvements."],
  proposals: ["Proposals", "Review generated Markdown before it reaches Git."],
  knowledge: ["Knowledge", "Browse configured flows, repositories, and indexed documents."],
  dataflow: ["Data Flow", "Inspect how questions, retrieval, jobs, and reviews move through the system."],
  config: ["Config", "Switch execution modes and inspect provider configuration."]
};

function shell(section, body) {
  const [title, subtitle] = titles[section];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Markdown Magpie ${title}</title>
<style>${css}
body{background:#f5f7f2;}
.staticOnly .surface{box-shadow:none;}
.brandLogo{object-fit:cover;}
.mockDiagram{display:grid;gap:14px;}
.mockFlow{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px;align-items:stretch;}
.mockNode{border:1px solid #d9ded6;background:#fff;padding:16px;min-height:92px;display:grid;gap:8px;align-content:center;}
.mockNode strong{font-size:15px;}
.mockArrow{display:grid;place-items:center;color:#285f74;font-weight:900;}
.mockCycle{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:14px;}
.mockCycle .mockNode{border-color:#b8c8d9;background:#f1f6fb;}
.answerCrop{width:940px;margin:30px auto;}
</style>
</head>
<body>
<div class="appShell staticOnly">
  <aside class="sidebar">
    <div class="brand">
      <img class="brandLogo" src="file:///${logo}" alt="" width="40" height="40"/>
      <div class="brandText"><span>Markdown Magpie</span><strong>Knowledge Console</strong></div>
    </div>
    <nav class="sideNav" aria-label="Console sections">
      ${nav.map(([id, glyph, label, count], index) => `${index === 4 || index === 7 ? '<div class="navDivider"></div>' : ''}<a class="${id === section ? 'navButton active' : 'navButton'}"><span class="navGlyph">${glyph}</span><span>${label}</span>${count ? `<span class="pill">${count}</span>` : ""}</a>`).join("")}
    </nav>
    <div class="sideStatus">
      <div class="statusGroup">
        <p class="statusGroupTitle">System</p>
        <div class="statusLine"><span>API</span><span><span class="dot"></span>Online</span></div>
        <div class="statusLine"><span>Documents</span><span>18</span></div>
        <div class="statusLine"><span>Sections</span><span>72</span></div>
      </div>
      <div class="statusGroup">
        <p class="statusGroupTitle">Model</p>
        <div class="statusLine"><span>Mode</span><span>direct</span></div>
        <div class="statusLine"><span>Chat</span><span>openai-compatible</span></div>
        <div class="statusLine"><span>Retrieval</span><span>Hybrid</span></div>
      </div>
    </div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div><p class="eyebrow">Markdown Magpie</p><h1>${title}</h1><p>${subtitle}</p></div>
      <div class="topActions"><span class="refreshTime">Updated 09:30:00</span><button class="button secondary">Refresh</button></div>
    </header>
    ${body}
  </main>
</div>
</body>
</html>`;
}

const answerBlock = `<div class="answerBlock">
  <div class="resultHeader"><div class="rowMeta"><span class="status high">high</span><span class="pill flowPill">Product Support</span></div><code>q-1842</code></div>
  <p>The core package is deliberately thin. It depends on the workspace libraries for Markdown parsing, retrieval, Git publishing, prompts, and shared domain types, so each answer can be traced back to repository source material.</p>
  <div class="citationStack">
    <div class="citation"><div class="citationTop"><strong>Runtime dependencies</strong><code>core/package#dependencies</code></div><span>packages/core/package.json#dependencies</span><p>The core package keeps runtime dependencies small and composes behavior through shared packages.</p></div>
    <div class="citation"><div class="citationTop"><strong>Retrieval exports</strong><code>retrieval/index#exports</code></div><span>packages/retrieval/src/index.ts</span><p>Retrieval, answer synthesis, and routing helpers are exported as shared workspace modules.</p></div>
  </div>
</div>`;

const pages = {
  "02-ask-cited": shell("ask", `<div class="workbench"><section class="surface"><div class="surfaceHeader"><h2>Ask</h2></div><div class="surfaceBody"><form class="questionForm"><label class="field"><span>Question</span><textarea>What external dependencies does the core package have?</textarea></label><button class="button">Ask</button></form>${answerBlock}</div></section><section class="surface"><div class="surfaceHeader"><h2>Answered questions</h2><span class="pill">2</span></div><div class="surfaceBody"><article class="row"><div class="rowTop"><h3>Which review path publishes a drafted knowledge fix?</h3><div class="rowMeta"><span class="pill flowPill">Product Support</span><span class="status medium">medium</span></div></div><p>A drafted fix is promoted to ready, published as a branch or pull request, then marked merged after review.</p></article></div></section></div>`),
  "03-gaps": shell("gaps", `<div class="workbench"><section class="surface"><div class="surfaceHeader"><h2>Suggested Clusters</h2><span class="pill">2</span></div><div class="surfaceBody"><article class="clusterCard"><div class="rowTop"><input class="clusterTitle" value="Source sync and indexing gaps"/><span class="pill flowPill">Product Support</span><span class="pill">2 gaps</span></div><p class="clusterRationale">These questions ask how new source material becomes searchable knowledge.</p><ul class="clusterGaps"><li><span>Explain how source repository changes are synchronized into indexed Markdown sections</span><select><option>Move to...</option></select></li><li><span>Document the operational checklist for publishing generated proposal branches</span><select><option>Move to...</option></select></li></ul><div class="rowActions"><button class="chip">Draft Proposal</button></div></article><article class="clusterCard"><div class="rowTop"><input class="clusterTitle" value="Scheduled cleanup behavior"/><span class="pill flowPill">Product Support</span><span class="pill">1 gap</span></div><p class="clusterRationale">These questions are about cleanup, consolidation, and stale content.</p></article></div></section><section class="surface"><div class="surfaceHeader"><h2>Gap Candidates</h2><span class="pill">3</span></div><div class="surfaceBody"><article class="row"><div class="rowTop"><h3>Clarify when automated crunch runs should consolidate duplicate knowledge pages</h3><span class="pill flowPill">Product Support</span><span class="pill">2 questions</span></div><p>q-1660, q-1788</p><div class="rowActions"><button class="chip">Draft Proposal</button></div></article></div></section></div>`),
  "04-proposal": shell("proposals", `<section class="surface"><div class="surfaceHeader"><h2>Proposals</h2><span class="pill">2</span></div><div class="surfaceBody"><div class="proposalGrid"><div class="list scrollList"><button class="proposalItem selected"><span>Document source sync and re-index workflow</span><small class="path">architecture/source-sync.md</small></button><button class="proposalItem"><span>Clarify scheduled crunch cleanup</span><small class="path">operations/crunch.md</small></button></div><div class="proposalPreview"><div class="rowTop"><div><h3>Document source sync and re-index workflow</h3><p class="path">architecture/source-sync.md</p></div><span class="status ready">ready</span></div><p>Several users asked how source changes become indexed knowledge. This draft adds the missing operational explanation and links it to review.</p><div class="rowActions"><button class="chip selected">Mark Ready</button><button class="chip selected">Publish Branch</button><button class="chip selected">Mark Merged</button><span class="pill">Branch publish available</span></div><pre># Source Sync and Re-indexing\n\nSource repositories are parsed into sections, embedded when hybrid retrieval is enabled, and written into the destination index.\n\n## Review path\n\nWhen a gap is detected, Markdown Magpie drafts a focused update. A reviewer marks it ready, publishes a branch, and merges it through the normal Git workflow.</pre></div></div></div></section>`),
  "05-knowledge": shell("knowledge", `<section class="surface"><div class="surfaceHeader"><h2>Knowledge Flows</h2><button class="button">Index KB</button></div><div class="surfaceBody"><div class="flowWorkspace"><nav class="flowSidebar"><button class="flowSidebarItem selected"><span class="flowSidebarName">Product Support</span><span class="flowSidebarMeta">1 source -> Product Knowledge Base · 2 docs</span></button><button class="flowSidebarItem"><span class="flowSidebarName">Internal Enablement</span><span class="flowSidebarMeta">2 sources -> Enablement KB · 8 docs</span></button></nav><section class="flowDetail"><div class="flowDetailHead"><div><h3>Product Support</h3><div class="flowPipe"><div class="flowNodeGroup"><span class="flowNode git">Product Code</span></div><span class="flowArrow">-&gt;</span><span class="flowNode destination">Product Knowledge Base</span></div></div><button class="button">Index KB</button></div><div class="flowSection"><h4 class="flowSectionTitle">Indexed documents</h4><div class="flowDocs"><div class="flowDocList"><div class="flowDocGroup"><div class="folderHeader"><span>architecture</span><small>1</small></div><div class="flowDocRow selected"><button class="flowDocSelect"><span>Knowledge Loop Architecture</span><small>knowledge-loop.md</small></button><span class="status good">good</span></div></div><div class="flowDocGroup"><div class="folderHeader"><span>operations</span><small>1</small></div><div class="flowDocRow"><button class="flowDocSelect"><span>Review Workflow</span><small>review-workflow.md</small></button><span class="status ready">ready</span></div></div></div><article class="flowDocReader"><div class="rowTop"><div><h3>Knowledge Loop Architecture</h3><p class="path">architecture/knowledge-loop.md</p></div><button class="button secondary">Open full</button></div><div class="rowActions"><span class="pill">product-docs</span><span class="pill">Platform</span><span class="pill">architecture</span></div><pre class="markdownViewer"># Knowledge Loop Architecture\n\nMarkdown Magpie keeps a curated destination knowledge base in Git.\n\n## Answering\n\nQuestions retrieve indexed Markdown sections, synthesize a cited answer, and log confidence.</pre></article></div></div></section></div></div></section>`),
  "06-dataflow": shell("dataflow", `<section class="surface"><div class="surfaceHeader"><h2>Data Flow Architecture</h2></div><div class="surfaceBody dataFlowPanel"><div class="flowTabs"><button class="flowTab active">Overview</button><button class="flowTab">Ask Flow</button><button class="flowTab">Continuous Improvement Cycle</button><button class="flowTab">Queue Architecture</button><button class="flowTab">Automation & Crunch</button></div><div class="flowDiagram"><div class="mockDiagram"><div class="mockFlow"><div class="mockNode"><strong>Git Markdown Repository</strong><span>Source material</span></div><div class="mockNode"><strong>Parse & Index</strong><span>Sections and embeddings</span></div><div class="mockNode"><strong>Postgres Index</strong><span>Searchable knowledge</span></div><div class="mockNode"><strong>Cited Answer</strong><span>Web and MCP</span></div></div><div class="mockCycle"><div class="mockNode"><strong>Learn</strong><span>Low confidence and feedback become gap candidates.</span></div><div class="mockNode"><strong>Generate</strong><span>Draft Markdown with evidence and rationale.</span></div><div class="mockNode"><strong>Review</strong><span>Publish PRs, merge, resolve gaps, re-index.</span></div></div></div></div><div class="flowLegend"><h3>System Components</h3><div class="legendItems"><div class="legendItem"><div class="legendBox" style="background:#fbfcfa;border:2px solid #285f74"></div><span>Source (Git)</span></div><div class="legendItem"><div class="legendBox" style="background:#e8f1f7"></div><span>Processing</span></div><div class="legendItem"><div class="legendBox" style="background:#f0f4f0;border:2px solid #3d6b43"></div><span>Storage</span></div></div></div></div></section>`),
  "07-config": shell("config", `<section class="surface"><div class="surfaceHeader"><h2>Runtime Config</h2><span class="pill">http://localhost:3001</span></div><div class="surfaceBody"><div class="runtimeEditor"><div class="configControl"><span>Execution</span><div class="segmented"><button class="segment active">direct</button><button class="segment">queue</button></div></div><label class="configControl"><span>Provider</span><select><option>OpenAI-compatible</option><option>Azure OpenAI</option><option>Mock</option></select></label><button class="button">Apply</button></div><div class="configStack"><section class="configGroup"><h3>Knowledge</h3><dl><div class="configRow"><dt>repositoryPath</dt><dd>knowledge-bases/product</dd></div><div class="configRow"><dt>checkoutRoot</dt><dd>tmp/checkouts</dd></div></dl></section><section class="configGroup"><h3>Retrieval</h3><dl><div class="configRow"><dt>mode</dt><dd>hybrid</dd></div><div class="configRow"><dt>embeddingProvider</dt><dd>openai-compatible</dd></div></dl></section><section class="configGroup"><h3>Watcher</h3><dl><div class="configRow"><dt>enabled</dt><dd>true</dd></div><div class="configRow"><dt>mode</dt><dd>queue</dd></div></dl></section></div></div></section>`),
  "08-answer-card": `<!doctype html><html><head><meta charset="utf-8"/><style>${css}body{background:#f5f7f2;padding:30px}.answerCrop{width:980px;margin:0 auto;border:1px solid #d9ded6;background:#fff;padding:18px}</style></head><body><div class="answerCrop">${answerBlock}</div></body></html>`,
  "09-improvement-cycle": shell("dataflow", `<section class="surface"><div class="surfaceHeader"><h2>Data Flow Architecture</h2></div><div class="surfaceBody dataFlowPanel"><div class="flowTabs"><button class="flowTab">Overview</button><button class="flowTab">Ask Flow</button><button class="flowTab active">Continuous Improvement Cycle</button><button class="flowTab">Queue Architecture</button><button class="flowTab">Automation & Crunch</button></div><div class="flowDiagram"><div class="mockCycle"><div class="mockNode"><strong>Gap Detection</strong><span>Low confidence, user feedback, and manual flags are grouped into candidates.</span></div><div class="mockNode"><strong>Human Path</strong><span>Reviewer selects a cluster, generates a proposal, edits Markdown, and approves.</span></div><div class="mockNode"><strong>Automated Path</strong><span>Scheduled jobs draft uncovered clusters and promote ready fixes.</span></div><div class="mockNode"><strong>Publish PR</strong><span>Ready proposals become branches or pull requests.</span></div><div class="mockNode"><strong>Merge Outcome</strong><span>Merged fixes resolve gaps; closed PRs are marked rejected.</span></div><div class="mockNode"><strong>Re-index</strong><span>The updated knowledge base feeds the next answer.</span></div></div></div><div class="flowLegend"><h3>Cycle state</h3><div class="legendItems"><div class="legendItem"><div class="legendBox" style="background:#f1f6fb"></div><span>Detect</span></div><div class="legendItem"><div class="legendBox" style="background:#fef9f0;border:2px solid #8b5a00"></div><span>Draft</span></div><div class="legendItem"><div class="legendBox" style="background:#f0f8ee;border:2px solid #3d6b43"></div><span>Resolve</span></div></div></div></div></section>`)
};

await mkdir(TMP, { recursive: true });
await mkdir(OUT, { recursive: true });

for (const [name, html] of Object.entries(pages)) {
  const file = join(TMP, `${name}.html`);
  const shot = join(OUT, `${name}.png`);
  await writeFile(file, html);
  const result = spawnSync(CHROME, [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--window-size=1440,900",
    `--screenshot=${shot}`,
    `file:///${resolve(file).replaceAll("\\", "/")}`
  ], { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `Chrome failed for ${name}`);
  }
  console.log(`saved ${shot}`);
}
