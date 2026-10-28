<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Codex ChatGPT Web">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

在 Codex 的原生模型选择器中使用你 ChatGPT 账户可用的 Web 模型（包括 Pro），使用 ChatGPT Web 独立的用量额度。

此版本是**面向无显示器机器的命令行运行时**：在 Linux 上于私有 Xvfb 虚拟显示中运行普通的 Google Chrome 或 Chromium（ChatGPT 会拒绝无头模式的 Chrome），在没有 GPU 的主机上使用 SwiftShader 渲染，使用账户邮箱和密码登录，并协助填写两步验证码。适用于服务器、容器以及没有显示器的机器，也可在 macOS 或 Linux 桌面运行。

## 快速开始

1. 安装 Chrome 或 Chromium，在 Linux 上还需安装 Xvfb（例如 `sudo apt install chromium xvfb`）。
2. 安装运行时（macOS 或 Linux，x64/arm64）：

   ```bash
   curl -fsSL https://github.com/miuuyy/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ```

3. 设置并登录。终端会显示每个登录步骤，并在 OpenAI 要求时询问验证码：

   ```bash
   codex-chatgpt-web setup --browser-only --email you@example.com --acknowledge-unofficial
   ```

4. 重启 Codex 一次，选择名称以 **(Web)** 结尾的模型。

## 登录与两步验证

- 邮箱：`--email` 或 `CODEX_CHATGPT_WEB_EMAIL`；密码：`--password-file` 或 `CODEX_CHATGPT_WEB_PASSWORD`，未提供时会以不回显方式提示。密码不会作为命令行参数接受，也不会被保存。
- 身份验证器：通过 `--totp-secret-file`（base32 密钥或 `otpauth://` URI）自动生成验证码；否则每次都会询问。邮件或短信验证码始终在终端中询问。
- 人机验证（Cloudflare、Arkose）不会被自动处理；可稍后重试，或在有浏览器的电脑上生成会话后使用 `--import-login FILE`。
- 会话过期后运行 `codex-chatgpt-web login` 重新登录。

完整说明（Full harness / MCP、Linux 上的 systemd 服务、GPU 选项、安全模型）请参阅 [English README](README.md)。从源码运行需要 Bun 1.4.0。

[故障排除](TROUBLESHOOTING.md) · [安全](SECURITY.md) · [MIT 许可证](LICENSE)
