# DSH 浏览器工具

[English](README.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [安全说明](SECURITY.md)

让 DSH Agent 连接**已经启动的 Chromium 浏览器**，通过 CDP 完成网页导航、结构化快照、点击、输入和截图。插件不下载浏览器，也不会自行启动浏览器。

## 主要功能

- 五个原生工具：`browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_screenshot`。
- 页面元素引用绑定会话、页面与导航状态；操作后重新获取快照，避免过期引用误操作。
- 网站规则分为 `read`、`interact`、`blocked`，敏感提交等动作使用 DSH 原生审批。
- CDP 只允许本机回环端点；凭据输入、审计日志和截图由本地 Host 管理。

## 安装与兼容性

需要 DSH、已经启动的 Chromium 浏览器和可用 CDP 地址；Node 与插件依赖要求以 [package.json](package.json) 为准。

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-browser-tools
```

上面的 `desktop` 是 Profile 示例；其他 Profile 请自行替换。希望固定部署来源时，可在 GitHub 地址末尾使用指定提交。首次安装或更换插件代码后重新打开 DSH。

## 快速开始

1. 使用独立浏览器数据目录，以 `--remote-debugging-address=127.0.0.1 --remote-debugging-port=18801` 等参数启动 Chromium。
2. 在「设置 → 插件 → 浏览器工具」填写 `http://127.0.0.1:18801`（默认端口，可修改）。
3. 在具备浏览器工具的 Agent 会话中先导航、获取 `browser_snapshot`，再使用返回的元素引用点击或输入。
4. 涉及提交、购买、删除、付款等行为时遵循原生审批；没有审批渠道时不会替你执行。

## 安全与排错

- 仅支持 HTTP、HTTPS 和允许的空白页；不允许把本地文件、`javascript:` 等地址当成任意执行入口。
- 网站导航或重定向后重新计算站点策略；敏感动作执行后应再次快照，超时后也不要盲目重放。
- 只关闭插件自行创建的标签页；浏览器已有页面保持不变。
- 本地审计与截图可能包含敏感网页内容，不要上传到公开仓库；详见 [SECURITY.md](SECURITY.md)。

## 测试及相关插件

运行 `npm test` 可检查不依赖宿主的策略逻辑；真实 CDP 连接仍需在实际浏览器和 DSH 中验收。配置模板：[config.example.json](config.example.json)。

相关：[桌面工具](https://github.com/Kerberos255/dsh-desktop-tools) · [搜索路由](https://github.com/Kerberos255/dsh-web-search-router)。

许可证：[MIT](LICENSE)。
