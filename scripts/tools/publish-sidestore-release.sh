#!/usr/bin/env bash
set -euo pipefail

: "${RELEASE_TAG:?RELEASE_TAG is required}"
: "${RELEASE_VERSION:?RELEASE_VERSION is required}"
: "${GITHUB_SHA:?GITHUB_SHA is required}"

IPA_PATH="${SIDESTORE_IPA_PATH:-artifacts/ios/shijuan.ipa}"
SOURCE_PATH="${SIDESTORE_SOURCE_PATH:-artifacts/ios/sidestore-source.json}"
NOTES_PATH="${SIDESTORE_NOTES_PATH:-artifacts/ios/release-notes.md}"

if gh release view "$RELEASE_TAG" --json isDraft --jq '.isDraft' > "$RUNNER_TEMP/release-draft" 2>/dev/null; then
  if [[ "$(cat "$RUNNER_TEMP/release-draft")" == "true" ]]; then
    gh release upload "$RELEASE_TAG" "$IPA_PATH" "$SOURCE_PATH" --clobber
    gh release edit "$RELEASE_TAG" \
      --title "拾卷 iOS ${RELEASE_VERSION}" \
      --notes-file "$NOTES_PATH" \
      --draft=false \
      --latest
  else
    echo "Release ${RELEASE_TAG} 已发布；保持资产不可变并重新设为 latest。"
    gh release edit "$RELEASE_TAG" --latest
  fi
else
  gh release create "$RELEASE_TAG" \
    --target "$GITHUB_SHA" \
    --title "拾卷 iOS ${RELEASE_VERSION}" \
    --notes-file "$NOTES_PATH" \
    --draft
  gh release upload "$RELEASE_TAG" "$IPA_PATH" "$SOURCE_PATH"
  gh release edit "$RELEASE_TAG" --draft=false --latest
fi
