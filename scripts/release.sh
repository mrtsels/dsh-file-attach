#!/usr/bin/env bash
# release.sh — build + pack + optional GitHub release
# Usage:
#   ./scripts/release.sh              # just pack .tgz
#   ./scripts/release.sh --publish    # pack + create GitHub release with .tgz asset

set -euo pipefail

cd "$(dirname "$0")/.."

VERSION=$(node -p "require('./package.json').version")
TARBALL="dsh-file-attach-${VERSION}.tgz"

echo "🔨 Building..."
pnpm run clean 2>/dev/null || true
pnpm run build

echo "📦 Packing..."
rm -f "$TARBALL"
npm pack --ignore-scripts 2>/dev/null
echo "✅ Created $TARBALL ($(du -h "$TARBALL" | cut -f1))"

if [ "${1:-}" = "--publish" ]; then
  echo "🚀 Creating GitHub release v${VERSION}..."
  # Delete existing tag if present
  git tag -d "v${VERSION}" 2>/dev/null || true
  git tag "v${VERSION}"
  git push origin "v${VERSION}" --force

  gh release create "v${VERSION}" "$TARBALL" \
    --title "v${VERSION}" \
    --notes "Install: \`dsh plugin --profile web add ./$TARBALL\`" \
    --latest
  echo "✅ Released v${VERSION} on GitHub."
else
  echo ""
  echo "To create a GitHub release:"
  echo "  $0 --publish"
  echo ""
  echo "Users install with:"
  echo "  dsh plugin --profile web add ./$TARBALL"
fi
