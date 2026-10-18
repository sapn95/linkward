// The installer the settings page hands over.
//
// "Run native/install.sh from the linkward repository" is an instruction for
// somebody who already has the repository. Most people who install this from
// the store never will, so the page builds the script itself out of the files
// the add-on carries, and the user downloads one file and runs one line.
//
// Pure. It takes the two sources as text and returns text.

/** Where Firefox looks for the manifest, and what the script has to write. */
export const HOST_NAME = 'ch.sapn.linkward';
const EXT_ID = 'linkward@sapn95.github.io';

/**
 * A single self-contained installer.
 *
 * Self-contained on purpose. A download of three files that have to stay
 * beside each other is three chances to get it wrong, and the one thing this
 * replaces is an instruction people could not follow. It writes the helper, the
 * module it imports, and the manifest Firefox reads.
 *
 * `shell` is the honest unit here rather than a platform name: macOS and Linux
 * differ only in the directory, and Windows needs PowerShell because Firefox
 * finds the manifest through the registry and will not execute a `.mjs`.
 *
 * @param {'sh'|'ps1'} shell
 * @param {{host: string, parse: string}} sources  the two files, verbatim
 */
export function installerFor(shell, sources) {
  const host = String(sources?.host ?? '');
  const parse = String(sources?.parse ?? '');
  if (!host || !parse) return '';
  return shell === 'ps1' ? powershell(host, parse) : posix(host, parse);
}

/** What to tell the user to run, once they have the file. */
export function installerCommand(shell) {
  return shell === 'ps1'
    ? 'powershell -ExecutionPolicy Bypass -File "$HOME\\Downloads\\linkward-helper.ps1"'
    : 'bash ~/Downloads/linkward-helper.sh';
}

/** The file name the download is offered under. */
export function installerFileName(shell) {
  return shell === 'ps1' ? 'linkward-helper.ps1' : 'linkward-helper.sh';
}

/**
 * Which installer this machine needs.
 *
 * From the user agent, because an extension has no OS API. Wrong is survivable:
 * both are offered on the page, and the one that does not fit simply will not
 * run. A missing answer is not — it would leave the page with no command to
 * show at all.
 */
export function shellFor(userAgent = '') {
  return /windows/i.test(String(userAgent)) ? 'ps1' : 'sh';
}

// Heredocs with a QUOTED delimiter, so nothing inside is expanded. The helper
// is JavaScript and full of `$`, backticks and `${}` — unquoted, the shell
// would eat them and write a file that no longer parses.
function posix(host, parse) {
  return `#!/usr/bin/env bash
# Installs the linkward helper, which opens a link in a browser that is not
# Firefox. A Firefox extension cannot start an application, so this is the part
# that lives outside it. It reads no page, stores nothing and makes no network
# request.
#
# Written by linkward's settings page. Safe to run again.
set -euo pipefail

case "$(uname -s)" in
  Darwin) DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  Linux)  DIR="$HOME/.mozilla/native-messaging-hosts" ;;
  *) echo "unsupported platform: $(uname -s)" >&2; exit 1 ;;
esac

NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "node is not on PATH" >&2; exit 1; }

LIB="$HOME/.local/share/linkward"
mkdir -p "$LIB" "$DIR"

cat > "$LIB/parse.mjs" <<'LINKWARD_PARSE_EOF'
${parse}
LINKWARD_PARSE_EOF

cat > "$LIB/host.mjs" <<'LINKWARD_HOST_EOF'
${host}
LINKWARD_HOST_EOF

# A wrapper with node's ABSOLUTE path, and that is the whole reason it exists.
# Firefox starts the helper with PATH=/usr/bin:/bin:/usr/sbin:/sbin — measured,
# not assumed — so an env-node shebang finds nothing wherever node
# actually lives. The symptom is "the helper is not installed", which is both
# wrong and unfixable by installing it again.
cat > "$LIB/host.sh" <<WRAP
#!/bin/sh
exec "$NODE" "$LIB/host.mjs" "\\$@"
WRAP
chmod +x "$LIB/host.sh" "$LIB/host.mjs"

cat > "$DIR/${HOST_NAME}.json" <<JSON
{
  "name": "${HOST_NAME}",
  "description": "Opens a link in another browser for linkward",
  "path": "$LIB/host.sh",
  "type": "stdio",
  "allowed_extensions": ["${EXT_ID}"]
}
JSON

echo "installed $DIR/${HOST_NAME}.json"
echo "  helper: $LIB/host.mjs"
echo "  node:   $NODE"
echo
echo "Go back to linkward's settings and press Check again."
`;
}

// Here-strings with a single-quoted delimiter, which is PowerShell's way of
// saying the same thing: no interpolation inside.
function powershell(host, parse) {
  return `# Installs the linkward helper, which opens a link in a browser that is not
# Firefox. A Firefox extension cannot start an application, so this is the part
# that lives outside it. It reads no page, stores nothing and makes no network
# request.
#
# Written by linkward's settings page. Safe to run again.
$ErrorActionPreference = 'Stop'

$Node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $Node) { Write-Error 'node is not on PATH' }

$Lib = Join-Path $env:LOCALAPPDATA 'linkward'
New-Item -ItemType Directory -Force -Path $Lib | Out-Null

$Parse = @'
${parse}
'@
$Host_ = @'
${host}
'@
Set-Content -Path (Join-Path $Lib 'parse.mjs') -Value $Parse -Encoding UTF8
Set-Content -Path (Join-Path $Lib 'host.mjs')  -Value $Host_ -Encoding UTF8

# Firefox will not execute a .mjs, so the manifest points at a wrapper.
$Wrapper = Join-Path $Lib 'host.cmd'
# node by ABSOLUTE path: Firefox starts the helper with a minimal environment,
# and a bare node is not found wherever it actually lives.
"@echo off\`r\`n\`"$Node\`" \`"$(Join-Path $Lib 'host.mjs')\`" %*" | Set-Content -Path $Wrapper -Encoding ASCII

$Manifest = Join-Path $Lib '${HOST_NAME}.json'
@{
  name               = '${HOST_NAME}'
  description        = 'Opens a link in another browser for linkward'
  path               = $Wrapper
  type               = 'stdio'
  allowed_extensions = @('${EXT_ID}')
} | ConvertTo-Json -Depth 3 | Set-Content -Path $Manifest -Encoding UTF8

# HKCU, so no administrator is needed.
$Key = 'HKCU:\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}'
New-Item -Path $Key -Force | Out-Null
Set-ItemProperty -Path $Key -Name '(Default)' -Value $Manifest

Write-Host "installed $Manifest"
Write-Host ''
Write-Host 'Go back to linkward''s settings and press Check again.'
`;
}
