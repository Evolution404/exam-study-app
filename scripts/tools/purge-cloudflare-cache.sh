#!/usr/bin/env bash
set -u

ZONE_NAME="${CLOUDFLARE_ZONE_NAME:-980923.xyz}"
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  echo "::warning::缺少 CLOUDFLARE_API_TOKEN，跳过边缘缓存清理"
  exit 0
fi

ZONE_ID=$(curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  "https://api.cloudflare.com/client/v4/zones?name=${ZONE_NAME}" | jq -r '.result[0].id // empty')
if [[ -z "$ZONE_ID" ]]; then
  echo "::warning::无法解析 zone ${ZONE_NAME} 的 id，跳过边缘缓存清理"
  exit 0
fi

BODY=$(curl -sS -X POST -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
  -H "Content-Type: application/json" \
  --data '{"purge_everything": true}' \
  "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/purge_cache")
if jq -e '.success' <<<"$BODY" >/dev/null; then
  echo "已清除 Cloudflare 边缘缓存（zone ${ZONE_NAME}，purge_everything）"
else
  MSG=$(jq -r '.errors[0].message // "未知错误"' <<<"$BODY")
  echo "::warning::缓存清理未生效：${MSG}"
fi
