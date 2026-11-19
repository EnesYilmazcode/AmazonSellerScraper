#!/bin/sh
# Updates the proscan-ask Lambda with this folder's handler and the extension's chat.js,
# so the server builds prompts with exactly the code the extension ships.
set -e
cd "$(dirname "$0")"
tmp=$(mktemp -d)
cp index.mjs ../../scripts/lib/chat.js "$tmp/"
(cd "$tmp" && python -c "import zipfile; z=zipfile.ZipFile('ask.zip','w',zipfile.ZIP_DEFLATED); [z.write(f) for f in ('index.mjs','chat.js')]")
aws lambda update-function-code --function-name proscan-ask --zip-file "fileb://$tmp/ask.zip" --query LastUpdateStatus --output text
rm -rf "$tmp"
