#!/usr/bin/env bash
set -euo pipefail

SNOOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENTRY="$SNOOT_DIR/src/index.ts"
INSTALL_DIR="${HOME}/.local/bin"

# Build first
"$SNOOT_DIR/scripts/build.sh"

# Ensure install dir exists
mkdir -p "$INSTALL_DIR"

# Create wrapper script that runs from the snoot directory
# so that bun can find node_modules
cat > "$INSTALL_DIR/snoot" <<WRAPPER
#!/usr/bin/env bash
exec bun "$ENTRY" "\$@"
WRAPPER

chmod +x "$INSTALL_DIR/snoot"

echo ""
echo "Installed snoot to $INSTALL_DIR/snoot"

# Verify it's on PATH
if command -v snoot &>/dev/null; then
  echo "Ready to use: snoot <channel> --user <session-id>"
else
  echo "Warning: $INSTALL_DIR is not on your PATH."
  echo "Add this to your shell profile:"
  echo "  export PATH=\"$INSTALL_DIR:\$PATH\""
fi
