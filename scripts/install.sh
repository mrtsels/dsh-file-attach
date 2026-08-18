#!/usr/bin/env bash
# install.sh — one-shot installer for dsh-file-attach
# Usage: bash <(curl -fsSL https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/scripts/install.sh)
# Or:    curl -fsSL https://raw.githubusercontent.com/mrtsels/dsh-file-attach/main/scripts/install.sh | bash
#
# What it does:
#   1. Runs `dsh plugin --profile web add github:mrtsels/dsh-file-attach`
#   2. If pnpm blocks due to allowBuilds, auto-patches pnpm-workspace.yaml and retries

set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
REPO="github:mrtsels/dsh-file-attach"
PLUGIN_NAME="dsh-file-attach"

# Find the profile directory
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
PROFILE_DIR="$DSH_HOME/profiles/$PROFILE"

echo "📦 Installing $PLUGIN_NAME into profile '$PROFILE'..."

# First attempt
if dsh plugin --profile "$PROFILE" add "$REPO" 2>/tmp/dsh-plugin-add-err; then
  echo "✅ Done. Restart dsh web to load the plugin."
  exit 0
fi

STDERR=$(cat /tmp/dsh-plugin-add-err)

# Check if the error is about allowBuilds
if ! echo "$STDERR" | grep -qi "allowBuilds\|allow.*build"; then
  echo "❌ Install failed (not an allowBuilds issue):"
  echo "$STDERR"
  exit 1
fi

echo "🔧 pnpm requires allowBuilds permission. Auto-patching..."

# Ensure profile directory exists (dsh plugin add initializes it)
mkdir -p "$PROFILE_DIR"

# Find or create pnpm-workspace.yaml
WS="$PROFILE_DIR/pnpm-workspace.yaml"
if [ ! -f "$WS" ]; then
  echo "packages:" > "$WS"
  echo "  - '.'" >> "$WS"
fi

# Add allowBuilds entry if not already present
if grep -q "allowBuilds" "$WS"; then
  # Entry exists, make sure our plugin is listed
  if ! grep -q "$PLUGIN_NAME" "$WS"; then
    # Insert after allowBuilds: line
    sed -i '' "/^allowBuilds:/a\\
\\  $PLUGIN_NAME: true
" "$WS"
  fi
else
  # No allowBuilds section, append
  printf '\nallowBuilds:\n  %s: true\n' "$PLUGIN_NAME" >> "$WS"
fi

echo "✅ Patched $WS with allowBuilds."

# Retry
echo "📦 Retrying install..."
if dsh plugin --profile "$PROFILE" add "$REPO"; then
  echo "✅ Done. Restart dsh web to load the plugin."
else
  echo "❌ Install still failed after patching allowBuilds."
  exit 1
fi
