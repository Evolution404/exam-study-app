export type TagMatchMode = "any" | "all";

export function matchesTagSelection(questionTags: readonly string[], selectedTags: readonly string[], mode: TagMatchMode): boolean {
  if (!selectedTags.length) return true;
  const available = new Set(questionTags);
  return mode === "all"
    ? selectedTags.every((tag) => available.has(tag))
    : selectedTags.some((tag) => available.has(tag));
}

export function filterTagOptions(tags: readonly string[], query: string): string[] {
  const normalized = query.trim().toLocaleLowerCase("zh-CN");
  return tags.filter((tag) => !normalized || tag.toLocaleLowerCase("zh-CN").includes(normalized));
}
