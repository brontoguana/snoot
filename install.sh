#!/bin/bash
set -e

REPO="brontoguana/snoot"

echo "Installing Snoot..."
echo

# Detect platform
ARCH=$(uname -m)
OS=$(uname -s | tr '[:upper:]' '[:lower:]')

if [ "$ARCH" != "x86_64" ] || [ "$OS" != "linux" ]; then
  echo "Pre-built binaries are only available for Linux x86_64."
  echo "For other platforms, build from source:"
  echo "  git clone https://github.com/$REPO.git"
  echo "  cd snoot && bun install && ./build.sh"
  exit 1
fi

# Download latest release
echo "Downloading latest release..."
DOWNLOAD_URL="https://github.com/$REPO/releases/latest/download/snoot-linux-x64"
mkdir -p "$HOME/.local/bin"
curl -fsSL -o "$HOME/.local/bin/snoot" "$DOWNLOAD_URL"
chmod +x "$HOME/.local/bin/snoot"
echo "✓ Installed to ~/.local/bin/snoot"

# Check for Claude CLI
if command -v claude &>/dev/null; then
  echo "✓ Claude CLI found"
else
  echo "⚠ Claude CLI not found"
  echo "  Install it: npm install -g @anthropic-ai/claude-code"
  echo "  Snoot will work once claude is on your PATH."
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

echo
echo "Done! Next steps:"
echo "  snoot set-user <recipient-session-id>    # one-time setup"
echo "  cd /your/project && snoot MyChannel  # start a channel"
echo
