# Architecture

```text
Codex app / CLI
      │ Responses API on loopback
      ▼
codex-chatgpt-web daemon (launchd agent or systemd --user unit)
  ├─ official /models passthrough + fixed ChatGPT Web models
  ├─ native Responses passthrough or ChatGPT Responses/SSE bridge
  ├─ authenticated native Search and Image Gen request forwarding
  ├─ ChatGPT browser worker (Chrome on a private Xvfb display, up to five tabs)
  ├─ capability broker (full mode only)
  └─ stdio MCP server
            ▲
            │ outbound OpenAI Tunnel (launchd agent or systemd --user unit)
            ▼
      ChatGPT custom connector
```

## Modes

### `browser-only`

- Exposes `GPT-5.6 Luna (Web)` with ordinary/Think effort on Luna-only accounts. Sol-capable accounts
  get `GPT-5.6 Sol Instant (Web)` and `GPT-5.6 Sol (Web)` with Medium/High and available Extra High.
  Pro-capable accounts also get separate `GPT-5.6 Pro (Web)` and `GPT-6 Pro (Web)` rows.
- Instant retains its own context budget. Grouped efforts must have identical context and compaction
  limits; catalog generation rejects a mismatch rather than reducing a budget. Pro rows use the
  native `max` effort; `ultra` is not used for new rows because Codex transforms it before transport.
- Named Sol/Pro routes select the exact browser family and verify it again before every Send.
  Latest must identify version 6 for a GPT-6 Pro response. Its existing lower-effort multipart
  acknowledgements identify 5.6, then the final part returns to verified 6 Pro. No version fallback.
- Pre-6.0 slugs remain hidden catalog entries with their original fixed bindings, including the
  unpinned `chatgpt-web/pro`. They keep old tasks and cached selections working. The existing release
  upgrade reruns integration setup and invalidates the model cache; Codex must restart for the new
  picker. Native models and existing context/compaction budgets are preserved.
- Sends the complete Codex context and image attachments to a fresh ChatGPT conversation (saved in ChatGPT history).
- Never starts the broker, tunnel, or MCP server.
- Emits a nonfatal Codex commentary warning that local tools are unavailable for the selected model.

### `full`

- Exposes the same models and attaches the turn-bound connector capability to every available
  effort, from Luna through Pro. There are no effort-specific MCP exclusions.
- ChatGPT uses a custom MCP connector backed by `openai/tunnel-client`.
- Every connector call presents one outer Codex turn capability; the MCP server keeps the derived
  binding private and dispatches the requested action immediately.
- When Codex exposes tools behind its code-mode `exec` gateway, the connector discovers their
  runtime registry and can invoke an exact listed name through bridge-owned code. Full mode also
  preserves Codex's native freeform `exec`; its tool registry enforces the same bounded
  `wait_agent` contract as direct and structured calls.
- Tool calls and results remain in the same ChatGPT response while Codex executes them locally.

## Chrome and the virtual display

ChatGPT's bot protection answers headless Chrome with HTTP 403, so Chrome always runs as an
ordinary browser. On Linux the first launch in a process starts a private Xvfb server
(`-displayfd`, `-nolisten tcp`) and Chrome renders into it; the server lives as long as the process
and is stopped with it. Without Xvfb an existing `DISPLAY` is used, and a host with neither fails
with an install hint. On macOS Chrome opens an ordinary window.

The daemon launches the configured Chrome or Chromium through Playwright with the stored ChatGPT
storage state. One browser process serves maintenance checks and every turn;
each turn opens its own tab, starts a new ChatGPT chat, and closes the tab when the turn settles. A
sixth concurrent turn fails explicitly; the cap avoids excessive parallel traffic that could trigger
account abuse controls. After a completed turn the refreshed storage state is written back so the
session stays current.

GPU selection is resolved per launch. `auto` uses ANGLE's SwiftShader backend
(`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`) on the virtual display and on
Linux hosts without a DRM render node, so WebGL and compositing work without a GPU; `software` forces this and `hardware`
leaves the choice to Chrome. Linux launches always add `--disable-dev-shm-usage`, and `--no-sandbox`
only when running as root, which Chrome otherwise refuses.

Browser submission and response binding use ChatGPT's logical `data-turn-id`, not the
`conversation-turn-N` display index, which can change during rendering. The submission baseline
includes the persistent `data-turn-id-container` wrappers of virtualized history. Remounting old
messages therefore cannot count as a new submission or another user's turn. Missing or duplicate
logical identities fail explicitly; accepted messages are never resent to repair their DOM.

The current compiled Codex task context is inserted as one inline JSON envelope. Image bytes stay
out of the JSON and are attached natively with stable references. The runtime does not create a
context JSONL file, upload a synthetic context document, include prompt hashes, or silently truncate
the envelope. Attachment acceptance and send readiness are verified before the turn begins.

## Sign-in

`setup` and `login` sign in with an account email and password in a fresh browser context. A small
state machine reads which sign-in page is showing (ChatGPT landing, email, password, verification
code, human-verification challenge, or signed in), acts on it, and waits for the page to change or
for OpenAI to show an error. Each transition is reported as one of seven numbered steps.

Verification codes come from a TOTP secret (RFC 6238, base32 or `otpauth://`) when the page asks for
an authenticator code, and otherwise from the terminal; email and SMS codes always come from the
terminal. A retry after a rejected TOTP code waits for the next time step. Credentials are read from
files, environment variables, or no-echo prompts, never from command-line arguments, and are not
persisted. Human-verification challenges end the attempt with a screenshot; they are never solved
automatically.

A successful sign-in is accepted only when ChatGPT's own session endpoint reports a user, the new-chat
composer is visible, and the account capability probe completes. The storage state is then reduced
to ChatGPT/OpenAI cookies and ChatGPT local storage and written owner-only with a verification
marker. `--import-login` accepts a Playwright storage state captured elsewhere, applies the same
reduction, and verifies it in Chrome before saving.

## Context and compaction

The appended models advertise the authenticated account's context window and a ten-percent
auto-compaction reserve. Usage is counted with the GPT-5 tokenizer plus fixed platform/image
reserves, rather than inferred from character length. The ChatGPT composer also has an independent
inline-size boundary: usage accounting asks Codex to compact before that boundary, and a prompt
that still exceeds the proven hard ceiling fails explicitly before any browser turn opens.
Top-level `model_context_window` raises only the proxied native rows' advertised maximum, allowing
Codex to apply its own configured context override without clamping. Routed ChatGPT Web models
retain their measured adapter-owned limits.

Every task turn uses an ordinary saved ChatGPT conversation, opened fresh for that turn with the
complete canonical Codex context. ChatGPT memory and custom instructions may apply to these
conversations. Saved history does not authorize reopening an arbitrary ChatGPT conversation.

Bigger Context partitions complete ordered records against each message's available token and
composer budgets. Inert stages carry text; the final message also carries all retained attachments,
the execution contract and any output schema. Their reserves are deducted before partitioning,
then preflight checks the actual compiled messages and total transaction. The selected execution
effort and attachment references remain unchanged. Large transactions use up to six messages;
the advertised context and compaction thresholds remain three times the base limits. More parts
reduce message size, not the amount of history retained.

Compaction runs as a read-only summarization turn in its own fresh chat, built from canonical Codex
history, then returns the native replacement-history shape expected by Codex. A prompt-level
checkpoint marker is translated into a visible Codex trace item; every later tool action in the same
turn continues to present the current turn capability. Visible ChatGPT status rows become reasoning
summaries, while stable prose between rows becomes native Codex commentary.

## Installation and service lifecycle

The release runtime is a relocatable directory containing a platform-matched pinned Bun executable,
the bundled CLI, and its production dependencies, described by a manifest of every file's path, size,
and SHA-256. Linux releases also wrap the same runtime in a Debian package that installs it under
`/opt/codex-chatgpt-web`, links `/usr/bin/codex-chatgpt-web`, and depends on Xvfb. The terminal
installer verifies the archive against the release checksum manifest before installing it under
`~/.local/lib/codex-chatgpt-web`. No browser is downloaded; Chrome or Chromium is
supplied by the host. Full mode separately downloads the official pinned `openai/tunnel-client` build
for the current OS/architecture and verifies it against the release SHA-256 manifest.

The daemon and tunnel run as launchd agents on macOS and as `systemd --user` units on Linux, both with
restart-on-exit. On Linux without a user service manager, setup commits the configuration and Codex
integration, starts nothing, and reports the foreground commands to supervise (`serve` and
`tunnel run`).

Setup keeps Codex's built-in `openai` provider. It routes Responses through the local daemon with
`openai_base_url`, while pinning `experimental_realtime_webrtc_call_base_url` to Codex's official
ChatGPT endpoint so Voice session creation never falls through to the Responses-only bridge. Both
assignments are journaled and restored exactly on disconnect or uninstall; a conflicting existing
Voice route requires explicit `--replace-codex-route` ownership. The daemon forwards the
authenticated official model catalog and appends only the routed models owned by the
`chatgpt-web/` namespace; no static catalog is installed. Subagent protocol selection is explicit,
and new installations default to Compatibility V1 because it is the only surface portable across
native and routed Web backends:

- **Compatibility V1** pins every delegation-capable native and routed row to V1 and atomically
  manages `multi_agent = true`, `multi_agent_v2 = false`, and `[agents].max_depth` of at least 2 so
  a routed child can spawn a routed grandchild. The integration journal preserves the user's prior
  scalar, structured-feature, and agent-depth lines and restores them byte-for-byte on disconnect,
  native-mode selection, or uninstall. The ChatGPT connector projects `wait_agent` as an explicit
  10-second polling contract: terminal semantics stay native, while every non-terminal poll releases
  the serialized MCP channel so Web children can run their own harness tools.
- **Native** preserves every official native row and gives routed rows the selected template's
  protocol surface. Under MultiAgent V2, Web-origin `spawn_agent`, `send_message`, and
  `followup_task` calls include Codex's explicit `encrypted_function_args: []` plaintext marker.
  A genuinely encrypted native-to-Web payload is rejected with one HTTP 400 before a browser is
  opened; it is never turned into an SSE disconnect/retry loop.

Catalog metadata alone never claims to change an existing task's protocol. Codex pins the protocol
when a task starts, and its global `multi_agent_v2` override wins over per-model metadata. Switching
protocol therefore requires restarting Codex and starting a new task. Model choice, effort,
context, and service tiers are otherwise unchanged.

The built-in provider attempts a Responses WebSocket prewarm. The local route explicitly returns
HTTP `426`, which is Codex's native capability-negotiation signal for an immediate, session-sticky
switch to its HTTP/SSE transport. No model or provider fallback occurs.

Setup never restarts an already loaded daemon implicitly. A requested stop, restart, replacement,
or uninstall first calls a private authenticated drain endpoint. The daemon rejects new turns and
reports two independent counters:

- active HTTP requests, including native compaction, Search, and Image Gen forwarding;
- active ChatGPT browser sessions, including time spent waiting for local Codex tool results.

The lifecycle operation proceeds only when both counters are zero. Setup then stops or restarts the
service through launchd or systemd. If the contract is unavailable, malformed, non-idle, or cannot
be completed, the operation fails closed and restores the drained runtime when possible.

## Security invariants

Native task recovery normally uses the bridge's own `CODEX_HOME`. An operator can register up to
seven additional local homes through `CODEX_CHATGPT_WEB_TRUSTED_CODEX_HOMES`, a JSON array of absolute
existing directories. Request data cannot register homes. Directory aliases are canonicalized;
the resolver establishes one owning home before reading the current turn's permissions and rejects
duplicate thread ownership. Each secondary home uses its own `sqlite_home` configuration, without
inheriting the primary process's SQLite override. With multiple homes, every turn needs current
native proof and the legacy single-home environment cache is neither read nor written. See [setup details](../TROUBLESHOOTING.md#a-second-codex_home-fails-with-missing-network-access-in-trusted-codex-environment-context).

- Bind the Responses proxy and health endpoint to loopback only.
- Store browser state and tunnel credentials under the application home with mode `0600`.
- Protect lifecycle control endpoints with a random application-owned bearer token.
- Never place secret values in command-line arguments, logs, generated profiles, or Git.
- Limit browser turns to five independent task-bound tabs and reject unsupported models explicitly.
  The selected routed model fixes the adapter effort; a conflicting request effort cannot change it.
- Do not retry or switch modes to evade product usage limits.

See the complete [security model](security-model.md).
