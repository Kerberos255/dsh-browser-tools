# 浏览器工具

提供 `browser_navigate`、`browser_snapshot`、`browser_click`、`browser_type`、`browser_screenshot` 五个 DSH 原生工具。使用 Playwright Core 1.63.0，只连接已启动的 Chromium CDP；安装此包不下载或启动浏览器。

在官方“设置 → 插件 → 浏览器工具”保存参数，或编辑安装根目录下 `plugins/dsh-browser-tools/config.json`。配置热更新会取消当前浏览器操作、释放本插件连接与标签页；下一次调用使用新配置。默认端点 `http://127.0.0.1:18801`，仅允许回环端点。

本机 CloakBrowser 由用户手动启动，命令如下：

```powershell
& '<CHROMIUM_EXE>' --remote-debugging-address=127.0.0.1 --remote-debugging-port=18801 --user-data-dir='<BROWSER_PROFILE_DIR>' --no-first-run --no-default-browser-check
```

首次使用认领可用的活动网页；同一网页由一个 DSH 会话占用，其他会话使用独立标签页，共享现有登录上下文。引用绑定会话、网页与导航代次，整数持续递增；动作和下一次快照后旧引用失效。同一会话动作顺序执行。卸载、会话释放只关闭本插件创建的标签页，已存在的网页保留，CDP 连接释放。

引用形如 `[a1b2c3d4:12]`，复制完整引用即可；会话标识避免两个渠道的引用重号。允许 HTTP / HTTPS 及空白页，拒绝 file、data、javascript、chrome 等 URL；离线实机测试使用受控本地 HTTP 页面，避免 data HTML 成为任意脚本入口。

默认金融、支付、政务、税务和招聘站点为 read，其他站点为 interact；可在设置页配置 blocked。规则支持域名通配和路径通配，`*.example.com` 包括根域名；最长有效规则优先，同长度采用更严格档位。每次操作重新判断当前站点及目标链接、表单站点；重定向进入 blocked 后停止后续读取和交互。

提交、发布、购买、删除、对外发送和转账通过原生 Approval Service 获得一次性授权，原生会话记录审批。审批期间目标变化则重新快照；没有可用审批通道时不执行。启用的确认清单可在设置页调整。识别基于元素语义与表单类型，页面脚本可能在普通动作时产生效果，故仍需模型正确理解用户授权。

快照返回普通输入框、文本区和选择框的值摘要，每项最多 300 字符，并受总快照长度限制。密码、凭据类字段及经 `secret` 输入的字段显示 `valueHidden`，不会读取并返回其值；保密标记在当前页面内保留，连接重置或插件重载后仍生效。页面文字统一标记不可信。模式扫描只提示疑似注入。`secret` 仅支持 fromFile 或 credentialRef；原生 text 参数的日志边界无法由插件消除。凭据引用必须在设置页绑定允许站点，例如 `[{"ref":"browser.site-password","match":"example.com"}]`，空列表默认不允许读取任何凭据。普通原生凭据设置保存秘密，浏览器设置只保存引用。

`fromFile` 只接受当前返回的 `runDirectory` 下的单个文件名，不接受绝对路径、目录、符号链接或硬链接。浏览器插件不提供任意脚本执行；内部 CDP 使用固定 DOM 元数据查询与保密字段标记。`press`、`wait` 记录实际需求，重复场景出现后再决定扩展；当前仍提供五个工具。

产物放在 DSH home 的 `dsh-browser-tools/runs/<随机标识>/`：审计动作 `actions.jsonl`、最后快照 `snapshot.json`、PNG 截图。默认不记录输入文本，secret 始终不记录正文。PNG 不直接调用模型。截图可能含页面的可见私人信息，展示前按用户任务判断范围。

原生超时中间件只包装这五个工具，声明上限 120 秒；内部动作默认 30 秒并结合原生取消信号。发生超时后不会自动重放动作，已经送入浏览器的动作可能完成，需先快照核对。没有常驻轮询或模型调用。
