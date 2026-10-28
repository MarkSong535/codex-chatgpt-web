# Troubleshooting

This guide covers the failures reported most often. Start here before reinstalling, editing Codex
configuration, or opening a new issue.

## The first five minutes

1. Run `codex-chatgpt-web doctor`. It checks Chrome, the stored ChatGPT login, the Codex route, the
   background daemon, and in full mode the tunnel.
2. Run `codex-chatgpt-web browser check` to confirm that Chrome starts on this host.
3. Fully quit Codex, including its background process, and reopen it. Signing out, closing only the
   window, or starting another task does not reload the model catalog.
4. Select a model ending in **(Web)** from Codex's model picker.
5. If the problem remains, reproduce it once and collect `~/.codex-chatgpt-web/logs/daemon.stderr.log`
   (on Linux also `journalctl --user -u codex-chatgpt-web`).

Do not repeatedly rerun setup after it reports success. The exact error is more useful than another
reinstall.

### Browser diagnostic retention

Browser checkpoints are stored under `~/.codex-chatgpt-web/diagnostics/browser-turns/`.
Failed captures are retained for up to three days within a 100 MB budget for finished captures.
Newer failures take priority over older failures and the ten most recent successful captures.
Active captures are never removed by cleanup. A burst of failures can exhaust the disk budget,
so copy any specifically requested checkpoint files before continuing a long investigation.

## Sign-in does not complete

`setup` and `login` print each sign-in step as `[n/7]`. The last step shown tells you where it
stopped. When a step fails, a full-page screenshot is saved to
`~/.codex-chatgpt-web/browser/login-failure.png` (owner-only); it may show your email address.

- **`OpenAI did not accept the email address` / `the password`:** the message after the colon is
  OpenAI's own. Check the password file has no extra characters (only one trailing newline is
  removed). Accounts created with Google, Microsoft or Apple sign-in have no OpenAI password; set
  one in your OpenAI account first, or use `--import-login`.
- **`OpenAI asked for a … code, but no TOTP secret was given and no terminal is attached`:** the
  run is unattended. Pass `--totp-secret-file` for authenticator codes, or run `login` once in an
  interactive terminal. Email and SMS codes always need a person.
- **`OpenAI rejected 3 verification codes`:** for authenticator codes, check the host clock
  (`timedatectl`) and that the secret is the one for this account. Codes are 30-second values; a
  retry waits for the next one rather than resubmitting the same code.
- **`OpenAI showed a human-verification check`:** the tool never solves Cloudflare or Arkose checks.
  Wait and retry later from the same network. If it persists, create a session on a computer with a
  browser and import it:

  ```bash
  npx playwright codegen --save-storage=chatgpt.json https://chatgpt.com
  ```

  Sign in in the window that opens, close it, copy `chatgpt.json` to the server, then run
  `codex-chatgpt-web login --import-login chatgpt.json` and delete the copy. Only ChatGPT/OpenAI
  cookies are kept, and the session is verified before it is saved.
- **`The sign-in flow stopped on an unrecognized page`:** OpenAI changed its sign-in pages. Open an
  issue with the URL from the message; do not attach the screenshot publicly.

Running sessions keep working until ChatGPT expires them. When turns start failing with a sign-in
error, run `codex-chatgpt-web login` again, then `codex-chatgpt-web service restart`.

## Chrome, virtual display, GPU, and Linux services

- `Chrome needs a display, and this Linux host has none`: install Xvfb (`sudo apt install xvfb`).
  Chrome then runs on a private virtual display; nothing needs a monitor.
- ChatGPT answers `403` / "Just a moment..." to headless Chrome, which is why this tool never uses
  headless mode. Do not pass `--headless` through `CODEX_CHATGPT_WEB_CHROME_ARGS`.
- Chrome is found at `/usr/bin/google-chrome`, `google-chrome-stable`, `/opt/google/chrome/chrome`,
  `chromium`, `chromium-browser` or `/snap/bin/chromium`. Otherwise pass `--chrome PATH` to setup.
- `browser check` fails with missing shared libraries: install the distribution's Chrome or
  Chromium package rather than a bare binary, so its dependencies come with it.
- Rendering problems on a host without a GPU: `--chrome-gpu auto` already selects SwiftShader when
  no `/dev/dri/renderD*` node exists. Force it with `--chrome-gpu software` (or
  `CODEX_CHATGPT_WEB_CHROME_GPU=software`) inside VMs that expose a render node without a real GPU.
- Crashes in containers: `--disable-dev-shm-usage` is always added on Linux; running as root adds
  `--no-sandbox`. Extra flags can be passed with `CODEX_CHATGPT_WEB_CHROME_ARGS`.
- The daemon stops when you log out: run `sudo loginctl enable-linger "$USER"` once.
- `systemd user services are unavailable on this host`: there is no user service manager (common in
  containers or `su` shells). Setup still saves everything; keep `codex-chatgpt-web serve` and, in
  full mode, `codex-chatgpt-web tunnel run` running under your own supervisor.

## Models do not appear

A running Codex process can keep its old model catalog. If **(Web)** models are missing, fully quit
every Codex Desktop window and Codex CLI process, then reopen Codex while the daemon is running. If a
**(Web)** model already answers successfully, you do not need to rerun setup.

If the models still do not appear:

- confirm that **Codex itself** uses ChatGPT sign-in; the account stored by `codex-chatgpt-web login`
  is separate. An API-key or signed-out Codex session can show only its built-in catalog without
  contacting the bridge;
- rerun `codex-chatgpt-web setup` once with your usual flags;
- run `codex-chatgpt-web doctor`; a healthy local proxy does not mean the upstream model-list
  request succeeded. Doctor reports its latest result separately; and
- make sure another Codex wrapper is not replacing the route.

## `openai_base_url changed after setup` or a model is "not supported"

Setup deliberately refuses to overwrite a route changed by another tool. Only one program
can own Codex's `openai_base_url` at a time. Wrappers and routers such as OpenCodex, Headroom,
OmniRoute, Codex++, CC Switch, or a manually configured provider may replace the Codex Web GPT route
for the whole installation or only for the process they launch.

Choose one route owner:

- To use Codex Web GPT, disable the other wrapper's provider/proxy mode, rerun
  `codex-chatgpt-web setup` with your usual mode flag (add `--replace-codex-route` only when you
  mean to replace the other route), fully restart Codex, and start Codex directly rather than
  through the wrapper command.
- A tool may remain enabled only as an MCP integration if it does not replace `openai_base_url`.
- To switch away cleanly, run `codex-chatgpt-web uninstall --yes` (or `route disconnect`) first.
  This restores the exact route that existed before Codex Web GPT was installed.

Do not hand-edit the route journal. It exists so setup and removal can fail closed instead
of silently destroying another provider's configuration. First-class external-router composition is
tracked in [#205](https://github.com/miuuyy/codex-chatgpt-web/issues/205), but is not supported today.

## `Codex interrupt lifecycle hook changed after setup`

Setup found that its entries in Codex's `config.toml` are missing or different from those
installed during setup. This can happen when another tool edits the file. Setup stops to avoid
overwriting those changes. A TOML parsing error instead means the file cannot be read; an invalid
integration journal means the saved setup record needs investigation.

Close Codex and any tool editing its settings, then make a copy of `config.toml`. It is normally in
`~/.codex` (Windows: `%USERPROFILE%\.codex`), or the folder selected by `CODEX_HOME`.
Compare it with a known-good backup made **after a successful setup**. Restore only the
affected `hooks.Interrupt` and matching `hooks.state` entries, preserving their order and
all unrelated settings and hooks. For a syntax error, repair the TOML or restore a known-good file,
keeping a copy of the current version so newer settings are not lost.

Then rerun `codex-chatgpt-web setup` with your usual flags. Do not delete all hooks or edit the
integration journal to bypass the check. If you have no suitable backup, or the error mentions the
journal, open an issue with the exact error. Do not upload your
whole config file; it may contain credentials.

## A second `CODEX_HOME` fails with `missing network access in trusted Codex environment context`

The bridge normally reads native task permissions from its own `CODEX_HOME`. A CLI using a
different home stores its task records elsewhere. Its filesystem-only environment message does
not provide enough information to recover network permissions.

To share one bridge across your local Codex homes, set `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES`
**in the environment that starts the daemon**. Its value is a JSON array of up to seven
additional absolute local directories. For the systemd user service, for example:

```bash
systemctl --user set-environment CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES='["/home/me/.codex-second"]'
```

Finish active tasks, then run `codex-chatgpt-web service restart`. Replace the example path with
your actual home. Each home still needs its
own Codex integration setup; this setting registers where the shared bridge may read native task
records. Directories must already exist and must not themselves be symbolic links. The bridge
canonicalizes directory aliases and rejects a thread found in more than one registered home.

Each turn must match its current native thread, permissions, and turn ID. Shared-home mode does not
reuse the single-home permission cache. A secondary home's custom SQLite location must be set in
that home's `config.toml` as `sqlite_home`; the bridge's `CODEX_SQLITE_HOME` applies only to its
primary home.

## Native models stop when the daemon is not running

While the integration is installed, native Codex models also use the local bridge. Keep the daemon
running (`codex-chatgpt-web service status`), or temporarily restore the previous route with
`codex-chatgpt-web route disconnect` and reconnect it later with `route connect`. Fully restart
Codex after a route change.

## Codex's usage-limit banner disables Send for Web models

If Codex shows **You're out of Codex and Work usage** and disables Send even with a Web model
selected, sign out of **Codex** and sign in with another account you own that can send messages.
A free account with Codex access and no blocking usage banner can be used.

The ChatGPT account used for Web models is the one stored by `codex-chatgpt-web login`; these are
separate sessions. Changing the Codex login does not reset or increase its ChatGPT Web limits.

## Encrypted content cannot be verified after switching models

If switching from ChatGPT Web to a native Codex model fails with `Encrypted content could not be
decrypted or parsed`, check the route owner. The bridge's native route already converts Web
checkpoints into readable context and preserves native encrypted history. An external router that
sends native requests directly to OpenAI bypasses that conversion.

Use one route owner as described above. If the error persists through the bridge, open an issue
and include both model names and whether compaction preceded the switch. Do not delete checkpoints
or strip encrypted history; this can lose task context. External-router composition remains unsupported.

## The browser smoke test fails

The smoke test and real turns use the same current ChatGPT controls. Errors mentioning the effort
control, composer, send button, new chat, or an operational viewport usually
mean that the ChatGPT UI did not expose a structure the bridge can safely prove.

1. Update to the latest release.
2. Sign in to the same account in a normal browser and confirm that a new ordinary chat opens and
   the account is not showing an onboarding, capacity, or rate-limit dialog. Dismiss any such
   dialog there, then run `codex-chatgpt-web login` again.
3. Retry once. Failed turns keep screenshots under `~/.codex-chatgpt-web/diagnostics/browser-turns/`.
4. If the same structural error remains, do not keep retrying. Open a focused bug report; ChatGPT UI drift must be fixed against the observed DOM, not guessed around.

Free and Go accounts normally expose Luna and Think without the paid-account effort selector. A
missing paid selector on those accounts is not itself a sign-in failure.
Luna and Think use rolling summaries when Bigger Context is off (`setup --standard-context`). Experimental Bigger
Context keeps the task conversation and sends large histories in parts. If earlier details
are lost in long Free-account chats, rerun setup with `--standard-context` and restart Codex.

## Personalization or connector controls are not found

Current builds always use ordinary ChatGPT chats, including connector verification. If an older
build fails in Temporary Chat, update, finish active tasks, and restart the daemon and Codex.
The old chat-mode setting is no longer used. Task conversations remain in ChatGPT history;
ChatGPT memory and custom instructions may apply.

In ChatGPT (in any browser signed in to the same account), open **Settings → General → Language**
and choose **English** explicitly, then retry once. Some browser controls depend on English labels.
The same step applies when a model "could not be selected and verified".

## Full harness or MCP verification fails

Browser-only mode needs no connector. Full harness mode requires all of the following:

- a newly created connector with the exact name in `config.json` `appName` (**Codex Native2** by default);
- **Developer Mode** enabled in ChatGPT;
- the exact Tunnel selected with **Authentication: None**;
- the connector and Tunnel on the same OpenAI account as the ChatGPT workspace;
- **Allow all actions** under the connector's permissions; and
- `codex-chatgpt-web tunnel status` reporting the tunnel healthy and ready.

If a turn reports **ChatGPT is waiting for plugin permission**, open the plugin's settings
in ChatGPT and choose **Permissions → Allow all actions**, then retry the turn. A visible
**Allow ChatGPT to use …?** card means ChatGPT is waiting for a permission decision. If
all actions are already allowed, open the ChatGPT tab and check the request; saved chats
can still ask for one-time approval. Wait for the Stop button to disappear before approving.
The bridge leaves unanswered requests untouched when the turn stops.

If ChatGPT says **MCP endpoint not found**, make sure the tunnel is running
(`codex-chatgpt-web tunnel status`) before creating the plugin. Use the same Tunnel ID in both
places and copy the plugin name exactly. If ChatGPT then reports a request limit, wait for its
cooldown before retrying once. If the tunnel is ready but creation still fails, open an issue with
the exact error and time of the attempt.

Do not rename or refresh an old **Codex Native** connector. ChatGPT caches the public MCP contract by
connector identity, so create **Codex Native2** as a new connector.

After updating, if `codex_exec` still does not expose `sandbox_permissions`, `justification`, and
`prefix_rule`, recreate the current mode's connector so ChatGPT loads the updated tool schema.
These fields only forward a permission request to Codex; its sandbox and approval policy still
decide whether the command can run. Ordinary commands do not require these optional fields.

### ChatGPT refuses a tool call or context compaction

Share the exact failed tool result and the daemon log from the failing turn. An assistant saying
"safety block" without a failed tool result does not establish the cause. **Allow all actions**
does not override ChatGPT's own safety checks.

After updating, refresh **Codex Native2** in ChatGPT's plugin settings to load its current tool
descriptions. This updates the compaction tool contract; it does not remove safety restrictions.
If compaction ends without a summary, the bridge reports that failure and preserves
the existing task history.

### A tool reports an invalid or expired turn token

A turn token identifies one active Codex turn. If ChatGPT changes or omits a character when copying
it into a tool call, the call is rejected. Tokens from finished turns are also rejected.

After updating, refresh **Codex Native2** in ChatGPT's plugin settings so it loads the current token
format and copying instructions, then retry the task in Codex. If the error continues, report the
failure time and the daemon log. Do not include the token itself.

### Tools disappear on follow-up messages

Each turn opens a fresh ChatGPT conversation and attaches the connector again, so tools that work on
the first message should keep working. If they disappear, recreate **Codex Native2** as a new
connector with the same Tunnel and **Allow all actions**. If tools are already missing in a fresh
chat, report that separately with the daemon log and the connector's tool state in ChatGPT.

### ChatGPT will not reuse a deleted plugin's name

Rerun setup with `--connector-name-suffix Work` (and your usual flags) to get **Codex Work**, then
create a new plugin with exactly that name. The tunnel credentials and ChatGPT login are kept. Do not rename the retired
**Codex Native** plugin to reuse its old schema.

### ChatGPT shows `Error creating connector`

1. Confirm that the Tunnel ID and the runtime key passed to setup were created under the same
   OpenAI account.
2. Confirm that `codex-chatgpt-web tunnel status` reports the Tunnel running before you create the
   connector in ChatGPT.
3. ChatGPT can reject the first **Create** attempt once even when the Tunnel is healthy, usually
   after 5–10 seconds. Press **Create** one more time. If the second attempt also fails, stop
   retrying and recheck the account, Tunnel ID, and running Tunnel first.

If tool calls work until native Codex quota is exhausted and then edits are denied by **Automatic
approval review**, disable that optional Codex review setting and restart Codex. The outer Codex
sandbox and explicit approvals still apply; this only prevents an unavailable native model from
being inserted as an extra reviewer after the Web tool call already completed.

## Long-running commands and MCP deadlines

Each MCP invocation has a 90-second deadline. Command polling through `codex_write_stdin`,
`codex_tool_call`, or the native `exec` gateway accepts `yield_time_ms` up to 60,000 ms.
Longer waits are rejected before dispatch without retiring the task. Return after each poll;
if the result still has a `session_id`, use a separate call to collect more output.
The command continues running between polls. Changing `stallTimeoutSec` does not change the
MCP invocation deadline.

After updating, if ChatGPT still advertises a five-minute maximum for `codex_write_stdin`,
recreate the current mode's connector with the same Tunnel and permissions to load its updated
tool schema. Existing connectors receive an explicit validation error for an excessive wait;
the bridge does not silently shorten the requested duration.

## `Reconnecting`, `stream disconnected`, or `ChatGPT failed`

These are result boundaries, not one diagnosis. The bridge uses them when it cannot prove a complete
ChatGPT turn. Common causes include an account-side rate limit, ChatGPT's own "Something went wrong"
state, a changed UI control, a closed browser surface, a conflicting route, or a tool that exceeded
its bounded MCP deadline.

- Read the final detailed error after the reconnect attempts; do not report only the word
  `Reconnecting`.
- Retry once in a fresh Codex task. State whether the fresh task works and whether the failure is
  consistent.
- Run `codex-chatgpt-web doctor` and keep the daemon log from immediately after the failure.
- Include the exact model, Browser-only or Full harness mode, whether tools ran, and whether the
  ChatGPT page showed a final answer.

Do not assume that a generic 502 means the Tunnel is broken. Since v4.0.7, a native tool that
outlives its turn binding is reported explicitly as `codex_tool_timeout` and retired rather than
being presented as an ambiguous proxy success.

If Stop disappears before the final answer, the bridge allows up to ten minutes without new
observable response activity. A visible error or a completed empty answer has its own check.
An idle timeout does not establish why ChatGPT stopped responding. Keep the original ChatGPT tab
when reporting this case, and mention whether its final answer appeared after the error.

For repeated compaction, the daemon log includes `context_token_breakdown`: character and token
counts grouped by instruction/message role, without their contents. These counts distinguish a
large fixed instruction load from growing conversation history. They cover individual submitted
records; the full input estimate also includes transport framing, attachments and platform reserve.

## Saved task environment cannot be read

If an interrupted shutdown damages `runtime/thread-environments.json`, start a fresh Codex task.
When Codex supplies a verified workspace and permissions, the bridge preserves the damaged JSON
beside the original as `thread-environments.json.corrupt-…` and rebuilds the file from that current
task. It does not recover permissions from damaged data. Existing tasks without a current verified
environment may still need to be restarted.

If the error remains or reports invalid workspace/permission records, open an issue with the exact
error. Keep the preserved file private; do not delete your settings or upload the saved task
environments.

## Native compaction returns `404 Not Found`

For an ordinary Codex model, `/v1/responses/compact` forwards to the native legacy compact
endpoint. That endpoint can return an upstream 404 even when the model and authorization work.
Check whether a config layer sets `[features].remote_compaction_v2 = false`. Current Codex enables
V2 by default; remove that override or set the existing key to `true`, then restart Codex and retry
compaction on the same native model. V2 uses `/responses` with a compaction trigger.

If it still fails, include the effective feature setting, selected model, exact failure time and
daemon log. `native_compaction_upstream_failed` records the route, model, HTTP status and available
request identifiers without prompt contents or credentials. A separate Web context-length error
still requires its own diagnosis; changing the native protocol does not increase Web input limits.

## ChatGPT says the account is temporarily limited

The bridge permits at most five simultaneous browser tabs as an account-safety ceiling. Five is not
a recommended concurrency setting, and ChatGPT does not expose a stable numeric quota or cooldown.
Some accounts have reached a limit with only two turns started close together.

After the first account-side limit response, stop retrying and let the cooldown clear. For a
conservative starting point, set one spawned agent thread at a time in the existing `[agents]`
section of `~/.codex/config.toml`:

```toml
[agents]
max_concurrent_threads_per_session = 1
```

If the table already exists, add or change only the key; do not create a second `[agents]` table.
If it contains `max_threads`, replace that old name with `max_concurrent_threads_per_session`;
do not keep both. Codex treats them as aliases and may reject the configuration as a duplicate field.
Bigger Context can make one turn larger and longer, but does not increase safe account concurrency.

## Images from earlier turns are attached again

Codex includes prior task images in the canonical conversation context. The bridge follows that
context and keeps only the newest ten complete images, so seeing an earlier image again in the same
task is expected. Start a new Codex task when the new request must not carry earlier image context.

Open an issue if the bridge reports that ChatGPT did not accept all attachments, or if images from
a different Codex task appear. Include the daemon log lines for the failing trace and attachment stage.
Do not replace inline images with arbitrary local paths: browser-only and compaction turns
intentionally do not receive unrestricted filesystem access.

## Image generation stops before an image appears

Image generation inside the ChatGPT browser conversation is not currently a supported turn type.
ChatGPT uses a separate generation lifecycle that the text-response bridge cannot reliably prove
complete or retrieve through its current contract.

Codex's native Image Gen tool uses a different path: it sends `/v1/images/generations` or
`/v1/images/edits` through the configured Codex base URL. The bridge forwards those requests to the
native Codex backend using the incoming Codex authorization. A local `404 Not found` on these paths
in 5.0.4 or earlier is a missing bridge route, not proof of an OpenAI plugin or backend failure.
Upstream authentication and image-allowance errors remain unchanged; the ChatGPT browser connector
does not provide credentials or additional allowance for native Image Gen.

## Update, repair, and remove

To update, rerun the installer command from the README, then rerun `codex-chatgpt-web setup` with
your usual flags and add `--restart-service`. The stored login and configuration are preserved.
Configurations from releases with the desktop launcher or Zero Risk are adopted by setup; the
launcher's browser session cannot be reused, so setup signs in again.

To remove everything, run `codex-chatgpt-web uninstall --yes`. It restores Codex's previous route,
stops and removes the services, and deletes `~/.codex-chatgpt-web` (add `--keep-data` to keep it).

## Open a useful bug report

Use the repository's bug-report form. A useful report contains:

- `codex-chatgpt-web --version`, operating system, and installation method;
- Codex Desktop and/or CLI version;
- OS and architecture;
- ChatGPT account tier;
- Browser-only or Full harness mode and the exact selected model;
- exact reproduction steps and complete final error;
- whether it reproduces in a fresh Codex task; and
- the relevant daemon log lines captured immediately after that reproduction, with private data
  removed.

Screenshots are welcome, but a screenshot without the exact error and log is usually not
enough to distinguish setup, routing, browser DOM, account, and MCP failures.

Before uploading anything, read [SECURITY.md](SECURITY.md). Never publish raw logs, cookies,
browser storage, API keys, Tunnel IDs, full Codex prompts, tool output containing private data, or
absolute private paths.
