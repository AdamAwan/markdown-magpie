import { chromium } from "playwright";
const url = "file://" + process.cwd() + "/presentation/index.html";
const OUT = "presentation/assets/_verify";
import { mkdirSync } from "node:fs";
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 810 }, deviceScaleFactor: 1.5 });
const want = process.argv.slice(2).map(Number);
const slides = want.length ? want : [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];
await page.goto(url, { waitUntil: "networkidle" });
for (const n of slides) {
  await page.evaluate((k) => {
    location.hash = "#" + k;
  }, n);
  await page.waitForTimeout(550);
  await page.screenshot({ path: `${OUT}/slide-${String(n).padStart(2, "0")}.png` });
}
console.log("captured", slides.join(","));
await browser.close();
