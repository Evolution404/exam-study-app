import type { ReactNode } from "react";
import { MathText } from "@/app/ui/math-text";
import type { ContentBlock, TextContentBlock } from "@/lib/db/v7-types";
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
  /** Optional specialised renderer for text blocks (for example inline
   * calculation blanks). Images and block ordering remain shared here. */
  renderTextBlock?: (block: TextContentBlock) => ReactNode;
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
  renderTextBlock,
}: ContentBlockRendererProps) {
  const rootClassName = `content-block-renderer${className ? ` ${className}` : ""}`;
  if (!blocks.length) return <div className={rootClassName} data-empty="true" aria-label={emptyLabel} />;

  return (
    <div className={rootClassName}>
      {blocks.map((block) => {
        if (block.type === "text") {
          return renderTextBlock
            ? <span className="content-block-custom-text" key={block.id}>{renderTextBlock(block)}</span>
            : <MathText key={block.id} text={block.text} languageText={languageText} />;
        }
        return (
          <figure className="content-block-image" key={block.id}>
            <AssetImage assetId={block.assetId} alt={block.alt || "题目插图"} loadAsset={loadAsset} retry={retryAsset} imageClassName={imageClassName} zoomable />
            {block.caption && <figcaption>{block.caption}</figcaption>}
          </figure>
        );
      })}
    </div>
  );
}
