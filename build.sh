#!/bin/bash
set -e

cd "$(dirname "$0")"

VERSION=$(grep '"version"' package.json | head -1 | sed 's/.*: "//;s/".*//')
OUTDIR="dist"
mkdir -p "$OUTDIR"

echo "Building snoot v${VERSION}..."
bun build --compile src/index.ts --outfile "$OUTDIR/snoot-linux-x64"
echo "✓ Built $OUTDIR/snoot-linux-x64 ($(du -h "$OUTDIR/snoot-linux-x64" | cut -f1))"

echo ""
echo "To create a GitHub release:"
echo "  git tag v${VERSION}"
echo "  git push origin v${VERSION}"
echo "  gh release create v${VERSION} $OUTDIR/snoot-linux-x64 --title \"v${VERSION}\""
