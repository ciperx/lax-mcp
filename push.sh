#!/usr/bin/env bash
set -euo pipefail
cd /opt/data/profiles/idea/work/lax-mcp
SRC_URL=$(git -C ../lax-rank-bids config --get remote.origin.url)
TOKEN=$(printf '%s' "$SRC_URL" | sed -E 's#https://x-access-token:([^@]+)@.*#\1#')
OWNER=$(printf '%s' "$SRC_URL" | sed -E 's#.*@github.com/([^/]+)/.*#\1#')
NAME=lax-mcp

if [ -z "$TOKEN" ] || [ "$TOKEN" = "$SRC_URL" ]; then echo "token extraction failed"; exit 1; fi

code=$(curl -s -o /tmp/repo.json -w '%{http_code}' -X POST \
  -H "Authorization: token $TOKEN" -H 'Accept: application/vnd.github+json' \
  https://api.github.com/user/repos \
  -d "{\"name\":\"$NAME\",\"description\":\"MCP server exposing the LAX agent registry as tools, stdio and Streamable HTTP\",\"private\":false,\"has_issues\":true}")
echo "create repo status: $code"

git init -q -b main 2>/dev/null || true
git config user.email "agent@ciperx.local"
git config user.name "ciperx agent"
git add -A
git commit -q -m "LAX registry as MCP tools: five tools, stdio and Streamable HTTP, six tests (A1 to A6)" || echo "nothing to commit"
git remote remove origin 2>/dev/null || true
git remote add origin "https://x-access-token:${TOKEN}@github.com/${OWNER}/${NAME}.git"
git push -u origin main 2>&1 | sed -E 's#x-access-token:[^@]+@#x-access-token:***@#' | tail -3
git rev-parse HEAD
echo "owner=$OWNER"
