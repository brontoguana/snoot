#!/bin/bash
set -e

echo "Installing Snoot..."
echo

# 1. Install bun if missing
if command -v bun &>/dev/null; then
  echo "✓ Bun found: $(bun --version)"
else
  echo "Installing Bun..."
  curl -fsSL https://bun.sh/install | bash
  export BUN_INSTALL="$HOME/.bun"
  export PATH="$BUN_INSTALL/bin:$PATH"
  echo "✓ Bun installed: $(bun --version)"
fi

# 2. Check for Claude CLI
if command -v claude &>/dev/null; then
  echo "✓ Claude CLI found"
else
  echo "✗ Claude CLI not found"
  echo "  Install it: npm install -g @anthropic-ai/claude-code"
  echo "  Snoot will work once claude is on your PATH."
fi

# 3. Install dependencies
echo
echo "Installing dependencies..."
SNOOT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SNOOT_DIR"
bun install
echo "✓ Dependencies installed"

# 4. Create global wrapper
BUN_PATH="$(command -v bun)"
WRAPPER="$HOME/.local/bin/snoot"
mkdir -p "$HOME/.local/bin"
cat > "$WRAPPER" << EOF
#!/bin/bash
exec "$BUN_PATH" "$SNOOT_DIR/src/index.ts" "\$@"
EOF
chmod +x "$WRAPPER"
echo "✓ Created $WRAPPER"

# Check PATH
if [[ ":$PATH:" != *":$HOME/.local/bin:"* ]]; then
  echo
  echo "⚠ ~/.local/bin is not in your PATH. Add this to your shell profile:"
  echo "  export PATH=\"\$HOME/.local/bin:\$PATH\""
fi

# 5. Done
echo
echo "Done! Next steps:"
echo "  snoot set-user <your-session-id>    # one-time setup"
echo "  cd /your/project && snoot MyChannel  # start a channel"
echo
