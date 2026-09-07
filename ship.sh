#!/usr/bin/env bash
# Build, package, and install task-beacon in one shot.
# Sideloaded (vsix) extensions get no marketplace auto-update — this script
# is the manual replacement. Run after any src/ change you want reflected
# in the running VS Code window.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

REPO_URL=$(node -p "require('./package.json').repository.url")
VERSION=$(node -p "require('./package.json').version")
NAME=$(node -p "require('./package.json').name")
# repo url -> host + owner + repo
HOST_OWNER_REPO=$(node -e "
  const m = /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+?)(?:\.git)?\$/.exec(process.argv[1]);
  if (!m) process.exit(1);
  console.log(m.slice(1).join(' '));
" "$REPO_URL")
read -r HOST OWNER REPO <<< "$HOST_OWNER_REPO"

npm run build

npx vsce package \
  --baseContentUrl "https://${HOST}/${OWNER}/${REPO}/blob/master" \
  --baseImagesUrl "https://${HOST}/${OWNER}/${REPO}/raw/master"

VSIX="${NAME}-${VERSION}.vsix"
code --install-extension "$VSIX" --force
echo "installed (stable): $(code --list-extensions --show-versions | grep "^YangKangSung.${NAME}@")"

if command -v code-insiders &> /dev/null; then
  code-insiders --install-extension "$VSIX" --force
  echo "installed (insiders): $(code-insiders --list-extensions --show-versions | grep "^YangKangSung.${NAME}@")"
fi
