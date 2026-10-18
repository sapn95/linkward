#!/usr/bin/env bash
# Install the native messaging helper for linkward.
#
# A Firefox extension cannot start another application. This registers a small
# node script with Firefox so the picker can hand a link to a browser that is
# not Firefox. Nothing else goes through it: the helper lists installed browsers
# and runs `open -a`, and it reads nothing and sends nothing anywhere.
#
# Safe to run again. It rewrites the manifest and nothing else.
set -euo pipefail

NAME="ch.sapn.linkward"
EXT_ID="linkward@sapn95.github.io"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
HOST="$HERE/host.mjs"

# Firefox reads the manifest from this directory on macOS. Linux puts it in
# ~/.mozilla/native-messaging-hosts; the path is the only difference.
case "$(uname -s)" in
  Darwin) DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  Linux)  DIR="$HOME/.mozilla/native-messaging-hosts" ;;
  *)
    echo "unsupported platform: $(uname -s)" >&2
    echo "On Windows run native/install.ps1 in PowerShell instead." >&2
    exit 1
    ;;
esac

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node is not on PATH; the helper is a node script" >&2; exit 1; }
[ -f "$HOST" ] || { echo "missing $HOST" >&2; exit 1; }

mkdir -p "$DIR"

# A wrapper with node's ABSOLUTE path, and this is the whole reason it exists.
# Firefox starts the helper with PATH=/usr/bin:/bin:/usr/sbin:/sbin — measured,
# not assumed — so `#!/usr/bin/env node` finds nothing wherever node actually
# lives, and the helper never starts. The symptom is "the helper is not
# installed", which is both wrong and unfixable by installing it again.
WRAPPER="$HERE/host.sh"
cat > "$WRAPPER" <<WRAP
#!/bin/sh
exec "$NODE" "$HOST" "\$@"
WRAP
chmod +x "$WRAPPER" "$HOST"

# The path is absolute and written at install time: Firefox starts the helper
# itself, from no particular working directory.
cat > "$DIR/$NAME.json" <<JSON
{
  "name": "$NAME",
  "description": "Opens a link in another browser for linkward",
  "path": "$WRAPPER",
  "type": "stdio",
  "allowed_extensions": ["$EXT_ID"]
}
JSON

echo "installed $DIR/$NAME.json"
echo "  helper: $HOST"
echo "  node:   $NODE"
echo
echo "Now switch it on in linkward's settings. Firefox asks for the"
echo "\"nativeMessaging\" permission at that point, not at install."
