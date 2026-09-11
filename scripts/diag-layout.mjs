import { chromium } from "playwright";

const browser = await chromium.launch({
  headless: true,
  executablePath: "/Users/jimmychung/Library/Caches/ms-playwright/chromium_headless_shell-1217/chrome-headless-shell-mac-arm64/chrome-headless-shell",
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
const errors = [];
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
page.on("pageerror", (e) => errors.push(String(e)));

await page.goto("http://localhost:5180", { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

// 找到第一个会话并进入
const sessions = await page.locator(".session-row > button").count();
console.log("sessions:", sessions);
if (sessions > 0) {
  await page.locator(".session-row > button").first().click();
  await page.waitForTimeout(1000);
}

// 发送一条会生成很长正文的问题
const ta = page.locator("textarea").first();
if (await ta.count()) {
  await ta.fill("请详细介绍一下中国历史，从夏商周到明清，每个朝代都展开讲，内容越长越好");
  await page.locator(".send-btn").click();
  await page.waitForTimeout(20000); // 等待流式生成一段
}

// 采集布局指标
const metrics = await page.evaluate(() => {
  const pick = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return {
      width: Math.round(r.width),
      scrollWidth: el.scrollWidth,
      left: Math.round(r.left),
      right: Math.round(r.right),
      overflow: st.overflow + "/" + st.overflowX,
      gridCols: st.gridTemplateColumns || null,
      minWidth: st.minWidth,
    };
  };
  return {
    innerWidth: window.innerWidth,
    scrollX: window.scrollX,
    scrollWidth: document.documentElement.scrollWidth,
    app: pick(".app"),
    sidebar: pick(".sidebar"),
    workspace: pick(".workspace"),
    wsMain: pick(".ws-main"),
    content: pick(".content"),
    main: pick(".main"),
    stack: pick(".stack"),
    foregroundCard: pick(".foreground-card"),
    cardMessages: pick(".card-messages"),
    msgAnswer: pick(".msg-answer"),
    treePanel: pick(".tree-panel"),
  };
});

console.log(JSON.stringify(metrics, null, 2));
console.log("console errors:", errors.slice(0, 5));

await page.screenshot({ path: "/tmp/kk-layout.png", fullPage: false });
await browser.close();
