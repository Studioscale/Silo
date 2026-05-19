#!/usr/bin/env bash
# Example silo-mcp deploy script for self-hosted Silo installs.
#
# Background:
#   The Silo repo bundles both the CLI (src/) and the MCP bridge
#   (silo-mcp/). When you run the MCP bridge under systemd, the
#   conventional layout on the host is:
#
#     /opt/silo/            ← git checkout of github.com/Studioscale/Silo
#     /opt/silo-mcp/        ← runtime path the systemd unit points at
#       ├── server.js         (copy of /opt/silo/silo-mcp/server.js)
#       ├── notices.js        (copy of /opt/silo/silo-mcp/notices.js)
#       ├── package.json
#       ├── package-lock.json
#       ├── node_modules/     (installed once via `npm install`)
#       └── .env              (your bearer token — never tracked in git)
#
#   This split keeps node_modules/ + .env out of the git checkout so
#   `git pull` is safe. The deploy script then copies the new JS into
#   the runtime path and restarts the service.
#
# Usage:
#   1. Edit SILO_SRC and SILO_MCP below to match your install paths.
#   2. chmod +x deploy-silo-mcp.sh
#   3. Run it manually after each silo release, or wire to a CI hook.
#
# Idempotent: a no-op `git pull` is safe; cp + restart are also safe to repeat.

set -e

# ── EDIT THESE TO MATCH YOUR LAYOUT ─────────────────────────────────────────
SILO_SRC="/opt/silo"            # git checkout of the silo repo
SILO_MCP="/opt/silo-mcp"        # runtime path the systemd unit serves
SERVICE_NAME="silo-mcp"         # systemd unit name

# ── PIPELINE ────────────────────────────────────────────────────────────────

echo "[deploy-silo-mcp] pulling latest source..."
cd "$SILO_SRC" && git pull

echo "[deploy-silo-mcp] copying *.js into runtime path..."
cp "$SILO_SRC"/silo-mcp/*.js "$SILO_MCP"/

# If package.json changed, refresh dependencies. Detect by hashing.
if ! cmp -s "$SILO_SRC/silo-mcp/package.json" "$SILO_MCP/package.json"; then
  echo "[deploy-silo-mcp] package.json changed — refreshing dependencies..."
  cp "$SILO_SRC"/silo-mcp/package.json "$SILO_MCP"/
  cp "$SILO_SRC"/silo-mcp/package-lock.json "$SILO_MCP"/ 2>/dev/null || true
  cd "$SILO_MCP" && npm install --omit=dev
fi

echo "[deploy-silo-mcp] restarting $SERVICE_NAME..."
systemctl restart "$SERVICE_NAME"
sleep 1
systemctl status "$SERVICE_NAME" --no-pager | head -10

echo "[deploy-silo-mcp] done"
