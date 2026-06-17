import { chromium } from "playwright";

const BASE = "http://localhost:3000";
const OUT = "presentation/assets";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

async function tab(name) {
  await page.getByRole("button", { name, exact: false }).first().click();
  await page.waitForTimeout(900);
}

await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// 1) ASK — high-confidence cited answer (slide: won't lie)
await page.getByRole("textbox").first().fill("What external dependencies does the core flowerbi package have?");
await page.getByRole("button", { name: "Ask", exact: true }).click();
// wait for the cited answer to render
await page.waitForFunction(() => /confiden|citation/i.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
await page.screenshot({ path: `${OUT}/02-ask-cited.png`, fullPage: true });
console.log("saved 02-ask-cited.png");

// 2) GAPS (slide: won't rot)
await tab("Gaps");
await page.screenshot({ path: `${OUT}/03-gaps.png`, fullPage: true });
console.log("saved 03-gaps.png");

// 3) PROPOSALS — drafted change awaiting review (slide: won't leak / won't rot)
await tab("Proposals");
await page.waitForTimeout(600);
// try to open the first proposal to show body + evidence + rationale
const firstProposal = page.locator("text=Contributing to FlowerBI").first();
if (await firstProposal.count()) { await firstProposal.click().catch(() => {}); await page.waitForTimeout(900); }
await page.screenshot({ path: `${OUT}/04-proposal.png`, fullPage: true });
console.log("saved 04-proposal.png");

// 4) KNOWLEDGE (slide: grounded / index)
await tab("Knowledge");
await page.screenshot({ path: `${OUT}/05-knowledge.png`, fullPage: true });
console.log("saved 05-knowledge.png");

// 5) DATA FLOW (architecture/flywheel)
await tab("Data Flow");
await page.waitForTimeout(1200);
await page.screenshot({ path: `${OUT}/06-dataflow.png`, fullPage: true });
console.log("saved 06-dataflow.png");

// 6) CONFIG (vendor-neutral providers — cheap & yours)
await tab("Config");
await page.screenshot({ path: `${OUT}/07-config.png`, fullPage: true });
console.log("saved 07-config.png");

await browser.close();
console.log("done");
