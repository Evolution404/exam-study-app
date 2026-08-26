#!/usr/bin/env bash
set -euo pipefail

: "${PREVIOUS_RELEASE_TAG:?PREVIOUS_RELEASE_TAG is required}"

gh release edit "$PREVIOUS_RELEASE_TAG" --repo "$GITHUB_REPOSITORY" --latest
latest_tag="$(gh api "repos/${GITHUB_REPOSITORY}/releases/latest" --jq '.tag_name')"
if [[ "$latest_tag" != "$PREVIOUS_RELEASE_TAG" ]]; then
  echo "SideStore latest 回退失败：期望 ${PREVIOUS_RELEASE_TAG}，实际 ${latest_tag}" >&2
  exit 1
fi

echo "SideStore latest 已恢复到 ${PREVIOUS_RELEASE_TAG}；失败版本资产保留用于诊断"
