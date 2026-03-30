#!/bin/bash
set -e

REPO="brontoguana/snoot"

echo "Installing Snoot..."
echo

# Show current version if installed
if command -v snoot &>/dev/null; then
  CURRENT_VERSION=$(snoot --version 2>/dev/null || echo "unknown")
  echo "Current version: $CURRENT_VERSION"
else
  echo "No existing installation found"
fi

# Detect platform
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

if [ "$OS" = "darwin" ] && ([ "$ARCH" = "arm64" ] || [ "$ARCH" = "x86_64" ]); then
  BINARY="snoot-macos-arm64"
elif [ "$OS" = "linux" ] && [ "$ARCH" = "x86_64" ]; then
  BINARY="snoot-linux-x64"
else
  echo "This installer supports Linux x86_64 and macOS ARM64."
  echo ""
  echo "For Windows, use PowerShell:"
  echo "  irm https://raw.githubusercontent.com/brontoguana/snoot/main/install.ps1 | iex"
  echo ""
  echo "For other platforms, build from source:"
  echo "  git clone https://github.com/$REPO.git"
  echo "  cd snoot && bun install && ./build.sh"
  exit 1
fi

# Get latest release version tag from GitHub redirect
LATEST_TAG=$(curl -fsSI "https://github.com/$REPO/releases/latest" 2>/dev/null | grep -i '^location:' | grep -o 'v[0-9][^[:space:]]*' | tr -d '\r')
if [ -z "$LATEST_TAG" ]; then
  echo "Could not determine latest version"
  LATEST_TAG="latest"
fi
echo "Installing:      Snoot $LATEST_TAG"
echo

# Download release
echo "Downloading $LATEST_TAG..."
DOWNLOAD_URL="https://github.com/$REPO/releases/download/$LATEST_TAG/$BINARY"
mkdir -p "$HOME/.local/bin"
curl -fsSL -o "$HOME/.local/bin/snoot" "$DOWNLOAD_URL"
chmod +x "$HOME/.local/bin/snoot"
echo "✓ Installed to ~/.local/bin/snoot"

# Check for supported AI CLIs
FOUND_CLI=0
for cli in claude gemini codex; do
  if command -v "$cli" &>/dev/null; then
    echo "✓ $cli CLI found"
    FOUND_CLI=1
  fi
done
if [ "$FOUND_CLI" = "0" ]; then
  echo "⚠ No AI CLI found (claude, gemini, or codex)"
  echo "  Install one: npm install -g @anthropic-ai/claude-code"
  echo "  Or configure an OpenAI-compatible endpoint after install."
fi

# Ensure ~/.local/bin is in PATH for this session and future shells
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo
  echo "⚠ ~/.local/bin is not in your PATH. Add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# Ensure claude is discoverable: add ~/.local/bin to shell profile if not present
for profile in "$HOME/.bashrc" "$HOME/.zshrc" "$HOME/.profile"; do
  if [ -f "$profile" ] && ! grep -q 'export PATH=.*\.local/bin' "$profile" 2>/dev/null; then
    echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$profile"
    echo "✓ Added ~/.local/bin to PATH in $(basename "$profile")"
    break
  fi
done

# Confirm installed version
echo
INSTALLED=$("$HOME/.local/bin/snoot" --version 2>/dev/null || echo "unknown")
echo "Installed:       $INSTALLED"
echo
echo "Next steps:"
echo "  snoot setup session <session-id>         # one-time setup"
echo "  cd /your/project && snoot MyChannel      # start a channel"
echo
