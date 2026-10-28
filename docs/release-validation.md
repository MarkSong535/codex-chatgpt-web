# Release validation

CI proves that the runtime builds, its relocated bundle starts, and the test suite passes on macOS,
Windows, and Linux. It does not prove an authenticated ChatGPT session, a live MCP connector, or a
complete Codex turn. A release candidate is not ready until those account-bound flows are exercised
manually on the platforms below.

## Preview releases

Use GitHub's **Set as a pre-release** flag for public test builds. They remain downloadable from
Releases but are excluded from `/releases/latest`, the endpoint the installer uses. A draft is
private; a pre-release is the public testing option.

The tag workflow marks new suffixed versions such as `v6.0.0-rc.1` as pre-releases automatically
and preserves an existing release's pre-release flag when rerun. Use a new version for changed
binaries; toggling publication flags promotes the existing build. To keep a final version out of
`/releases/latest` during testing, prepare a draft release with **Set as a pre-release** checked
before pushing its tag.

GitHub documents this contract in [Get the latest release](https://docs.github.com/en/rest/releases/releases#get-the-latest-release).

## Required evidence

Record the release version, operating-system version and architecture, Chrome or Chromium version,
whether the host has a GPU, install path (`clean` or `upgrade`), ChatGPT plan, Codex version, result
of each check, and redacted daemon log lines for every failure. Never capture cookies, tunnel IDs,
API keys, bearer tokens, passwords, TOTP secrets, or prompt contents.

## Linux server gate

Run this list on a Linux x64 server without a display or GPU, and repeat items 1 to 4 on arm64:

1. Install the `.deb` with `apt` on a clean Debian or Ubuntu host and prove that it pulls in Xvfb
   and a browser, and that `codex-chatgpt-web --version`, `browser check`, and `doctor`'s display
   check succeed. Repeat with `install.sh` on another distribution.
2. Run setup with an account that has an authenticator: once typing the code, once with
   `--totp-secret-file`. Prove that every `[n/7]` step is reported and a new chat is verified.
3. Repeat sign-in with an account that receives an email code and prove the code is requested in the
   terminal. Prove that a wrong code is reported and a correct retry succeeds.
4. Restart Codex and prove that every account-available ChatGPT Web effort appears exactly once
   without removing native models. Complete one Browser-only turn and verify streamed commentary plus
   the final answer.
5. Configure the `Codex Native2` connector and complete one Full-mode local tool turn. Repeat with
   Pro when the account exposes Pro.
6. Drive a chat past the compaction threshold and prove that it continues after compaction without a
   duplicate or orphaned browser turn.
7. Cancel a running turn from Codex and prove that the tab closes and the daemon becomes idle.
8. Log out, confirm with lingering enabled that the systemd user services keep running, and reboot
   to prove they start again.
9. In a container without systemd, prove that setup completes, prints the foreground commands, and
   that `serve` and `tunnel run` work when started by hand.
10. Upgrade from the previous public release and prove that the stored login, Codex settings, and MCP
    configuration survive.

Any failed or unexecuted item blocks a stable release. An alpha may ship with a named failed item
only when the release notes describe the limitation and recovery path explicitly.

## macOS gate

Repeat items 1, 2, 4, 5, 6, 7 and 10 on the oldest supported macOS version or the closest
maintained machine, with launchd in place of systemd.
