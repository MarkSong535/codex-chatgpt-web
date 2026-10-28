<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Codex ChatGPT Web">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

ChatGPT アカウントで利用できる Web モデル（Pro を含む）を Codex のネイティブなモデル選択から使えます。ChatGPT Web 側の利用枠を使用します。

このエディションは**モニターのないマシン向けのコマンドラインランタイム**です。Linux では通常の Google Chrome または Chromium を専用の Xvfb 仮想ディスプレイ上で動かし（ChatGPT はヘッドレスの Chrome を拒否します）、GPU のないホストでは SwiftShader で描画し、アカウントのメールアドレスとパスワードでサインインし、2 段階認証コードの入力を支援します。サーバー、コンテナ、ディスプレイのないマシン向けで、macOS や Linux のデスクトップでも動作します。

## はじめに

1. ブラウザをインストールします。Debian では `sudo apt install chromium xvfb`。Ubuntu や Linux arm64 などでは、ランタイムをインストールした後に `codex-chatgpt-web browser install --with-deps` を実行します（Ubuntu の snap 版 chromium は使えません）。
2. ランタイムをインストールします。Debian/Ubuntu では最新リリースの `codex-chatgpt-web_<バージョン>_amd64.deb`（または `_arm64.deb`）を `sudo apt install ./ファイル名.deb` でインストールできます（Xvfb と Chromium も入ります）。その他（macOS または Linux、x64/arm64）:

   ```bash
   curl -fsSL https://github.com/MarkSong535/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ```

3. セットアップしてサインインします。各ステップが表示され、OpenAI が要求したときに確認コードを尋ねます:

   ```bash
   codex-chatgpt-web setup --browser-only --email you@example.com --acknowledge-unofficial
   ```

4. Codex を一度再起動し、**(Web)** で終わるモデルを選びます。

## サインインと 2 段階認証

- メール: `--email` または `CODEX_CHATGPT_WEB_EMAIL`。パスワード: `--password-file` または `CODEX_CHATGPT_WEB_PASSWORD`。指定がなければ非表示で入力を求めます。パスワードはコマンドライン引数では受け付けず、保存もしません。
- 認証アプリ: `--totp-secret-file`（base32 キーまたは `otpauth://` URI）を渡すとコードを自動生成します。渡さない場合は毎回入力を求めます。メールや SMS のコードは常に端末で尋ねます。
- 人間確認（Cloudflare、Arkose）は自動では処理しません。時間をおいて再試行するか、ブラウザのあるコンピューターで作成したセッションを `--import-login FILE` で渡してください。
- セッションが切れたら `codex-chatgpt-web login` で再サインインします。

詳細（Full harness / MCP、Linux の systemd サービス、GPU オプション、セキュリティモデル）は [English README](README.md) を参照してください。ソースから実行するには Bun 1.4.0 が必要です。

[トラブルシューティング](TROUBLESHOOTING.md) · [セキュリティ](SECURITY.md) · [MIT ライセンス](LICENSE)
