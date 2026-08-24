import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

/** Resolve an image asset to its local Blob representation. */
export type LoadAsset = (assetId: string) => Promise<Blob | undefined>;

export type AssetImageStatus = "loading" | "ready" | "missing" | "offline" | "error";
export type RetryAsset = (assetId: string) => void | Promise<void>;

export interface AssetLoadOutcome {
  status: AssetImageStatus;
  blob?: Blob;
  error?: unknown;
}

export interface AssetImageProps {
  /** Content-addressed asset identifier.  This is never used as a network URL. */
  assetId: string;
  /** Alternative text remains available while the image is loading or unavailable. */
  alt: string;
  /** Optional local asset-store adapter. */
  loadAsset?: LoadAsset;
  /** Optional hook for callers that want to refresh their local asset cache. */
  retry?: RetryAsset;
  /** Alias for integrations that use event-style callback naming. */
  onRetry?: RetryAsset;
  className?: string;
  imageClassName?: string;
  width?: number;
  height?: number;
  /** Allow the rendered image to open in a full-screen local lightbox. */
  zoomable?: boolean;
}

interface AssetImageState {
  status: AssetImageStatus;
  message?: string;
}

const unavailableLoader: LoadAsset = () => Promise.resolve(undefined);

function isRenderableBlob(value: Blob | undefined): value is Blob {
  return Boolean(value && typeof value.size === "number" && Number.isFinite(value.size) && value.size > 0);
}

/** Always try the local asset store, including while the browser is offline. */
export async function resolveAssetLoad(loader: LoadAsset, assetId: string, isOnline = true): Promise<AssetLoadOutcome> {
  try {
    const blob = await loader(assetId);
    if (isRenderableBlob(blob)) return { status: "ready", blob };
    return { status: isOnline ? "missing" : "offline" };
  } catch (error) {
    return { status: isOnline ? "error" : "offline", error };
  }
}

/** Wait for a cache refresh callback before asking the component to reload. */
export async function performAssetRetry(assetId: string, retry: RetryAsset | undefined, reload: () => void): Promise<void> {
  await retry?.(assetId);
  reload();
}

function statusMessage(status: AssetImageStatus): string {
  switch (status) {
    case "loading":
      return "正在加载图片…";
    case "missing":
      return "图片暂不可用";
    case "offline":
      return "当前离线，图片暂不可用";
    case "error":
      return "图片加载失败";
    case "ready":
      return "图片已加载";
  }
}

/**
 * Render a locally cached image Blob without accepting direct HTTP(S) sources.
 * Every object URL is revoked when the asset changes or this component unmounts.
 */
export function AssetImage({
  assetId,
  alt,
  loadAsset,
  retry,
  onRetry,
  className,
  imageClassName,
  width,
  height,
  zoomable = false,
}: AssetImageProps) {
  const [attempt, setAttempt] = useState(0);
  const [objectUrl, setObjectUrl] = useState<string>();
  const [objectUrlAssetId, setObjectUrlAssetId] = useState<string>();
  const [state, setState] = useState<AssetImageState>({ status: "loading" });
  const [zoomed, setZoomed] = useState(false);
  const loader = loadAsset ?? unavailableLoader;
  const loaderRef = useRef<LoadAsset>(loader);

  useEffect(() => {
    loaderRef.current = loader;
  }, [loader]);

  useEffect(() => {
    let active = true;
    let createdUrl: string | undefined;

    const load = async () => {
      const normalizedAssetId = assetId.trim();
      if (!normalizedAssetId) {
        setState({ status: "missing", message: "缺少图片资源标识" });
        return;
      }

      setState({ status: "loading" });
      const isOnline = typeof navigator === "undefined" || navigator.onLine !== false;
      const outcome = await resolveAssetLoad(loaderRef.current, normalizedAssetId, isOnline);
      if (!active) return;
      if (outcome.status !== "ready" || !outcome.blob) {
        const message = outcome.status === "error" && outcome.error instanceof Error ? outcome.error.message : undefined;
        setState({ status: outcome.status, message });
        return;
      }
      const blob = outcome.blob;
      try {
        if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") {
          setState({ status: "error", message: "当前环境不支持本地图片预览" });
          return;
        }
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
        setObjectUrlAssetId(normalizedAssetId);
        setState({ status: "ready" });
      } catch (error) {
        if (!active) return;
        const message = error instanceof Error ? error.message : undefined;
        setState({ status: "error", message });
      }
    };

    void load();
    return () => {
      active = false;
      if (createdUrl && typeof URL !== "undefined" && typeof URL.revokeObjectURL === "function") {
        URL.revokeObjectURL(createdUrl);
      }
    };
  }, [assetId, attempt]);

  useEffect(() => {
    if (!zoomed || typeof document === "undefined") return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setZoomed(false);
    };
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [zoomed]);

  const retryLoad = () => {
    setState({ status: "loading" });
    const callback = onRetry ?? retry;
    void performAssetRetry(assetId, callback, () => setAttempt((value) => value + 1)).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : undefined;
      setState({ status: "error", message });
    });
  };

  const rootClassName = `asset-image${className ? ` ${className}` : ""}`;
  if (objectUrl && objectUrlAssetId === assetId.trim() && state.status === "ready") {
    const openZoom = (event: React.SyntheticEvent) => {
      if (!zoomable) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomed(true);
    };
    const closeZoom = (event: React.SyntheticEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setZoomed(false);
    };
    return (
      <>
        <div className={rootClassName} data-asset-id={assetId} data-state="ready" data-zoomable={zoomable || undefined}>
          <img
            className={imageClassName}
            src={objectUrl}
            alt={alt}
            width={width}
            height={height}
            decoding="async"
            role={zoomable ? "button" : undefined}
            tabIndex={zoomable ? 0 : undefined}
            aria-label={zoomable ? `放大查看：${alt}` : undefined}
            onClick={zoomable ? openZoom : undefined}
            onKeyDown={zoomable ? (event) => {
              if (event.key === "Enter" || event.key === " ") openZoom(event);
            } : undefined}
          />
        </div>
        {zoomable && zoomed && typeof document !== "undefined" && createPortal(
          <div className="asset-image-lightbox" role="dialog" aria-modal="true" aria-label={`查看大图：${alt}`} onClick={closeZoom}>
            <span className="asset-image-lightbox-close" role="button" tabIndex={0} aria-label="关闭大图" onClick={closeZoom} onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") closeZoom(event);
            }}>×</span>
            <img src={objectUrl} alt={alt} onClick={(event) => event.stopPropagation()} />
          </div>,
          document.body,
        )}
      </>
    );
  }

  const canRetry = state.status !== "loading";
  const message = state.message ?? statusMessage(state.status);
  return (
    <div className={rootClassName} data-asset-id={assetId} data-state={state.status}>
      <div className="asset-image-status" role={state.status === "error" ? "alert" : "status"} aria-live="polite" aria-busy={state.status === "loading"}>
        <span>{message}</span>
        {canRetry && (
          <button type="button" className="asset-image-retry" onClick={retryLoad} aria-label={`重试加载图片${alt ? `：${alt}` : ""}`}>
            重试
          </button>
        )}
      </div>
      <span className="asset-image-alt">{alt || "图片"}</span>
    </div>
  );
}
