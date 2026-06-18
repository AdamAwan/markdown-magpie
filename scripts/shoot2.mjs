import { chromium } from "playwright";
const BASE = "http://localhost:3000";
const OUT = "presentation/assets";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });
await page.goto(BASE, { waitUntil: "networkidle" });
await page.waitForTimeout(1000);

// Clean cited-answer card crop
await page.getByRole("textbox").first().fill("What external dependencies does the core flowerbi package have?");
await page.getByRole("button", { name: "Ask", exact: true }).click();
await page.waitForFunction(() => /confiden|citation/i.test(document.body.innerText), null, { timeout: 60000 }).catch(() => {});
await page.waitForTimeout(1500);
// screenshot the answer region: find the element after the form
const card = page.locator("css=main, [class*=answer], section").filter({ hasText: /citation/i }).first();
if (await card.count()) { await card.screenshot({ path: `${OUT}/08-answer-card.png` }).catch(async () => { await page.screenshot({ path: `${OUT}/08-answer-card.png` }); }); }
else { await page.screenshot({ path: `${OUT}/08-answer-card.png` }); }
console.log("saved 08-answer-card.png");

// Continuous Improvement Cycle sub-tab of Data Flow
await page.getByRole("button", { name: "Data Flow", exact: false }).first().click();
await page.waitForTimeout(800);
const cyc = page.getByText("Continuous Improvement Cycle", { exact: false }).first();
if (await cyc.count()) { await cyc.click().catch(() => {}); await page.waitForTimeout(1200); }
await page.screenshot({ path: `${OUT}/09-improvement-cycle.png`, fullPage: true });
console.log("saved 09-improvement-cycle.png");

await browser.close();
console.log("done");
