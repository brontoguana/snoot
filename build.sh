#!/bin/bash
set -e

cd "$(dirname "$0")"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: "//;s/".*//')
OUTDIR="dist"
mkdir -p "$OUTDIR"

echo "Building snoot v${VERSION}..."

echo "  Building for current platform..."
DEFINE="--define __SNOOT_COMPILED__=true"
if [[ "$OSTYPE" == "msys" || "$OSTYPE" == "cygwin" || "$OSTYPE" == "win32" ]]; then
  OUTFILE="$OUTDIR/snoot-windows-x64.exe"
elif [[ "$OSTYPE" == "darwin"* ]]; then
  OUTFILE="$OUTDIR/snoot-macos-arm64"
else
  OUTFILE="$OUTDIR/snoot-linux-x64"
fi
bun build --compile $DEFINE src/index.ts --outfile "$OUTFILE"
echo "    ✓ $OUTFILE ($(du -h "$OUTFILE" | cut -f1))"

echo ""
echo "Note: Native modules (resvg) require building on the target platform."
echo "Use GitHub Actions to build for all platforms: push a tag to trigger the release workflow."
echo ""
echo "  git tag v${VERSION}"
echo "  git push origin v${VERSION}"
