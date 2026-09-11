import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Users/jimmychung/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

await page.goto("http://localhost:5180", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 找一个已有多消息/分支的会话（从列表里逐个点开找有探索分支的）
const count = await page.locator(".session-row > button").count();
for (let i = 0; i < count; i++) {
  await page.locator(".session-row > button").nth(i).click();
  await page.waitForTimeout(800);
  const ghost = await page.locator(".ghost-card").count();
  const pathBtns = await page.locator(".path button").count();
  if (ghost > 0 || pathBtns > 1) {
    console.log(`会话 ${i}: ghost=${ghost}, pathBtns=${pathBtns} — 用这个`);
    break;
  }
}

// 当前是否在分支卡片上？点击路径中最后一个按钮确保在子卡片
const pathBtns = await page.locator(".path button").count();
if (pathBtns > 1) {
  await page.locator(".path button").last().click();
  await page.waitForTimeout(600);
}

const metrics = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: Math.round(r.width), left: Math.round(r.left), right: Math.round(r.right), scrollWidth: el.scrollWidth };
  };
  const ghosts = [...document.querySelectorAll(".ghost-card")].map((el) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), width: Math.round(r.width) };
  });
  return {
    innerWidth: window.innerWidth,
    docScrollWidth: document.documentElement.scrollWidth,
    sidebar: pick(".sidebar"),
    main: pick(".main"),
    foreground: pick(".foreground-card"),
    treePanel: pick(".tree-panel"),
    ghosts,
  };
});
console.log(JSON.stringify(metrics, null, 2));
await page.screenshot({ path: "/tmp/kk-explore.png" });
await browser.close();
