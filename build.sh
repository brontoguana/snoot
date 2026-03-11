#!/bin/bash
set -e

cd "$(dirname "$0")"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: "//;s/".*//')
OUTDIR="dist"
mkdir -p "$OUTDIR"

echo "Building snoot v${VERSION}..."

echo "  Linux x64..."
bun build --compile src/index.ts --outfile "$OUTDIR/snoot-linux-x64"
echo "    ✓ $OUTDIR/snoot-linux-x64 ($(du -h "$OUTDIR/snoot-linux-x64" | cut -f1))"

echo "  Windows x64..."
bun build --compile --target bun-windows-x64 src/index.ts --outfile "$OUTDIR/snoot-windows-x64.exe"
echo "    ✓ $OUTDIR/snoot-windows-x64.exe ($(du -h "$OUTDIR/snoot-windows-x64.exe" | cut -f1))"

echo ""
echo "To create a GitHub release (with installer, via GitHub Actions):"
echo "  git tag v${VERSION}"
echo "  git push origin v${VERSION}"
echo "  # The release workflow builds binaries + Windows installer automatically"
echo ""
echo "To create a release manually (without installer):"
echo "  gh release create v${VERSION} $OUTDIR/snoot-linux-x64 $OUTDIR/snoot-windows-x64.exe --title \"v${VERSION}\""
