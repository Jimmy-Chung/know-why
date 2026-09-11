import { chromium } from "playwright";

const executablePath = "/Users/jimmychung/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell";
const browser = await chromium.launch({ headless: true, executablePath });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const logs = [];
page.on("console", (m) => logs.push(`[console.${m.type()}] ${m.text()}`));
page.on("pageerror", (e) => logs.push(`[pageerror] ${e}`));

await page.goto("http://localhost:5180", { waitUntil: "networkidle" });
await page.waitForTimeout(1200);

// 进入第一个会话
const sessions = await page.locator(".session-row > button").count();
console.log("sessions:", sessions);
if (sessions > 0) {
  await page.locator(".session-row > button").first().click();
  await page.waitForTimeout(800);
}

// 打开助手（进入折叠态 tree-panel）
const openBtn = page.locator(".knowledge-btn");
if (await openBtn.count()) {
  await openBtn.first().click();
  await page.waitForTimeout(500);
}

const treeState = await page.evaluate(() => {
  const panel = document.querySelector(".tree-panel");
  if (!panel) return { found: false };
  const r = panel.getBoundingClientRect();
  const st = getComputedStyle(panel);
  const cls = panel.className;
  const view = panel.querySelector(".tree-view");
  const ghost = panel.querySelector(".tree-edge-ghost");
  return {
    found: true, cls, width: Math.round(r.width), left: Math.round(r.left),
    right: Math.round(r.right), position: st.position, top: st.top, bottom: st.bottom,
    hasView: !!view, hasGhost: !!ghost, viewWidth: view ? Math.round(view.getBoundingClientRect().width) : null,
  };
});
console.log("TREE BEFORE HOVER:", JSON.stringify(treeState, null, 2));

// 计算边缘条中心位置并 hover
const edgePoint = await page.evaluate(() => {
  const panel = document.querySelector(".tree-panel");
  if (!panel) return null;
  const r = panel.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
});
console.log("edge hover point:", edgePoint);

if (edgePoint) {
  // 移动并悬停
  await page.mouse.move(edgePoint.x, edgePoint.y);
  await page.waitForTimeout(400); // 覆盖 300ms 展开
  const after = await page.evaluate(() => {
    const panel = document.querySelector(".tree-panel");
    const r = panel.getBoundingClientRect();
    const st = getComputedStyle(panel);
    const view = panel.querySelector(".tree-view");
    const ghost = panel.querySelector(".tree-edge-ghost");
    return {
      cls: panel.className, width: Math.round(r.width),
      hasView: !!view, hasGhost: !!ghost,
      viewWidth: view ? Math.round(view.getBoundingClientRect().width) : null,
      ariaExpanded: panel.getAttribute("aria-expanded"),
    };
  });
  console.log("TREE AFTER HOVER(400ms):", JSON.stringify(after, null, 2));

  // 再等等观察是否停在展开态
  await page.waitForTimeout(1000);
  const after2 = await page.evaluate(() => {
    const panel = document.querySelector(".tree-panel");
    const r = panel.getBoundingClientRect();
    return { cls: panel.className, width: Math.round(r.width), hasView: !!panel.querySelector(".tree-view") };
  });
  console.log("TREE AFTER +1000ms:", JSON.stringify(after2));

  // 移出边缘，观察是否收起
  await page.mouse.move(500, 400);
  await page.waitForTimeout(600);
  const after3 = await page.evaluate(() => {
    const panel = document.querySelector(".tree-panel");
    const r = panel.getBoundingClientRect();
    return { cls: panel.className, width: Math.round(r.width), hasView: !!panel.querySelector(".tree-view") };
  });
  console.log("TREE AFTER MOVE OUT: ", JSON.stringify(after3));
}

console.log("LOGS:", logs.slice(0, 20));
await browser.close();
