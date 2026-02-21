#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Installing dependencies..."
bun install

echo "Type checking..."
bun x tsc --noEmit

echo "Build complete."
