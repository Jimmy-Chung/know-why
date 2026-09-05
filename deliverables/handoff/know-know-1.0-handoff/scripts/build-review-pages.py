"""Build static review pages from versioned Markdown. Requires markdown-it-py."""

from html import escape
from pathlib import Path

from markdown_it import MarkdownIt


ROOT = Path(__file__).resolve().parents[1]
VERSIONS = ROOT / "docs" / "versions"
PAGES = {
    "DEVELOPMENT_HANDOFF.md": ("handoff.html", "开发交接"),
    "INTERACTION_SPEC.md": ("interaction.html", "交互说明"),
    "PRODUCT_SPEC.md": ("product.html", "产品说明"),
    "TEST_SPEC.md": ("test.html", "测试说明"),
    "TECHNICAL_DESIGN.md": ("technical.html", "技术方案"),
}
STYLE = """
:root { color-scheme: light dark; --bg: light-dark(#f6f7f4,#171d1a); --text: light-dark(#273b32,#e1e9e3); --line: light-dark(#dfe5dd,#37433b); --accent: light-dark(#356750,#a2cbb2); }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text); font: 16px/1.8 -apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif; }
header { border-bottom: 1px solid var(--line); padding: 20px max(24px,calc((100% - 1100px)/2)); }
nav { display: flex; flex-wrap: wrap; gap: 10px 24px; margin-top: 8px; }
a { color: var(--accent); text-underline-offset: 4px; }
main { max-width: 1150px; padding: 32px 24px 80px; margin: auto; overflow-wrap: anywhere; }
h1,h2,h3 { line-height: 1.4; } h1 { font-size: 30px; } h2 { margin-top: 40px; font-size: 23px; }
table { width: 100%; border-collapse: collapse; font-size: 14px; margin: 24px 0; }
th,td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 12px 10px; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; padding: 20px; border: 1px solid var(--line); }
code { font-size: .9em; } li { margin-bottom: 8px; }
.notice { border-left: 3px solid var(--accent); padding-left: 16px; }
.entries { list-style: none; padding: 0; } .entries li { padding: 18px 0; border-bottom: 1px solid var(--line); }
@media (max-width: 600px) { main { padding: 20px 16px 50px; } h1 { font-size: 25px; } table { display: block; overflow-x: auto; } }
@media print { header { display: none; } body { color: #111; background: #fff; } main { max-width: none; } }
"""


def page(title, version, body):
    nav = '<a href="index.html">版本首页</a><a href="product.html">产品说明</a>'
    if version == "1.0":
        nav += '<a href="handoff.html">开发交接</a><a href="interaction.html">交互说明</a>'
        nav += '<a href="prototype.html">交互原型 ↗</a><a href="test.html">测试说明</a><a href="technical.html">技术方案</a><a href="../1.1/index.html">1.1 规划</a>'
    else:
        nav += '<a href="../1.0/index.html">返回 1.0</a>'
    return f'''<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{escape(title)}</title><style>{STYLE}</style></head>
<body><header><strong>Know Know · {version} 版本评审</strong><nav aria-label="评审资料">{nav}</nav></header><main>{body}</main></body></html>
'''


def render_link(tokens, idx, options, env):
    token = tokens[idx]
    href = token.attrGet("href") or ""
    if not href.startswith(("https:", "http:")):
        for name, (target, _) in PAGES.items():
            if href.endswith(name):
                token.attrSet("href", href[:-len(name)] + target)
                break
    return md.renderer.renderToken(tokens, idx, options, env)


md = MarkdownIt("commonmark", {"html": False}).enable("table")
md.renderer.rules["link_open"] = render_link

for version in ("1.0", "1.1"):
    folder = VERSIONS / version
    for name, (target, label) in PAGES.items():
        source = folder / name
        if source.exists():
            body = md.render(source.read_text())
            body += f'<p><a href="{name}">查看 Markdown 源文档</a></p>'
            (folder / target).write_text(page(f"Know Know {version} · {label}", version, body))
    if version == "1.0":
        body = '''<h1>Know Know 1.0</h1>
<p>个人本机使用 · 浏览器访问 · 无登录模块</p>
<p class="notice">这一版归档了产品需求、交互原型和测试说明。正式应用尚未开发，测试用例未执行；原型使用示例内容，不连接真实模型。</p>
<ul class="entries">
<li><a href="handoff.html"><strong>接手团队先读：开发与测试交接说明 →</strong></a><br>1.0 由接手团队开发与测试。查看职责边界、工作包、待定事项、测试证据及交付要求。</li>
<li><a href="interaction.html"><strong>交互实现说明 1.0</strong></a><br>选区双操作、卡片堆叠、树导航、模型锁定和正式实现需补齐的状态。</li>
<li><a href="product.html"><strong>产品功能说明书 1.0</strong></a><br>功能范围、层叠卡片、分支树、引用与探索、Provider、联网与自动摘要。</li>
<li><a href="prototype.html"><strong>打开交互原型 1.0 →</strong></a><br>体验新会话、选词探索、多层分支、知识助手与 Provider 配置。可播放探索过程。页面是 HTML 原型，非 Axure .rp 工程。</li>
<li><a href="test.html"><strong>测试说明 1.0</strong></a><br>21 项测试用例，包含前置条件、操作步骤、预期结果与验收规则。</li>
<li><a href="technical.html"><strong>技术方案 1.0</strong></a><br>本地数据保存、模型适配、独立搜索、分支上下文与摘要策略。</li>
<li><a href="../1.1/index.html"><strong>下一版本：1.1</strong></a><br>加入多用户登录及用户数据隔离；具体认证和部署方式后续确定。</li>
</ul>'''
    else:
        body = '''<h1>Know Know 1.1</h1><p>下一版本规划 · 多用户登录</p>
<p class="notice">在 1.0 的知识探索能力上加入多用户登录、退出和用户数据隔离。当前为规划，尚未开发。</p>
<ul class="entries"><li><a href="product.html"><strong>查看产品规划 1.1 →</strong></a><br>登录模块范围、用户数据边界、1.0 数据迁移、待定事项及测试目标。</li><li><a href="../1.0/index.html">查看 1.0 产品与交互基线</a><br>1.0 不包含登录模块，现有交互原型仍属于 1.0。</li></ul>'''
    (folder / "index.html").write_text(page(f"Know Know {version} · 版本评审", version, body))
    print(f"Built {folder.relative_to(ROOT)}")
