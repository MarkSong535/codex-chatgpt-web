<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Switch to web models. Stay in Codex. Your ChatGPT plan. Your workflow. Maximum capabilities.">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

<p align="center">
  <a href="#get-started">Get started</a> · <a href="#sign-in">Sign-in & 2FA</a> · <a href="docs/architecture.md">Architecture</a> · <a href="TROUBLESHOOTING.md">Troubleshooting</a>
</p>

Use the ChatGPT Web models available on your account, including Pro, from Codex's native model
picker, with ChatGPT Web's separate usage limits and without spending your Work or Codex quota.

This edition is a **command-line runtime for machines without a monitor**. On Linux it runs an
ordinary Google Chrome or Chromium on a private Xvfb virtual display, renders with SwiftShader when
there is no GPU, signs in with your account email and password, and fills two-factor codes for you.
It is built for servers, containers, and other machines without a display; it also runs on a macOS
or Linux desktop. (ChatGPT rejects headless Chrome, so Chrome is never run in headless mode.)

<div id="get-started"><a id="quick-start"></a></div>

## Get started

**Available models:** Free/Go → **Luna / Think**. Paid accounts → **GPT-6 Sol** and **GPT-5.6 Sol**,
with **Instant–High**, plus **Extra High** and **Pro** when available. Availability depends on your
account and workspace.

1. **Install the runtime.** On Debian or Ubuntu, download `codex-chatgpt-web_<version>_amd64.deb`
   (or `_arm64.deb`) from the [latest release](https://github.com/MarkSong535/codex-chatgpt-web/releases/latest)
   and install it; apt also installs Xvfb:

   ```bash
   sudo apt install ./codex-chatgpt-web_1.0.2_amd64.deb
   ```

   On other Linux distributions or macOS (x64 or arm64), use the installer script, and on Linux also
   install Xvfb:

   ```bash
   curl -fsSL https://github.com/MarkSong535/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ```

2. **Install a browser.** On Debian, `sudo apt install chromium`; on Linux x64, Google Chrome's
   `.deb`; on macOS, Google Chrome. On Ubuntu, Linux arm64, or anywhere else, install the Chromium
   build that matches this tool (`--with-deps` also installs its system libraries through `sudo`):

   ```bash
   codex-chatgpt-web browser install --with-deps
   ```

   Ubuntu's `chromium-browser` is a snap; its confinement keeps it off the private display, so it is
   skipped. The browser is found automatically; otherwise pass `--chrome PATH` to setup.

3. **Set up and sign in.** Setup asks for anything you leave out, shows each sign-in step, and
   asks for the two-factor code when OpenAI requests one:

   ```bash
   codex-chatgpt-web setup --browser-only --email you@example.com --acknowledge-unofficial
   ```

4. **Restart Codex once** and choose a model ending in **(Web)**.
5. **For coding with tools**, complete the [Full harness](#full-harness) setup.

On Linux the daemon and tunnel run as `systemd --user` services; run
`sudo loginctl enable-linger "$USER"` once so they keep running after you log out. In a container
without systemd, setup prints the two commands to keep running yourself
(`codex-chatgpt-web serve` and, in full mode, `codex-chatgpt-web tunnel run`).

<a id="sign-in"></a>

## Sign-in & two-factor verification

Sign-in runs in Chrome (on the private display on Linux) and reports each step:

```text
[1/7] Launch Chrome
[2/7] Open the ChatGPT sign-in page
[3/7] Enter the account email
[4/7] Enter the password
[5/7] Two-factor verification: waiting for an authenticator app code
      Two-factor verification: open your authenticator app.
      Enter the authenticator app code: 123456
[5/7] Two-factor verification: entering the code
[6/7] Confirm the signed-in session
[7/7] Save the session
```

| Input | Flag | Environment variable | If missing |
| --- | --- | --- | --- |
| Account email | `--email EMAIL` | `CODEX_CHATGPT_WEB_EMAIL` | Prompted |
| Password | `--password-file PATH` | `CODEX_CHATGPT_WEB_PASSWORD` | Prompted without echo |
| Authenticator secret | `--totp-secret-file PATH` | `CODEX_CHATGPT_WEB_TOTP_SECRET` | You are asked for each code |

- **Authenticator apps:** pass the setup key shown under "can't scan the QR code" (base32) or the
  full `otpauth://` URI, and codes are generated automatically. Without it you type each code.
- **Email or SMS codes** are always asked for in the terminal.
- **Unattended runs** (no terminal) need the password from a file or environment variable and,
  for accounts with an authenticator, the TOTP secret.
- Passwords are never accepted as command-line arguments, and neither the password nor the TOTP
  secret is stored. Only the resulting ChatGPT session is saved, owner-only, under
  `~/.codex-chatgpt-web/browser/`. Keep secret files `chmod 600`.
- **Refresh an expired session** with `codex-chatgpt-web login` (same flags).
- **Human-verification checks** (Cloudflare, Arkose) are never solved automatically; sign-in
  stops with a screenshot. Retry later, or create a session on a computer with a browser and pass
  it with `--import-login FILE`, for example
  `npx playwright codegen --save-storage=chatgpt.json https://chatgpt.com`.
- Social sign-in (Google, Microsoft, Apple) and passkeys are not supported; use an account with
  an OpenAI password.

<details>
<summary><strong>Chrome, virtual display & GPU</strong></summary>

- On Linux, Chrome runs on its own Xvfb display (`-nolisten tcp`), started on demand and stopped
  with the process, so nothing appears on any desktop. Without Xvfb it uses an existing display,
  and fails with an install hint when there is none.
- On macOS, Chrome opens an ordinary window while it works.
- `--chrome-gpu auto` (default) uses SwiftShader software rendering on the virtual display and on
  Linux hosts without a `/dev/dri/renderD*` node; `software` forces it and `hardware` leaves the
  choice to Chrome.
- On Linux `--disable-dev-shm-usage` is always added, and `--no-sandbox` when running as root.
- Environment overrides: `CODEX_CHATGPT_WEB_CHROME_GPU=software|hardware`,
  `CODEX_CHATGPT_WEB_XVFB=0` (use the existing display), and `CODEX_CHATGPT_WEB_CHROME_ARGS`
  (extra space-separated Chrome flags).

</details>

<details>
<summary><strong>Models, modes & MCP setup</strong></summary>

<a id="modes"></a>

| Mode | Sending messages | Local Codex tools |
| --- | --- | --- |
| **Browser-only** (`--browser-only`) | Automatic | No |
| **Full harness** (`--full`) | Automatic | Yes, through MCP |

Automatic models ending in **(Web)** expose their supported Effort choices in Codex. Instant and
each Pro version have separate entries to preserve their context budgets.

<a id="full-harness"></a>

### Full harness

Full mode connects ChatGPT's tool calls back to the current Codex task through the official
[OpenAI tunnel-client](https://github.com/openai/tunnel-client). The tunnel is outbound: it does
not expose a public IP, open an inbound port, or require router forwarding.

1. Create a tunnel and a runtime key with **Tunnels Read + Use**
   (`codex-chatgpt-web open tunnels`, `codex-chatgpt-web open runtime-keys`), then run
   `codex-chatgpt-web setup --full --tunnel-id ID --runtime-key-file PATH --acknowledge-unofficial`.
2. Enable ChatGPT **Developer Mode** and create a Tunnel connector named exactly
   **Codex Native2**, with **Authentication: None** and **Allow all actions**.
3. Run `codex-chatgpt-web doctor` to confirm the daemon and tunnel are ready.

Write/modify actions also require the ChatGPT workspace and its administrator policy to permit
them. See
[developer mode and MCP apps](https://help.openai.com/en/articles/12584461-developer-mode-and-mcp-apps-in-chatgpt).
Unexpected approval prompts fail closed unless `--auto-approve-tool-calls` is explicitly enabled;
that option clicks **Allow once**, never a permanent grant.

Each turn opens a fresh ChatGPT conversation. When Codex compacts a long task, the compaction runs
as a read-only turn over the complete Codex context.

</details>

<details>
<summary><strong>Diagnostics & subagents</strong></summary>

<a id="operations"></a>

`codex-chatgpt-web doctor` checks Chrome, the stored login, the Codex route, the daemon, and in
full mode the tunnel. `codex-chatgpt-web browser check` launches Chrome once.
Set `CODEX_CHATGPT_WEB_BROWSER_DIAGNOSTICS=1` only when every browser checkpoint needs a screenshot.

New installs use **Compatibility V1** for cross-backend subagents. **Native** preserves Codex's own
feature settings and enables plaintext Web-to-Web V2 delegation. Restart Codex and start a new task
after changing the protocol:

```bash
codex-chatgpt-web subagents status
codex-chatgpt-web subagents compatibility-v1
codex-chatgpt-web subagents native
```

</details>

<details>
<summary><strong>Requirements & security</strong></summary>

<a id="limitations-and-security"></a>

- This is unofficial browser automation, not an OpenAI API. ChatGPT UI changes can break selectors;
  drift fails explicitly instead of silently switching model or transport.
- The stored browser session is a sensitive login artifact, and the loopback listener is reachable
  by processes running as the same local user. Use a trusted, single-user host.
- Release runtimes target macOS 13+ and Linux (x64 and arm64). Windows can run from source, but
  setup and background services are supported on macOS and Linux only.

Read the complete [architecture](docs/architecture.md) and
[security model](docs/security-model.md) before enabling full mode. Report vulnerabilities through
[SECURITY.md](SECURITY.md).

Task prompts are processed by OpenAI and conversations remain in your ChatGPT history.

This is independent software and is not affiliated with or endorsed by OpenAI. Use it only with
your own account and in accordance with applicable [Terms of Use](https://openai.com/policies/terms-of-use/)
and workspace policies; it does not bypass authentication or access controls.

</details>

<details>
<summary><strong>Run from source & develop</strong></summary>

<a id="development"></a>

```bash
git clone https://github.com/miuuyy/codex-chatgpt-web.git && \
cd codex-chatgpt-web && \
bun install --frozen-lockfile && \
bun run src/cli.ts setup --browser-only --email you@example.com --acknowledge-unofficial
```

This source path requires Bun 1.4.0.

```bash
bun run verify
bun run build
bun run smoke
bun run smoke:subagents
```

</details>

---

[Troubleshooting](TROUBLESHOOTING.md) · [Security](SECURITY.md) · [Contributing](CONTRIBUTING.md) · [MIT license](LICENSE) · [CI](https://github.com/miuuyy/codex-chatgpt-web/actions/workflows/ci.yml)
