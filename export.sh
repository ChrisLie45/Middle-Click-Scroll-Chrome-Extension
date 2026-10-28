#!/bin/sh
# Packages extension/ for the Chrome Web Store as dist/<name>-<version>.zip,
# with the comments stripped from its code (tools/strip-comments.py).
#
#   ./export.sh           refuses if extension/ has uncommitted changes or this
#                         version was already exported
#   ./export.sh --force   packages anyway
set -eu
cd "$(dirname "$0")"
here=$PWD

src=extension
force=false
[ "${1:-}" = "--force" ] && force=true
fail() { echo "export: $*" >&2; exit 1; }
warn() { echo "warning: $*" >&2; }

# The manifest must be valid JSON; name and version come from it.
manifest="$src/manifest.json"
[ -f "$manifest" ] || fail "$manifest not found"
plutil -convert json -o /dev/null "$manifest" 2>/dev/null || fail "$manifest is not valid JSON"
name=$(plutil -extract name raw -o - "$manifest")
version=$(plutil -extract version raw -o - "$manifest")
slug=$(echo "$name" | tr 'A-Z ' 'a-z-')
out="dist/$slug-$version.zip"

# What is uploaded should be what is committed.
if git rev-parse --is-inside-work-tree >/dev/null 2>&1 && [ -n "$(git status --porcelain -- "$src")" ]; then
  $force || fail "uncommitted changes in $src/ (commit them, or use --force):
$(git status --short -- "$src")"
  warn "packaging uncommitted changes"
fi

# Each upload needs a higher version than the last.
if [ -e "$out" ]; then
  $force || fail "$out already exists: raise \"version\" in $manifest (or use --force)"
  rm "$out"
fi

# Every file the manifest names has to be there.
for f in $(grep -oE '"[^"]+\.(js|html|png|css|json)"' "$manifest" | tr -d '"' | sort -u); do
  [ -f "$src/$f" ] || fail "$manifest refers to $f, which does not exist"
done

# Leftovers that should not ship.
if grep -rnE --include='*.js' 'console\.(log|debug)|debugger' "$src" >/dev/null 2>&1; then
  warn "debug statements found:"
  grep -rnE --include='*.js' 'console\.(log|debug)|debugger' "$src" >&2
fi

# Everything in extension/ except hidden files (.DS_Store, macOS ._ files),
# copied with the comments taken out, and the result syntax-checked.
stage=$(mktemp -d)
trap 'rm -rf "$stage"' EXIT
python3 tools/strip-comments.py "$src" "$stage/ext" || fail "could not strip comments"
jsc=/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc
if [ -x "$jsc" ]; then
  for f in "$stage"/ext/*.js; do
    "$jsc" -e "checkSyntax('$f')" || fail "stripped $(basename "$f") does not parse"
  done
else
  warn "JavaScriptCore not found: stripped scripts not syntax-checked"
fi

# COPYFILE_DISABLE keeps macOS from adding ._ files; -X drops extended attributes.
mkdir -p dist
(cd "$stage/ext" && COPYFILE_DISABLE=1 zip -q -X -r -D "$here/$out" . -x '.*' '*/.*')

echo "$name $version -> $out ($(( $(wc -c < "$out") / 1024 )) KB)"
unzip -l "$out" | sed '1,3d;$d' | sed '$d' | awk '{ print "  " $4 }'
