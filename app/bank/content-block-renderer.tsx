import { MathText } from "@/app/ui/math-text";
import type { ContentBlock } from "@/lib/v6-types";
import { AssetImage, type LoadAsset, type RetryAsset } from "@/app/ui/asset-image";

export interface ContentBlockRendererProps {
  blocks: readonly ContentBlock[];
  loadAsset?: LoadAsset;
  className?: string;
  languageText?: string;
  imageClassName?: string;
  emptyLabel?: string;
  /** Called by the image placeholder's retry button after a cache miss. */
  retryAsset?: RetryAsset;
}
/** Render text and local image blocks in their authored order. */
export function ContentBlockRenderer({
  blocks,
  loadAsset,
  className,
  languageText,
  imageClassName,
  emptyLabel = "暂无内容",
  retryAsset,
}: ContentBlockRendererProps) {
  const rootClassName = `content-block-renderer${className ? ` ${className}` : ""}`;
  if (!blocks.length) return <div className={rootClassName} data-empty="true" aria-label={emptyLabel} />;

  return (
    <div className={rootClassName}>
      {blocks.map((block) => {
        if (block.type === "text") {
          return <MathText key={block.id} text={block.text} languageText={languageText} />;
        }
        return (
          <figure className="content-block-image" key={block.id}>
            <AssetImage assetId={block.assetId} alt={block.alt || "题目插图"} loadAsset={loadAsset} retry={retryAsset} imageClassName={imageClassName} />
            {block.caption && <figcaption>{block.caption}</figcaption>}
          </figure>
        );
      })}
    </div>
  );
}
