#!/usr/bin/env bash
set -euo pipefail

: "${CLOUDFLARE_API_TOKEN:?CLOUDFLARE_API_TOKEN is required}"
: "${CLOUDFLARE_ACCOUNT_ID:?CLOUDFLARE_ACCOUNT_ID is required}"
: "${CLOUDFLARE_PROJECT_NAME:?CLOUDFLARE_PROJECT_NAME is required}"
: "${PREVIOUS_DEPLOYMENT_ID:?PREVIOUS_DEPLOYMENT_ID is required}"

endpoint="https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/pages/projects/${CLOUDFLARE_PROJECT_NAME}/deployments/${PREVIOUS_DEPLOYMENT_ID}/rollback"
response=$(curl -sS -X POST -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN}" \
  -H "Content-Type: application/json" "$endpoint")
if ! jq -e '.success == true' <<<"$response" >/dev/null; then
  echo "$response" >&2
  echo "Cloudflare deployment rollback failed" >&2
  exit 1
fi

echo "已通过 Cloudflare 官方 rollback API 恢复 deployment ${PREVIOUS_DEPLOYMENT_ID}"
