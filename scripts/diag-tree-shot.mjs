import { chromium } from "playwright";

const executablePath = "/Users/jimmychung/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto("http://localhost:5180", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);
await page.locator(".session-row > button").first().click();
await page.waitForTimeout(800);
await page.locator(".knowledge-btn").first().click();
await page.waitForTimeout(500);

// 截图折叠态
await page.screenshot({ path: "/tmp/kk-tree-collapsed.png", clip: { x: 900, y: 0, width: 400, height: 900 } });

// hover 边缘
const edgePoint = await page.evaluate(() => {
  const panel = document.querySelector(".tree-panel");
  const r = panel.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
await page.mouse.move(edgePoint.x, edgePoint.y);
await page.waitForTimeout(700); // 展开完成
await page.screenshot({ path: "/tmp/kk-tree-expanded.png", clip: { x: 820, y: 0, width: 520, height: 900 } });
// scroll 区域截图
await page.screenshot({ path: "/tmp/kk-tree-expanded-full.png" });

console.log("done");
await browser.close();
