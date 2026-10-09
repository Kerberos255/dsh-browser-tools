# Browser Tools for DeepSeek Harness

[简体中文](README.zh-CN.md) · [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) · [Security](SECURITY.md)

Connect a **running Chromium browser** to a DSH agent through Chrome DevTools Protocol (CDP). Navigate, inspect accessible page snapshots, click, type, and capture screenshots without launching or downloading a browser.

## What it does

- Exposes the native `browser_navigate`, `browser_snapshot`, `browser_click`, `browser_type`, and `browser_screenshot` tools.
- Uses session-scoped element references to prevent clicks against stale pages; sessions are isolated across tabs.
- Supports `read`, `interact`, and `blocked` site rules. Sensitive actions use DSH's native approval service.
- Limits CDP connections to loopback, redacts supported secret fields in snapshots, and saves bounded audit artifacts locally.

## Requirements and installation

Requires an existing DeepSeek Harness host, a running Chromium-compatible browser with a **local CDP endpoint**, and the Node.js/peer dependencies declared in [package.json](package.json). The plugin does not install a browser.

Install through DSH's plugin manager (replace `desktop` with your profile if needed):

```sh
dsh plugin --profile desktop add github:Kerberos255/dsh-browser-tools
```

For reproducible deployments, pin the GitHub source to a specific commit. Restart DSH after first installation or a code update.

## Quick start

1. Launch a Chromium browser with local remote debugging enabled on the port configured for the plugin (the default is `18801`). Use a **separate browser profile**.
2. Open **Settings → Plugins → Browser Tools** and enter the loopback CDP address (default `http://127.0.0.1:18801`).
3. Open a DSH agent with these tools enabled, navigate to a page, and request a snapshot before interacting with elements.

Example browser arguments (substitute your browser executable and profile directory):

```text
--remote-debugging-address=127.0.0.1 --remote-debugging-port=18801 --user-data-dir=<browser-profile>
```

## Safety and data

Browser content is untrusted input. The plugin rejects unsupported URL schemes, checks site rules again on navigation and interaction, and requires native approval for configured sensitive operations. Existing tabs are preserved on unload; plugin-created tabs may be closed. Snapshots and screenshots can contain private information; runtime artifacts stay under DSH's local data directory. See [SECURITY.md](SECURITY.md) for reporting and boundaries.

## Development

Run `npm test` for portable policy tests. Live browser/CDP behavior requires an active DSH host and is **not** established by CI alone. Sample settings: [config.example.json](config.example.json).

Related: [Desktop Tools](https://github.com/Kerberos255/dsh-desktop-tools) for Windows native applications · [Web Search Router](https://github.com/Kerberos255/dsh-web-search-router) for search-provider routing.

MIT licensed. See [LICENSE](LICENSE).
