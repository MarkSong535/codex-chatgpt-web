<p align="center">
  <img src="assets/readme/hero.svg" width="960" alt="Codex ChatGPT Web">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.ja.md">日本語</a> · <a href="README.ko.md">한국어</a>
</p>

ChatGPT 계정에서 사용할 수 있는 Web 모델(Pro 포함)을 Codex의 기본 모델 선택기에서 사용합니다. ChatGPT Web의 별도 사용 한도를 사용합니다.

이 에디션은 **모니터가 없는 머신을 위한 명령줄 런타임**입니다. Linux에서는 일반 Google Chrome 또는 Chromium을 전용 Xvfb 가상 디스플레이에서 실행하고(ChatGPT는 헤드리스 Chrome을 거부합니다), GPU가 없는 호스트에서는 SwiftShader로 렌더링하며, 계정 이메일과 비밀번호로 로그인하고 2단계 인증 코드 입력을 돕습니다. 서버, 컨테이너, 디스플레이가 없는 머신을 위해 만들어졌으며 macOS나 Linux 데스크톱에서도 동작합니다.

## 시작하기

1. 브라우저를 설치합니다. Debian에서는 `sudo apt install chromium xvfb`. Ubuntu, Linux arm64 등에서는 런타임을 설치한 뒤 `codex-chatgpt-web browser install --with-deps`를 실행합니다(Ubuntu의 snap chromium은 사용할 수 없습니다).
2. 런타임을 설치합니다. Debian/Ubuntu에서는 최신 릴리스의 `codex-chatgpt-web_<버전>_amd64.deb`(또는 `_arm64.deb`)를 `sudo apt install ./파일.deb`로 설치할 수 있습니다(Xvfb와 Chromium도 함께 설치됩니다). 그 밖의 환경(macOS 또는 Linux, x64/arm64):

   ```bash
   curl -fsSL https://github.com/MarkSong535/codex-chatgpt-web/releases/latest/download/install.sh | sh
   ```

3. 설정하고 로그인합니다. 각 로그인 단계가 표시되며, OpenAI가 요청하면 인증 코드를 묻습니다:

   ```bash
   codex-chatgpt-web setup --browser-only --email you@example.com --acknowledge-unofficial
   ```

4. Codex를 한 번 다시 시작하고 이름이 **(Web)** 으로 끝나는 모델을 선택합니다.

## 로그인과 2단계 인증

- 이메일: `--email` 또는 `CODEX_CHATGPT_WEB_EMAIL`. 비밀번호: `--password-file` 또는 `CODEX_CHATGPT_WEB_PASSWORD`. 없으면 화면에 표시하지 않고 입력을 요청합니다. 비밀번호는 명령줄 인수로 받지 않으며 저장하지 않습니다.
- 인증 앱: `--totp-secret-file`(base32 키 또는 `otpauth://` URI)을 지정하면 코드를 자동으로 생성합니다. 지정하지 않으면 매번 코드를 묻습니다. 이메일이나 SMS 코드는 항상 터미널에서 묻습니다.
- 사람 확인(Cloudflare, Arkose)은 자동으로 처리하지 않습니다. 나중에 다시 시도하거나, 브라우저가 있는 컴퓨터에서 만든 세션을 `--import-login FILE`로 전달하세요.
- 세션이 만료되면 `codex-chatgpt-web login`으로 다시 로그인합니다.

자세한 내용(Full harness / MCP, Linux의 systemd 서비스, GPU 옵션, 보안 모델)은 [English README](README.md)를 참고하세요. 소스에서 실행하려면 Bun 1.4.0이 필요합니다.

[문제 해결](TROUBLESHOOTING.md) · [보안](SECURITY.md) · [MIT 라이선스](LICENSE)
