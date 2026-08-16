import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { AssetImage, type LoadAsset } from "@/app/ui/asset-image";
import {
  deleteContentBlock,
  insertImageAtSelection,
  moveContentBlock,
  replaceContentBlock,
  type TextSelection,
} from "@/lib/question/question-content";
import type { ContentBlock, ImageContentBlock, TextContentBlock } from "@/lib/db/v7-types";

export interface PreparedImage {
  assetId: string;
  alt?: string;
  caption?: string;
  metadata?: {
    alt?: string;
    caption?: string;
  };
}

export type PrepareImageResult = PreparedImage | string | undefined;
export type PrepareImage = (file: File) => PrepareImageResult | Promise<PrepareImageResult>;

export interface ContentBlockEditorProps {
  /** Controlled content value; this component never writes to a database. */
  value: readonly ContentBlock[];
  onChange: (value: ContentBlock[]) => void;
  /** Prepare a selected local file and return its content-addressed asset ID. */
  prepareImage: PrepareImage;
  loadAsset?: LoadAsset;
  className?: string;
  disabled?: boolean;
}

type FileAction =
  | { mode: "insert"; textBlockId: string }
  | { mode: "replace"; imageBlockId: string };

type ImageMetadataField = "alt" | "caption";

function normalisePreparedImage(result: PrepareImageResult): PreparedImage | undefined {
  if (typeof result === "string") return result.trim() ? { assetId: result.trim() } : undefined;
  if (!result || typeof result.assetId !== "string" || !result.assetId.trim()) return undefined;
  return {
    ...result,
    assetId: result.assetId.trim(),
    alt: result.alt ?? result.metadata?.alt,
    caption: result.caption ?? result.metadata?.caption,
  };
}

function imageIdFor(blocks: readonly ContentBlock[], counter: { current: number }): string {
  let id = "";
  do {
    id = `image-${Date.now()}-${counter.current++}`;
  } while (blocks.some((block) => block.id === id));
  return id;
}

/**
 * Controlled paragraph-level editor for the v7 ContentBlock model.
 * Text is kept verbatim in textareas, so formulas and authored whitespace are
 * not normalised while inserting or moving images.
 */
export function ContentBlockEditor({
  value,
  onChange,
  prepareImage,
  loadAsset,
  className,
  disabled = false,
}: ContentBlockEditorProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const valueRef = useRef<readonly ContentBlock[]>(value);
  const selectionRef = useRef<Record<string, TextSelection>>({});
  const imageCounter = useRef(0);
  const [selections, setSelections] = useState<Record<string, TextSelection>>({});
  const [fileAction, setFileAction] = useState<FileAction>();
  const [fileBusy, setFileBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const emit = (next: ContentBlock[]) => {
    valueRef.current = next;
    onChange(next);
  };

  const recordSelection = (block: TextContentBlock, element: HTMLTextAreaElement) => {
    const start = Number.isFinite(element.selectionStart) ? element.selectionStart : block.text.length;
    const end = Number.isFinite(element.selectionEnd) ? element.selectionEnd : start;
    const selection = { start, end };
    selectionRef.current = { ...selectionRef.current, [block.id]: selection };
    setSelections((current) => ({ ...current, [block.id]: selection }));
  };

  const updateText = (block: TextContentBlock, text: string, element: HTMLTextAreaElement) => {
    recordSelection({ ...block, text }, element);
    emit(valueRef.current.map((item) => item.id === block.id && item.type === "text" ? { ...item, text } : item));
  };

  const chooseFile = (action: FileAction) => {
    if (disabled || fileBusy) return;
    setError(undefined);
    setFileAction(action);
    fileInputRef.current?.click();
  };

  const handleFileChange = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    const action = fileAction;
    event.target.value = "";
    setFileAction(undefined);
    if (!file || !action) return;

    setFileBusy(true);
    setError(undefined);
    try {
      const prepared = normalisePreparedImage(await prepareImage(file));
      if (!prepared) return;
      const current = valueRef.current;
      if (action.mode === "insert") {
        const textBlock = current.find((block): block is TextContentBlock => block.id === action.textBlockId && block.type === "text");
        if (!textBlock) return;
        const selection = selectionRef.current[textBlock.id] ?? selections[textBlock.id] ?? { start: textBlock.text.length, end: textBlock.text.length };
        const image: ImageContentBlock = {
          id: imageIdFor(current, imageCounter),
          type: "image",
          assetId: prepared.assetId,
          ...(prepared.alt ? { alt: prepared.alt } : {}),
          ...(prepared.caption ? { caption: prepared.caption } : {}),
        };
        emit(insertImageAtSelection(current, textBlock.id, selection, image));
      } else {
        const imageBlock = current.find((block): block is ImageContentBlock => block.id === action.imageBlockId && block.type === "image");
        if (!imageBlock) return;
        const replacement: ImageContentBlock = {
          ...imageBlock,
          assetId: prepared.assetId,
          ...(prepared.alt !== undefined ? { alt: prepared.alt || undefined } : {}),
          ...(prepared.caption !== undefined ? { caption: prepared.caption || undefined } : {}),
        };
        emit(replaceContentBlock(current, imageBlock.id, replacement));
      }
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "图片处理失败");
    } finally {
      setFileBusy(false);
    }
  };

  const move = (blockId: string, offset: -1 | 1) => {
    const current = valueRef.current;
    const index = current.findIndex((block) => block.id === blockId);
    if (index < 0) return;
    emit(moveContentBlock(current, blockId, index + offset));
  };

  const remove = (blockId: string) => emit(deleteContentBlock(valueRef.current, blockId));

  const updateImageMetadata = (block: ImageContentBlock, field: ImageMetadataField, text: string) => {
    const replacement: ImageContentBlock = { ...block, [field]: text || undefined };
    emit(replaceContentBlock(valueRef.current, block.id, replacement));
  };

  const rootClassName = `content-block-editor${className ? ` ${className}` : ""}`;
  return (
    <section className={rootClassName} aria-label="富内容编辑器">
      <input ref={fileInputRef} className="content-block-file-input" type="file" accept="image/*" onChange={(event) => void handleFileChange(event)} disabled={disabled || fileBusy} aria-label="选择图片文件" />
      {error && <p className="content-block-editor-error" role="alert">{error}</p>}
      {value.length === 0 && <p className="content-block-editor-empty">暂无内容块</p>}
      <div className="content-block-editor-list">
        {value.map((block, index) => {
          const isFirst = index === 0;
          const isLast = index === value.length - 1;
          if (block.type === "text") {
            const selection = selections[block.id];
            return (
              <article className="content-block-editor-item content-block-editor-text" key={block.id}>
                <textarea
                  value={block.text}
                  aria-label={`文本块 ${index + 1}`}
                  disabled={disabled || fileBusy}
                  onChange={(event) => updateText(block, event.target.value, event.target)}
                  onSelect={(event) => recordSelection(block, event.currentTarget)}
                  onClick={(event) => recordSelection(block, event.currentTarget)}
                  onKeyUp={(event) => recordSelection(block, event.currentTarget)}
                  data-selection-start={selection?.start}
                  data-selection-end={selection?.end}
                />
                <div className="content-block-editor-actions">
                  <button type="button" onClick={() => chooseFile({ mode: "insert", textBlockId: block.id })} disabled={disabled || fileBusy} aria-label={`在文本块 ${index + 1} 中选择图片`}>选择图片</button>
                  <button type="button" onClick={() => move(block.id, -1)} disabled={disabled || isFirst} aria-label={`上移文本块 ${index + 1}`}>上移</button>
                  <button type="button" onClick={() => move(block.id, 1)} disabled={disabled || isLast} aria-label={`下移文本块 ${index + 1}`}>下移</button>
                  <button type="button" onClick={() => remove(block.id)} disabled={disabled} aria-label={`删除文本块 ${index + 1}`}>删除</button>
                </div>
              </article>
            );
          }

          return (
            <article className="content-block-editor-item content-block-editor-image" key={block.id}>
              <AssetImage assetId={block.assetId} alt={block.alt || "题目插图"} loadAsset={loadAsset} />
              <div className="content-block-editor-image-fields">
                <label htmlFor={`${block.id}-alt`}>替代文本<input id={`${block.id}-alt`} value={block.alt ?? ""} disabled={disabled} onChange={(event) => updateImageMetadata(block, "alt", event.target.value)} /></label>
                <label htmlFor={`${block.id}-caption`}>图片说明<input id={`${block.id}-caption`} value={block.caption ?? ""} disabled={disabled} onChange={(event) => updateImageMetadata(block, "caption", event.target.value)} /></label>
              </div>
              <div className="content-block-editor-actions">
                <button type="button" onClick={() => chooseFile({ mode: "replace", imageBlockId: block.id })} disabled={disabled || fileBusy} aria-label={`替换图片 ${index + 1}`}>替换图片</button>
                <button type="button" onClick={() => move(block.id, -1)} disabled={disabled || isFirst} aria-label={`上移图片 ${index + 1}`}>上移</button>
                <button type="button" onClick={() => move(block.id, 1)} disabled={disabled || isLast} aria-label={`下移图片 ${index + 1}`}>下移</button>
                <button type="button" onClick={() => remove(block.id)} disabled={disabled} aria-label={`删除图片 ${index + 1}`}>删除</button>
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}
