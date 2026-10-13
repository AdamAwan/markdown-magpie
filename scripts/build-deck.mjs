// Builds presentation/index.html as a single self-contained file with all
// images inlined as base64 data URIs. Re-run after changing assets or content.
import { mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const OPT = join(ROOT, "presentation/assets/opt");

const mimeOf = (f) => (/\.png$/i.test(f) ? "image/png" : "image/jpeg");
const img = {};
// All deck imagery — product shots (slides 5-7, 12) and the demo mock-ups
// (slides 9-11) — is rendered by scripts/render-static-ui-shots.mjs straight into
// opt/ (PNG for the shots, a JPEG for the logo), inlined by its real MIME type.
for (const f of readdirSync(OPT)) {
  const key = f.replace(/\.(jpg|jpeg|png)$/i, "");
  const b64 = readFileSync(join(OPT, f)).toString("base64");
  img[key] = `data:${mimeOf(f)};base64,${b64}`;
}
const A = (k) => img[k] ?? "";

// ---- helpers -------------------------------------------------------------
const frame = (src, { tall = false, auto = false, label = "localhost:3000 — Knowledge Console", pos = "top" } = {}) => `
  <div class="bf ${tall ? "bf--tall" : ""} ${auto ? "bf--auto" : ""}">
    <div class="bf__bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="bf__url">${label}</span></div>
    <div class="bf__view"><img src="${src}" alt="" style="object-position:center ${pos}"/></div>
  </div>`;

/** The Claude starburst, as an inline SVG — ten tapered spokes around a small hub. */
const claudeMark = (size = 18) => `
  <svg class="cmark" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true">
    ${Array.from({ length: 10 }, (_, i) => {
      const a = ((i * 36 - 90) * Math.PI) / 180;
      const at = (r) => [(12 + Math.cos(a) * r).toFixed(2), (12 + Math.sin(a) * r).toFixed(2)];
      const [x1, y1] = at(2.4);
      const [x2, y2] = at(i % 2 ? 8.7 : 10.5);
      return `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="currentColor" stroke-width="2.3" stroke-linecap="round"/>`;
    }).join("")}
  </svg>`;

/** A mini area+line sparkline over a 120x40 viewBox, scaled to the series' own range. */
const spark = (values, { down = false } = {}) => {
  const max = Math.max(...values) * 1.08;
  const min = Math.min(...values) * 0.9;
  const pt = (v, i) => [
    ((i / (values.length - 1)) * 120).toFixed(1),
    (36 - ((v - min) / (max - min || 1)) * 30).toFixed(1)
  ];
  const line = values.map((v, i) => pt(v, i).join(",")).join(" ");
  const col = down ? "var(--ok)" : "var(--accent)";
  return `
    <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
      <polygon points="0,40 ${line} 120,40" fill="${col}" opacity=".14"/>
      <polyline points="${line}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" vector-effect="non-scaling-stroke"/>
    </svg>`;
};

/** A mini histogram over a 120x40 viewBox. */
const histogram = (values) => {
  const max = Math.max(...values);
  const w = 120 / values.length;
  return `
    <svg viewBox="0 0 120 40" preserveAspectRatio="none" aria-hidden="true">
      ${values
        .map((v, i) => {
          const h = (v / max) * 34;
          return `<rect x="${(i * w + 1).toFixed(1)}" y="${(38 - h).toFixed(1)}" width="${(w - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="1" fill="var(--accent)" opacity="${0.35 + (v / max) * 0.55}"/>`;
        })
        .join("")}
    </svg>`;
};

/** A donut showing one percentage of a whole. */
const donut = (pct) => {
  const c = 2 * Math.PI * 15.5;
  return `
    <svg viewBox="0 0 40 40" aria-hidden="true">
      <circle cx="20" cy="20" r="15.5" fill="none" stroke="var(--line-2)" stroke-width="6"/>
      <circle cx="20" cy="20" r="15.5" fill="none" stroke="var(--accent)" stroke-width="6" stroke-linecap="round"
        stroke-dasharray="${((pct / 100) * c).toFixed(1)} ${c.toFixed(1)}" transform="rotate(-90 20 20)"/>
    </svg>`;
};

/** Horizontal cost bars — the shape the console's CostBarChart uses. */
const costBars = (rows) => {
  const max = Math.max(...rows.map((r) => r.v));
  return `<div class="cbars">${rows
    .map(
      (r) => `<div class="cbar"><span class="l">${r.l}</span>
        <span class="t"><span style="width:${((r.v / max) * 100).toFixed(0)}%"></span></span>
        <span class="v">$${r.v}</span></div>`
    )
    .join("")}</div>`;
};

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
  .exit{position:fixed;top:18px;right:22px;z-index:50;font-size:12.5px;font-weight:600;color:var(--ink);
    background:rgba(255,255,255,.7);backdrop-filter:blur(6px);border:1px solid var(--line);border-radius:99px;
    padding:7px 13px;text-decoration:none;}
  .exit:hover{background:#fff;border-color:var(--line-2);}

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

  /* circular loop diagram */
  .loop{position:relative;width:min(412px,43vh);aspect-ratio:1;margin:clamp(52px,8vh,78px) auto clamp(20px,4vh,40px);}
  .loop svg{position:absolute;inset:0;width:100%;height:100%;overflow:visible;}
  .loop .nd{position:absolute;transform:translate(-50%,-50%);width:min(196px,25vw);text-align:center;
    background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.15);border-radius:14px;padding:12px 12px;backdrop-filter:blur(2px);}
  .loop .nd .ic{font-size:22px;line-height:1;}
  .loop .nd b{display:block;font-size:clamp(14px,1.5vw,17px);margin:6px 0 3px;color:#eef2ec;}
  .loop .nd small{font-size:clamp(11px,1.15vw,12.5px);color:#aebcb4;line-height:1.35;display:block;}
  .loop .nd--n{top:5%;left:50%;} .loop .nd--e{top:50%;left:95%;}
  .loop .nd--s{top:95%;left:50%;} .loop .nd--w{top:50%;left:5%;}
  .loop .hub{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);text-align:center;width:150px;}
  .loop .hub img{width:44px;height:44px;border-radius:11px;}
  .loop .hub b{display:block;font-size:13.5px;color:#9fd3e2;font-weight:700;margin-top:8px;line-height:1.3;}

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
  .mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:13px;background:#0f1714;color:#cfe6dd;
    padding:3px 7px;border-radius:6px;}

  .badge{display:inline-block;font-size:11px;font-weight:700;letter-spacing:.04em;padding:3px 9px;border-radius:99px;}
  .badge.hi{background:rgba(61,107,67,.25);color:#9fd9a6;}
  .badge.lo{background:rgba(154,58,45,.3);color:#e8917f;}
  .live{display:inline-flex;align-items:center;gap:8px;font-size:13px;font-weight:600;color:#e8917f;}
  .live .dot{width:9px;height:9px;border-radius:50%;background:#e8917f;animation:pulse 1.4s infinite;}
  @keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}

  /* Claude Desktop window (slides 10 & 13) */
  .cwin{margin-top:clamp(14px,2vh,24px);border-radius:14px;overflow:hidden;background:#faf9f5;
    border:1px solid rgba(255,255,255,.16);box-shadow:0 34px 64px -34px rgba(0,0,0,.8);}
  .cwin__bar{display:flex;align-items:center;gap:8px;padding:9px 14px;background:#f0eee6;border-bottom:1px solid #e4e0d4;}
  .cwin__bar .d{width:10px;height:10px;border-radius:50%;background:#d8d3c5;}
  .cwin__bar .t{flex:1;text-align:center;margin-right:46px;font-size:12px;color:#8b8578;}
  .cwin__body{display:grid;grid-template-columns:clamp(150px,15vw,196px) 1fr;}
  .cwin__side{background:#f0eee6;border-right:1px solid #e4e0d4;padding:14px 12px;display:flex;flex-direction:column;gap:9px;}
  .cwin__brand{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:600;color:#2f2c26;margin-bottom:2px;}
  .cwin__new{display:flex;align-items:center;gap:7px;font-size:12.5px;font-weight:600;color:#c2552d;}
  .cwin__lbl{font-size:10.5px;text-transform:uppercase;letter-spacing:.09em;color:#9a9487;margin-top:6px;}
  .cwin__side .it{font-size:12.5px;color:#57534a;padding:5px 8px;border-radius:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
  .cwin__side .it.on{background:#e4e0d4;color:#2f2c26;font-weight:600;}
  .cwin__conn{margin-top:auto;display:flex;align-items:center;gap:7px;font-family:ui-monospace,monospace;font-size:11px;
    color:#6f6a5e;border-top:1px solid #e4e0d4;padding-top:10px;}
  .cwin__conn .on{width:7px;height:7px;border-radius:50%;background:#3d8a52;flex:none;}
  .cwin__chat{padding:clamp(16px,2vw,24px) clamp(18px,2.4vw,30px);display:flex;flex-direction:column;gap:clamp(10px,1.4vh,16px);}
  .cmark{color:#d97757;flex:none;}
  .cmsg.user{align-self:flex-end;max-width:82%;background:#f0eee6;border:1px solid #e4e0d4;border-radius:14px;
    padding:9px 14px;color:#2f2c26;font-size:clamp(13px,1.45vw,17px);line-height:1.45;}
  .cmsg.bot{display:grid;grid-template-columns:auto 1fr;gap:11px;align-items:start;}
  .ctool{display:inline-flex;align-items:center;gap:9px;align-self:flex-start;background:#fff;border:1px solid #e4e0d4;
    border-radius:9px;padding:6px 11px;font-family:ui-monospace,monospace;font-size:12px;color:#6f6a5e;margin-left:29px;}
  .ctool .nm{color:#2f2c26;font-weight:600;}
  .ctool .chev{color:#a8a294;}
  .cans{color:#2f2c26;font-size:clamp(13px,1.45vw,17px);line-height:1.55;}
  .cans .hd{display:flex;align-items:center;gap:9px;margin-bottom:5px;}
  .cans .hd .who{font-size:12px;font-weight:700;letter-spacing:.03em;color:#8b8578;text-transform:uppercase;}
  .ccites{margin-top:10px;display:grid;gap:6px;}
  .ccite{display:flex;gap:8px;align-items:baseline;font-size:12.5px;color:#6f6a5e;}
  .ccite .pth{font-family:ui-monospace,monospace;color:#285f74;}
  .cwin .badge.hi{background:#dfeddd;color:#2e6b3a;}
  .cwin .badge.lo{background:#f7e1da;color:#a5401f;}
  .cwin .live{color:#a5401f;margin-top:9px;}
  .cwin .live .dot{background:#a5401f;}
  .ccomp{display:flex;align-items:center;gap:10px;margin-top:clamp(6px,1.2vh,14px);background:#fff;border:1px solid #e4e0d4;
    border-radius:12px;padding:10px 12px;font-size:13px;color:#a8a294;}
  .ccomp .send{margin-left:auto;width:24px;height:24px;border-radius:50%;background:#d97757;color:#fff;
    display:grid;place-items:center;font-size:12px;line-height:1;}

  /* the same window again, in a narrower column (slide 13) */
  .cwin--slim{margin-top:0;}
  .cwin--slim .cwin__body{grid-template-columns:clamp(112px,11vw,148px) 1fr;}
  .cwin--slim .cwin__chat{padding:clamp(14px,1.6vw,20px) clamp(15px,1.8vw,22px);}
  .cwin--slim .cmsg.user{max-width:90%;}
  .ccite .new{margin-left:2px;padding:1px 7px;border-radius:99px;background:#dfeddd;color:#2e6b3a;
    font-size:10.5px;font-weight:700;letter-spacing:.03em;}

  /* insights (slide 14): the journey chart, unframed, over a row of small charts */
  .dash{display:block;width:100%;max-height:clamp(240px,42vh,420px);object-fit:contain;margin:0 auto;}
  .minis{display:grid;grid-template-columns:repeat(4,1fr);gap:clamp(10px,1.2vw,18px);margin-top:clamp(10px,1.6vh,18px);}
  .mini{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:clamp(10px,1.1vw,15px);}
  .mini .hd{display:flex;align-items:baseline;justify-content:space-between;gap:8px;}
  .mini .hd b{font-size:clamp(11.5px,1.2vw,14.5px);letter-spacing:-.005em;}
  .mini .hd .v{font-size:clamp(14px,1.5vw,19px);font-weight:700;color:var(--accent);white-space:nowrap;}
  .mini .q{font-size:clamp(10px,1.05vw,12px);color:var(--muted);margin:3px 0 9px;line-height:1.35;}
  .mini .ft{margin-top:7px;font-size:clamp(9.5px,1vw,11.5px);color:var(--muted);}
  .mini svg{display:block;width:100%;height:clamp(32px,4.4vh,46px);}
  .mini .ring{display:flex;align-items:center;gap:10px;}
  .mini .ring svg{width:clamp(38px,4.4vw,52px);height:clamp(38px,4.4vw,52px);flex:none;}
  .mini .ring .k{font-size:clamp(10px,1.05vw,12px);color:var(--muted);line-height:1.35;}
  .cbars{display:grid;gap:5px;}
  .cbar{display:grid;grid-template-columns:auto 1fr auto;align-items:center;gap:7px;
    font-size:clamp(9px,.95vw,11px);color:var(--muted);}
  .cbar .l{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;}
  .cbar .t{height:7px;border-radius:99px;background:var(--wash);overflow:hidden;}
  .cbar .t span{display:block;height:100%;border-radius:99px;background:var(--accent);}
  .cbar .v{font-weight:600;color:var(--ink);}

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
  .demoduo--trio{grid-template-columns:1fr .8fr 1fr;gap:clamp(14px,1.9vw,28px);}

  /* the sources that feed a draft (slide 11) */
  .srcs{background:var(--paper);border:1px solid var(--line);border-radius:12px;padding:clamp(14px,1.5vw,20px);
    display:grid;gap:clamp(9px,1.1vh,13px);box-shadow:0 30px 60px -40px rgba(23,33,29,.5);}
  .src{display:grid;grid-template-columns:auto 1fr;gap:10px;align-items:start;}
  .src .k{flex:none;width:62px;text-align:center;padding:3px 0;border-radius:6px;background:var(--accent-soft);
    color:var(--accent);font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:10.5px;font-weight:600;line-height:1.5;}
  .src b{display:block;font-size:clamp(12.5px,1.25vw,14.5px);color:var(--ink);line-height:1.35;}
  .src span.d{display:block;margin-top:2px;font-size:clamp(11px,1.1vw,12.5px);color:var(--muted);line-height:1.4;}
  .srcs__out{border-top:1px dashed var(--line-2);padding-top:10px;font-size:clamp(11.5px,1.15vw,13px);
    color:var(--accent);font-weight:600;line-height:1.4;}

  .pillars{display:grid;grid-template-columns:repeat(2,1fr);gap:18px;}
  .pillar{display:flex;gap:14px;background:var(--paper);border:1px solid var(--line);border-radius:14px;padding:22px;}
  .pillar .ic{flex:0 0 auto;width:44px;height:44px;border-radius:11px;background:var(--accent-soft);color:var(--accent);display:grid;place-items:center;font-size:22px;}
  .pillar h3{margin:0 0 5px;font-size:19px;} .pillar p{margin:0;color:var(--muted);font-size:14.5px;line-height:1.5;}

  .footnote{margin-top:22px;font-size:13px;color:var(--muted);}
  .ink .footnote{color:#8aa094;}

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
        <div class="card"><div class="ic">♻️</div><h3>Won't <span class="neg">rot</span></h3><p>It finds its own gaps, drafts fixes, raises PRs. Scheduled maintenance patrols de-dupe, split &amp; verify — flagging contradictions.</p><span class="chip">self-improves · self-prunes</span></div>
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
          <li><span class="b">4</span><div><b>Follow-ups keep the thread</b> <span>— multi-turn conversation carries the context and its citations forward.</span></div></li>
          <li><span class="b">5</span><div><b>When the sources disagree, it says so</b> <span>— a disputed fact is flagged, never quietly resolved to one side.</span></div></li>
        </ul>
        <p class="footnote">Ask something it can't support and you get an honest "not enough here" — which becomes a tracked gap (see "won't rot").</p>
      </div>
      ${frame(A("ask"), { label: "localhost:3000 — Ask · cited answer", pos: "top" })}
    </div>
  </section>

  <!-- 6 SOURCE CONFLICTS -->
  <section class="slide light" data-title="When sources disagree">
    <div class="wrap split rev">
      ${frame(A("conflicts"), { label: "localhost:3000 \u2014 Knowledge \u00b7 source conflicts", pos: "top" })}
      <div>
        <div class="kicker">Won't lie \u00b7 the hard case</div>
        <h2>Two sources, two answers. Neither gets to win quietly.</h2>
        <ul class="feat">
          <li><span class="b">\u2713</span><div><b>It spots the disagreement</b> <span>— the policy says one year, the code enforces sixty days. Both look authoritative.</span></div></li>
          <li><span class="b">\u2713</span><div><b>It refuses to adjudicate</b> <span>— picking a side would bury a real problem inside a confident answer.</span></div></li>
          <li><span class="b">\u2713</span><div><b>The document stops asserting it</b> <span>— the disputed claim is annotated and held out of corrective rewrites.</span></div></li>
          <li><span class="b">\u2713</span><div><b>It closes itself</b> <span>— fix the disagreement in the sources and the conflict resolves, the document repairs.</span></div></li>
        </ul>
        <p class="footnote">The failure a knowledge base can't afford isn't a missing answer — it's a confident one built on a contradiction nobody noticed.</p>
      </div>
    </div>
  </section>

  <!-- 7 WON'T LEAK -->
  <section class="slide light" data-title="Won't leak">
    <div class="wrap split rev">
      ${frame(A("proposals"), { label: "localhost:3000 — Proposals · human review", pos: "top" })}
      <div>
        <div class="kicker">Won't leak</div>
        <h2>The raw material stays behind the wall.</h2>
        <ul class="feat">
          <li><span class="b">✓</span><div><b>Users never touch the source</b> <span>— no code, internal docs or restricted folders. Just the curated answer.</span></div></li>
          <li><span class="b">✓</span><div><b>Every change is a reviewed PR</b> <span>— an admin approves it, exactly like a code review, before it ships.</span></div></li>
          <li><span class="b">✓</span><div><b>Hardened against injection</b> <span>— untrusted source text is delimited before the model sees it, and MCP tokens are scoped per tool.</span></div></li>
          <li><span class="b">✓</span><div><b>Full audit &amp; history</b> <span>— diffable, reversible, attributable. It's just Git.</span></div></li>
        </ul>
        <p class="footnote">This is what makes it safe to point at sensitive corpora that you could never hand to a generic chatbot.</p>
      </div>
    </div>
  </section>

  <!-- 8 WON'T ROT -->
  <section class="slide light" data-title="Won't rot">
    <div class="wrap split">
      <div>
        <div class="kicker">Won't rot</div>
        <h2>It maintains itself.</h2>
        <ul class="feat">
          <li><span class="b">①</span><div><b>Detects its own gaps</b> <span>— clusters low-confidence answers &amp; unhelpful feedback into themes.</span></div></li>
          <li><span class="b">②</span><div><b>Drafts grounded fixes</b> <span>— writes proposed Markdown with evidence &amp; a rationale, ready for review.</span></div></li>
          <li><span class="b">③</span><div><b>Maintenance patrols prune</b> <span>— scheduled fix &amp; improve patrols de-dupe, split &amp; verify docs, flagging contradictions &amp; stale content.</span></div></li>
          <li><span class="b">④</span><div><b>Every change is on the record</b> <span>— what changed, when, and what caused it: a sync, a gap, a seed plan or a patrol.</span></div></li>
        </ul>
        <p class="footnote"><b>Usage is the maintenance signal.</b> The more it's asked, the faster it finds and fills its own weak spots.</p>
      </div>
      ${frame(A("gaps"), { label: "localhost:3000 — Gaps · weak answers → proposals", pos: "top" })}
    </div>
  </section>

  <!-- 9 KNOWLEDGE CHANGE LOG -->
  <section class="slide light" data-title="What changed">
    <div class="wrap split rev">
      ${frame(A("changes"), { label: "localhost:3000 \u2014 Knowledge \u00b7 recent changes", pos: "top" })}
      <div>
        <div class="kicker">Won't rot \u00b7 the receipts</div>
        <h2>It can tell you what changed \u2014 and why.</h2>
        <ul class="feat">
          <li><span class="b">\u2713</span><div><b>\u201cWhat's new this week?\u201d</b> <span>\u2014 an append-only log of every section added, changed or removed. A time filter, not a similarity search.</span></div></li>
          <li><span class="b">\u2713</span><div><b>Every entry has a cause</b> <span>\u2014 a source sync, a gap cluster, a seed plan, a patrol \u2014 or a human editing the repo directly.</span></div></li>
          <li><span class="b">\u2713</span><div><b>Answers know it too</b> <span>\u2014 \u201cwhen did this change?\u201d is answerable, because each cited section carries its change context.</span></div></li>
        </ul>
        <p class="footnote">In the console, or over MCP as <span class="mono">kb_changes</span> \u2014 so an agent can brief you on what moved since Monday.</p>
      </div>
    </div>
  </section>

  <!-- 10 DEMO: FROM INSIDE CLAUDE -->
  <section class="slide ink" data-title="Demo · in Claude">
    <div class="wrap">
      <div class="kicker">Demo · part 1 — in Claude</div>
      <h2 style="margin:.1em 0 0">It meets people where they already work.</h2>
      <div class="cwin">
        <div class="cwin__bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="t">Claude</span></div>
        <div class="cwin__body">
          <aside class="cwin__side">
            <div class="cwin__brand">${claudeMark(17)} Claude</div>
            <div class="cwin__new">＋ New chat</div>
            <div class="cwin__lbl">Recents</div>
            <div class="it on">Sales KB — answer guarantees</div>
            <div class="it">Q3 security questionnaire</div>
            <div class="it">Renewal deck notes</div>
            <div class="cwin__conn"><span class="on"></span>markdown-magpie</div>
          </aside>
          <main class="cwin__chat">
            <div class="cmsg user">What guarantees does Markdown Magpie make about its answers?</div>
            <div class="ctool">${claudeMark(13)}<span class="nm">kb_ask</span>flow: magpie-sales<span class="chev">›</span></div>
            <div class="cmsg bot">
              ${claudeMark(19)}
              <div class="cans">
                <div class="hd"><span class="who">Claude</span><span class="badge hi">HIGH</span></div>
                It grounds every response in indexed Markdown — citations to the exact file, heading &amp; commit, a scored confidence, and it flags a gap rather than guessing.
                <div class="ccites">
                  <div class="ccite"><span class="pth">…-internal-knowledge-base-obje.md</span> › Won't Lie (Grounded Answers)</div>
                  <div class="ccite"><span class="pth">competitive-landscape-differentiation.md</span> › Summary</div>
                </div>
              </div>
            </div>
            <div class="cmsg user">Does Markdown Magpie support single sign-on (SSO / SAML)?</div>
            <div class="ctool">${claudeMark(13)}<span class="nm">kb_ask</span>flow: magpie-sales<span class="chev">›</span></div>
            <div class="cmsg bot">
              ${claudeMark(19)}
              <div class="cans">
                <div class="hd"><span class="who">Claude</span><span class="badge lo">LOW</span></div>
                The knowledge base doesn't cover how sign-in or SSO works yet — so it abstains and logs a gap rather than guessing.
                <div class="live"><span class="dot"></span>knowledge gap logged</div>
              </div>
            </div>
            <div class="ccomp">Reply to Claude…<span class="send">↑</span></div>
          </main>
        </div>
      </div>
      <p class="footnote">Same engine, exposed as MCP tools (<span class="mono">kb_ask</span>, <span class="mono">kb_search</span>, <span class="mono">kb_citation</span>, <span class="mono">kb_changes</span>, <span class="mono">kb_flows</span>, <span class="mono">kb_questionnaire_*</span>) over a hosted OAuth endpoint — installable in Claude Code as a one-command plugin that ships the tools <i>and</i> the skills for using them. The knowledge shows up in Claude, Codex, or any agent, and every weak answer feeds back as a gap.</p>
    </div>
  </section>

  <!-- 11 DEMO: BACKSTAGE · DETECT & DRAFT -->
  <section class="slide light" data-title="Demo · detect & draft">
    <div class="wrap">
      <div class="kicker">Demo · part 2 — backstage</div>
      <h2>That gap becomes a reviewed improvement.</h2>
      <div class="demoduo demoduo--trio">
        <figure>
          <figcaption><span class="n">1</span><span><b>Cluster the gap</b> — the SSO questions group into one theme.</span></figcaption>
          ${frame(A("demo-cluster"), { auto: true, label: "localhost:3000 — Gaps · authentication cluster" })}
        </figure>
        <figure>
          <figcaption><span class="n">2</span><span><b>Read the sources</b> — the answer is assembled, not invented.</span></figcaption>
          <div class="srcs">
            <div class="src"><span class="k">git</span><div><b>magpie · src/auth</b><span class="d">The code itself — Auth0 wiring, the SAML callback routes.</span></div></div>
            <div class="src"><span class="k">local</span><div><b>knowledge-bases/deployment</b><span class="d">An on-disk folder — tenancy &amp; console-access notes.</span></div></div>
            <div class="src"><span class="k">internet</span><div><b>auth0.com/docs</b><span class="d">Fetched live — but only from allow-listed hosts.</span></div></div>
            <div class="src"><span class="k">agent</span><div><b>The model's own knowledge</b><span class="d">How SAML &amp; SCIM work in general.</span></div></div>
            <div class="srcs__out">↓ Every claim in the draft cites where it came from.</div>
          </div>
        </figure>
        <figure>
          <figcaption><span class="n">3</span><span><b>Draft a fix</b> — a grounded SSO page, with a rationale.</span></figcaption>
          ${frame(A("demo-draft"), { auto: true, label: "localhost:3000 — Proposals · drafted fix" })}
        </figure>
      </div>
      <p class="footnote">Sources are read <b>at draft time</b> and never indexed as the answer corpus — the KB <i>describes</i> your systems, it isn't a copy of them. One gap can pull from a repo, a folder, an approved doc site and the model at once; you never start from a blank page.</p>
    </div>
  </section>

  <!-- 12 DEMO: BACKSTAGE · REVIEW & SHIP -->
  <section class="slide light" data-title="Demo · review & ship">
    <div class="wrap">
      <div class="kicker">Demo · part 2 — backstage</div>
      <h2>Reviewed like code, then merged in.</h2>
      <div class="demoduo">
        <figure>
          <figcaption><span class="n">4</span><span><b>Raise a PR</b> — the fix is a reviewable pull request.</span></figcaption>
          ${frame(A("demo-pr"), { auto: true, label: "github.com — Pull request #142" })}
        </figure>
        <figure>
          <figcaption><span class="n">5</span><span><b>Merge &amp; re-index</b> — approved, merged, gaps resolved.</span></figcaption>
          ${frame(A("demo-merged"), { auto: true, label: "localhost:3000 — Proposals · merged & re-indexed" })}
        </figure>
      </div>
      <p class="footnote">Every change is a Git PR an admin approves — diffable, reversible, attributable. The raw source never leaves the wall.</p>
    </div>
  </section>

  <!-- 13 DEMO: THE PAYOFF -->
  <section class="slide ink" data-title="Demo · the payoff">
    <div class="wrap split">
      <div>
        <div class="kicker">Demo · part 3 — the payoff</div>
        <h2>Ask again — now it knows.</h2>
        <ul class="feat">
          <li><span class="b">✓</span><div><b>The same question that drew a blank</b> <span>now returns a complete, grounded answer.</span></div></li>
          <li><span class="b">✓</span><div><b>No one sat down and wrote that page</b> <span>— the loop drafted it from real usage.</span></div></li>
          <li><span class="b">✓</span><div><b>It still went through review</b> <span>before it ever shipped to a user.</span></div></li>
        </ul>
        <p class="footnote">One thread, end to end — the SSO gap from part 1, filled by the loop and reviewed before it shipped.</p>
      </div>
      <div class="cwin cwin--slim">
        <div class="cwin__bar"><span class="d"></span><span class="d"></span><span class="d"></span><span class="t">Claude</span></div>
        <div class="cwin__body">
          <aside class="cwin__side">
            <div class="cwin__brand">${claudeMark(17)} Claude</div>
            <div class="cwin__new">＋ New chat</div>
            <div class="cwin__lbl">Recents</div>
            <div class="it on">Sales KB — answer guarantees</div>
            <div class="it">Q3 security questionnaire</div>
            <div class="cwin__conn"><span class="on"></span>markdown-magpie</div>
          </aside>
          <main class="cwin__chat">
            <div class="cmsg user">Does Markdown Magpie support single sign-on (SSO / SAML)?</div>
            <div class="ctool">${claudeMark(13)}<span class="nm">kb_ask</span>flow: magpie-sales<span class="chev">›</span></div>
            <div class="cmsg bot">
              ${claudeMark(19)}
              <div class="cans">
                <div class="hd"><span class="who">Claude</span><span class="badge hi">HIGH</span></div>
                <b>Yes.</b> Magpie signs in through Auth0, so it works with any OIDC provider — Google, Microsoft Entra, Okta and more — and <b>SAML single sign-on</b> with SCIM provisioning is supported. Console access can be locked to your own identity provider.
                <div class="ccites">
                  <div class="ccite"><span class="pth">magpie-sales/authentication-and-sso.md</span> › Sign-in <span class="new">NEW</span></div>
                </div>
              </div>
            </div>
            <div class="ccomp">Reply to Claude…<span class="send">↑</span></div>
          </main>
        </div>
      </div>
    </div>
  </section>

  <!-- 14 INSIGHTS -->
  <section class="slide light" data-title="Insights">
    <div class="wrap">
      <div class="kicker">Insights · prove it's working</div>
      <h2 style="margin:0 0 .35em">Watch the whole pipeline — and what it costs.</h2>
      <img class="dash" src="${A("insights")}" alt="Question journey Sankey — where question volume flows and leaks between confidence, answers, gaps, proposals and verified closures"/>
      <div class="minis">
        <div class="mini">
          <div class="hd"><b>Open-gap backlog</b><span class="v">34</span></div>
          <div class="q">Is knowledge debt growing or shrinking?</div>
          ${spark([58, 55, 57, 50, 47, 48, 41, 38, 36, 34], { down: true })}
          <div class="ft">▼ 41% over 30 days</div>
        </div>
        <div class="mini">
          <div class="hd"><b>Verification</b><span class="v">64%</span></div>
          <div class="q">Do merged fixes actually close the gap?</div>
          <div class="ring">${donut(64)}<span class="k">Re-asked after merge and answered with confidence.</span></div>
          <div class="ft">40 of 63 merged proposals</div>
        </div>
        <div class="mini">
          <div class="hd"><b>Answer latency</b><span class="v">4.2s</span></div>
          <div class="q">How long does an answer take, end to end?</div>
          ${histogram([3, 9, 17, 12, 6, 3, 1])}
          <div class="ft">median · p95 11.8s</div>
        </div>
        <div class="mini">
          <div class="hd"><b>AI spend · 30d</b><span class="v">$38</span></div>
          <div class="q">What is each job type costing?</div>
          ${costBars([
            { l: "answer", v: 18 },
            { l: "draft", v: 13 },
            { l: "patrol", v: 7 }
          ])}
          <div class="ft">$0.03 per answered question</div>
        </div>
      </div>
      <p class="footnote">Eleven charts, each answering one operator question — is the backlog growing, is the queue keeping up, what's breaking, how stale is the KB, what's it costing. You don't take the loop on faith; you watch it work.</p>
    </div>
  </section>

  <!-- 15 HOW TO GET RUNNING -->
  <section class="slide ink" data-title="How to get running">
    <div class="wrap">
      <div class="kicker">How to get running · and how to leave</div>
      <h2>Point it at your data. Keep the files.</h2>
      <div class="cards" style="margin-top:26px">
        <div class="card"><div class="ic">🎯</div><h3>Point it at the data</h3><p>Name a source — the repos, folders or allow-listed doc sites to learn from — and a destination repo for the curated knowledge base. That's the setup.</p><span class="chip">two repos, a few lines</span></div>
        <div class="card"><div class="ic">🌱</div><h3>It populates a KB</h3><p>No questions yet, no topic needed: Seed explores the sources and proposes a plan — a charter plus a page per topic. You approve it, every page is drafted as a PR, and the loop takes over.</p><span class="chip">you approve the plan</span></div>
        <div class="card"><div class="ic">📄</div><h3>You're left with files</h3><p>Plain Markdown in your own Git repo, with the full history. Switch Magpie off tomorrow and you keep everything it wrote — there's nothing to migrate out of.</p><span class="chip">nothing to migrate</span></div>
      </div>
      <p class="footnote">No lock-in anywhere else either: self-hosted on your own infrastructure (API, watcher and Postgres, up with one Compose file — nothing leaves your network unless you send it), chat providers swappable per flow, and embeddings optional — keyword-only retrieval is a first-class mode.</p>
    </div>
  </section>

  <!-- 16 THE LOOP -->
  <section class="slide ink" data-title="The loop">
    <div class="wrap" style="text-align:center">
      <div class="kicker">The whole thing, in one loop</div>
      <h2 style="margin:0 0 .1em">It gets smarter every time it's asked.</h2>
      <div class="loop">
        <svg viewBox="0 0 100 100" aria-hidden="true">
          <circle cx="50" cy="50" r="45" fill="none" stroke="var(--accent-2)" stroke-width="0.7" stroke-opacity="0.55" stroke-dasharray="1.4 3"/>
          <g fill="var(--accent-2)">
            <g transform="translate(81.8,18.2) rotate(45)"><path d="M-3,-3.3 L3.6,0 L-3,3.3 Z"/></g>
            <g transform="translate(81.8,81.8) rotate(135)"><path d="M-3,-3.3 L3.6,0 L-3,3.3 Z"/></g>
            <g transform="translate(18.2,81.8) rotate(225)"><path d="M-3,-3.3 L3.6,0 L-3,3.3 Z"/></g>
            <g transform="translate(18.2,18.2) rotate(315)"><path d="M-3,-3.3 L3.6,0 L-3,3.3 Z"/></g>
          </g>
        </svg>
        <div class="nd nd--n"><div class="ic">💬</div><b>Ask</b><small>In the app — or in Claude, Codex &amp; co. over MCP.</small></div>
        <div class="nd nd--e"><div class="ic">⚖️</div><b>Cited answer</b><small>Grounded in your sources, with a confidence score.</small></div>
        <div class="nd nd--s"><div class="ic">🔍</div><b>Gap surfaces</b><small>Low-confidence &amp; unhelpful answers become tracked gaps.</small></div>
        <div class="nd nd--w"><div class="ic">♻️</div><b>Improve</b><small>Cluster → draft → review → merge → re-index.</small></div>
        <div class="hub"><img src="${A("icon")}" alt=""/><b>smarter<br/>every ask</b></div>
      </div>
    </div>
  </section>

  <!-- 17 WIDE APPLICATIONS -->
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
      <p class="footnote">Each gets its own curated layer and its own reviewer — same loop, different source. Next: one of these rows, in depth.</p>
    </div>
  </section>

  <!-- 18 QUESTIONNAIRES -->
  <section class="slide light" data-title="One application · questionnaires">
    <div class="wrap split rev">
      ${frame(A("questionnaires"), { tall: true, label: "localhost:3000 — Questionnaires · security review", pos: "top" })}
      <div>
        <div class="kicker">One application, in depth</div>
        <h2>Take one row of that table: security questionnaires.</h2>
        <ul class="feat">
          <li><span class="b">1</span><div><b>Upload the actual file</b> <span>— drop in the vendor's XLSX or CSV; confirm which column is the question and which holds their answer.</span></div></li>
          <li><span class="b">2</span><div><b>Reuse, and re-check</b> <span>— prior approved answers return instantly; when a cited source moved, it re-answers and says why.</span></div></li>
          <li><span class="b">3</span><div><b>Audit what you sent last time</b> <span>— a completed questionnaire imports as <i>evidence</i>, graded against the KB: confirmed, contradicted or unsupported.</span></div></li>
          <li><span class="b">✓</span><div><b>Approve &amp; export</b> <span>— sign answers into the reuse corpus, export to Markdown or CSV.</span></div></li>
        </ul>
        <p class="footnote">Nothing here is a second product: it's the same grounded, cited engine pointed at a whole worksheet instead of one question. (An imported answer is untrusted input — never cited, never allowed to change what Magpie says.)</p>
      </div>
    </div>
  </section>


</div>

<a class="exit" href="/">Back to login</a>
<div class="hud"><span id="counter">1 / 18</span> · <b id="hud-title">Title</b></div>
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
const webPresentationDir = join(ROOT, "apps/web/public/presentation");
mkdirSync(webPresentationDir, { recursive: true });
writeFileSync(join(webPresentationDir, "index.html"), HTML);
const kb = Math.round(Buffer.byteLength(HTML) / 1024);
console.log(
  `Wrote presentation/index.html and apps/web/public/presentation/index.html (${kb} KB, ${slides_count(HTML)} slides)`
);
function slides_count(h) {
  return (h.match(/class="slide /g) || []).length;
}
