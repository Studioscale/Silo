#!/bin/bash
# Usage: ./test-tool.sh <tool_name> '<json_arguments>'
TOOL=$1
ARGS=${2:-'{}'}

# MCP requires initialize handshake first
INIT='{"jsonrpc":"2.0","id":0,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"test","version":"1.0.0"}}}'
NOTIF='{"jsonrpc":"2.0","method":"notifications/initialized"}'
CALL="{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/call\",\"params\":{\"name\":\"$TOOL\",\"arguments\":$ARGS}}"

echo -e "${INIT}\n${NOTIF}\n${CALL}" | node /root/silo-mcp/server.js 2>/dev/null | while read -r line; do
  # Only show the response to our tool call (id: 1)
  echo "$line" | python3 -c "
import sys, json
try:
  d = json.loads(sys.stdin.read())
  if d.get('id') == 1:
    # Extract the text content
    result = d.get('result', {})
    for c in result.get('content', []):
      if c.get('type') == 'text':
        parsed = json.loads(c['text'])
        print(json.dumps(parsed, indent=2))
except: pass
" 2>/dev/null
done
