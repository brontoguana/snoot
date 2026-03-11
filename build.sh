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
  bun build --compile $DEFINE src/index.ts --outfile "$OUTDIR/snoot-windows-x64.exe"
  echo "    ✓ $OUTDIR/snoot-windows-x64.exe ($(du -h "$OUTDIR/snoot-windows-x64.exe" | cut -f1))"
else
  bun build --compile $DEFINE src/index.ts --outfile "$OUTDIR/snoot-linux-x64"
  echo "    ✓ $OUTDIR/snoot-linux-x64 ($(du -h "$OUTDIR/snoot-linux-x64" | cut -f1))"
fi

echo ""
echo "Note: Native modules (resvg) require building on the target platform."
echo "Use GitHub Actions to build for all platforms: push a tag to trigger the release workflow."
echo ""
echo "  git tag v${VERSION}"
echo "  git push origin v${VERSION}"
