# Know Know 1.0 评审包

**接手团队请先阅读 [开发与测试交接说明](./DEVELOPMENT_HANDOFF.md)。** 1.0 的后续开发和测试由接手团队完成，本包提供需求、原型、技术建议及测试设计。

用浏览器打开 [index.html](./index.html)，可从同一个入口查看产品说明、测试说明、技术方案和交互原型。本目录可整体复制，连同相邻的 `../1.1/` 目录即可保留跨版本链接。

| 文件 | 用途 |
| --- | --- |
| DEVELOPMENT_HANDOFF.md / handoff.html | 开发须知、材料导航、职责边界、待定项与最终交付要求。 |
| INTERACTION_SPEC.md / interaction.html | 交互状态、选区双操作、卡片与树导航的实现说明。 |
| PRODUCT_SPEC.md / product.html | 产品说明书 1.0 的源文档与浏览器阅读版。 |
| TEST_SPEC.md / test.html | 测试说明 1.0：21 项用例，均未执行正式应用测试。 |
| TECHNICAL_DESIGN.md / technical.html | 技术方案 1.0 的源文档与浏览器阅读版。 |
| prototype.html | 已确认交互的独立页面，包含所需的原型运行支持，可直接打开。 |
| prototype.fragment.html | 原型可编辑源片段，需配套运行支持；独立查看请打开 prototype.html。 |

原型来自本次讨论中最后确认的选词「引用 / 探索」版本，归档时未改动交互源内容。它是 HTML 原型，不包含 Axure `.rp` 文件；示例身份和 Provider 配置不代表登录或真实 API 能力。

1.0 不包含登录模块；[1.1](../1.1/PRODUCT_SPEC.md) 规划加入多用户登录与用户数据隔离。版本编号代表需求、测试设计与原型基线，不代表软件已发布或测试通过。

如浏览器不便打开本地文件，可在工程根目录运行：

```sh
python3 -m http.server 8750 --bind 127.0.0.1 --directory docs/versions
```

然后访问 `http://127.0.0.1:8750/1.0/index.html`。该服务仅用于查看静态评审材料，不是正式应用服务。

修改 Markdown 后，在具备 `markdown-it-py` 的 Python 环境下从工程根目录运行 `python3 scripts/build-review-pages.py`，重新生成文档阅读页面。此命令不改写已归档的交互原型。
