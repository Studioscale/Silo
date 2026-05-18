#!/bin/bash
# Silo MCP HTTPS Setup — run as root
# Usage: sudo bash /root/silo-mcp/setup-as-root.sh
set -euo pipefail

echo "=== Step 2: systemd service ==="

cat > /etc/systemd/system/silo-mcp.service << 'UNIT'
[Unit]
Description=Silo MCP Server
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/root/silo-mcp
EnvironmentFile=/root/silo-mcp/.env
ExecStart=/usr/local/bin/node /root/silo-mcp/server.js
Restart=always
RestartSec=5
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable silo-mcp
systemctl start silo-mcp
echo "Waiting for service to start..."
sleep 2
systemctl status silo-mcp --no-pager || true

# Verify it's listening
echo ""
echo "=== Verify service is listening ==="
curl -s http://127.0.0.1:18795/health
echo ""

echo ""
echo "=== Step 3: nginx ==="

apt install -y nginx

cat > /etc/nginx/sites-available/silo-mcp << 'NGINX'
server {
    listen 80;
    server_name silo.hsprecisao.com;
    location / {
        proxy_pass http://127.0.0.1:18795;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_read_timeout 86400;
    }
}
NGINX

ln -sf /etc/nginx/sites-available/silo-mcp /etc/nginx/sites-enabled/silo-mcp
rm -f /etc/nginx/sites-enabled/default
nginx -t
systemctl reload nginx

echo ""
echo "=== Open firewall ==="
ufw allow 80/tcp
ufw allow 443/tcp

echo ""
echo "=== Step 4: Let's Encrypt ==="
apt install -y certbot python3-certbot-nginx
certbot --nginx -d silo.hsprecisao.com --non-interactive --agree-tos -m helder@hsprecisao.com

echo ""
echo "=== Step 5: Final tests ==="
TOKEN=$(grep SILO_MCP_TOKEN /root/silo-mcp/.env | cut -d= -f2)

echo "Test: HTTPS + auth (should get MCP accept error, proving TLS + auth work):"
curl -s -X POST https://silo.hsprecisao.com/mcp \
  -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
echo ""

echo "Test: No auth (should get 401):"
curl -s https://silo.hsprecisao.com/mcp
echo ""

echo "Test: Health check:"
curl -s https://silo.hsprecisao.com/health
echo ""

echo ""
echo "=== DONE ==="
echo "Bearer token: $TOKEN"
echo "MCP endpoint: https://silo.hsprecisao.com/mcp"
