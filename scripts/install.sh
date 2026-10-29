#!/bin/sh
set -eu

REPOSITORY="${CODEX_CHATGPT_WEB_REPOSITORY:-MarkSong535/codex-chatgpt-web}"
VERSION="${CODEX_CHATGPT_WEB_VERSION:-1.0.2}"
BIN_DIR="${CODEX_CHATGPT_WEB_BIN_DIR:-$HOME/.local/bin}"
LIB_DIR="${CODEX_CHATGPT_WEB_LIB_DIR:-$HOME/.local/lib/codex-chatgpt-web}"
DOC_DIR="${CODEX_CHATGPT_WEB_DOC_DIR:-$HOME/.local/share/doc/codex-chatgpt-web}"

case "$(uname -s)" in
  Darwin) PLATFORM="darwin" ;;
  Linux) PLATFORM="linux" ;;
  *) echo "This installer supports macOS and Linux; on Windows run from source" >&2; exit 1 ;;
esac

case "$(uname -m)" in
  arm64|aarch64) ARCH="arm64" ;;
  x86_64|amd64) ARCH="amd64" ;;
  *) echo "Unsupported architecture: $(uname -m)" >&2; exit 1 ;;
esac

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{ print $1 }'
  else shasum -a 256 "$1" | awk '{ print $1 }'
  fi
}

ASSET="codex-chatgpt-web-$PLATFORM-$ARCH.tar.gz"
# Releases of this headless edition are tagged vm<version> to stay apart from upstream v<version> tags.
BASE_URL="https://github.com/$REPOSITORY/releases/download/vm$VERSION"
TEMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/codex-chatgpt-web.XXXXXX")"
STAGE_DIR="$LIB_DIR/.stage-$VERSION-$$"
TARGET_DIR="$LIB_DIR/$VERSION"
BACKUP_DIR="$LIB_DIR/.previous-$VERSION-$$"
trap 'rm -rf "$TEMP_DIR" "$STAGE_DIR"' EXIT HUP INT TERM

curl -fsSL "$BASE_URL/$ASSET" -o "$TEMP_DIR/$ASSET"
curl -fsSL "$BASE_URL/checksums.txt" -o "$TEMP_DIR/checksums.txt"

EXPECTED="$(awk -v asset="$ASSET" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
ACTUAL="$(sha256 "$TEMP_DIR/$ASSET")"
if [ -z "$EXPECTED" ] || [ "$ACTUAL" != "$EXPECTED" ]; then
  echo "SHA-256 verification failed for $ASSET" >&2
  exit 1
fi

for DOC in LICENSE Bun-1.4.0.md THIRD_PARTY_NOTICES.txt; do
  curl -fsSL "$BASE_URL/$DOC" -o "$TEMP_DIR/$DOC"
  DOC_EXPECTED="$(awk -v asset="$DOC" '$2 == asset { print $1 }' "$TEMP_DIR/checksums.txt")"
  DOC_ACTUAL="$(sha256 "$TEMP_DIR/$DOC")"
  if [ -z "$DOC_EXPECTED" ] || [ "$DOC_ACTUAL" != "$DOC_EXPECTED" ]; then
    echo "SHA-256 verification failed for $DOC" >&2
    exit 1
  fi
done

mkdir -p "$LIB_DIR" "$BIN_DIR" "$DOC_DIR"
mkdir "$STAGE_DIR"
tar -xzf "$TEMP_DIR/$ASSET" -C "$STAGE_DIR"
if [ ! -x "$STAGE_DIR/bin/codex-chatgpt-web" ] || [ ! -x "$STAGE_DIR/runtime/bun" ]; then
  echo "Runtime archive is incomplete" >&2
  exit 1
fi
if [ "$("$STAGE_DIR/bin/codex-chatgpt-web" --version)" != "$VERSION" ]; then
  echo "Runtime archive version does not match $VERSION" >&2
  exit 1
fi

if [ -e "$TARGET_DIR" ]; then
  mv "$TARGET_DIR" "$BACKUP_DIR"
fi
if ! mv "$STAGE_DIR" "$TARGET_DIR"; then
  if [ -e "$BACKUP_DIR" ]; then mv "$BACKUP_DIR" "$TARGET_DIR"; fi
  exit 1
fi

ln -sfn "$TARGET_DIR/bin/codex-chatgpt-web" "$BIN_DIR/.codex-chatgpt-web.next"
mv -f "$BIN_DIR/.codex-chatgpt-web.next" "$BIN_DIR/codex-chatgpt-web"
rm -f "$BIN_DIR/codex-chatgpt-web.legacy-standalone"
for DOC in LICENSE Bun-1.4.0.md THIRD_PARTY_NOTICES.txt; do
  install -m 0644 "$TEMP_DIR/$DOC" "$DOC_DIR/$DOC"
done
if [ -e "$BACKUP_DIR" ]; then rm -rf "$BACKUP_DIR"; fi

echo "Installed $TARGET_DIR"
if [ "$#" -gt 0 ]; then
  "$TARGET_DIR/bin/codex-chatgpt-web" setup "$@"
  exit 0
fi
echo "Next: $BIN_DIR/codex-chatgpt-web setup --browser-only --email you@example.com --acknowledge-unofficial"
