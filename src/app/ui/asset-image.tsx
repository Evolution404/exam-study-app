import { useEffect, useRef, useState, type SyntheticEvent } from "react";
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

export const IMAGE_ZOOM_LEVELS = [1, 1.5, 2, 3, 4] as const;

export function stepImageZoomIndex(index: number, direction: 1 | -1): number {
  return Math.min(IMAGE_ZOOM_LEVELS.length - 1, Math.max(0, Math.round(index) + direction));
}

export function fitLightboxImageWidth(
  naturalWidth: number,
  naturalHeight: number,
  viewportWidth: number,
  viewportHeight: number,
): number {
  if (![naturalWidth, naturalHeight, viewportWidth, viewportHeight].every((value) => Number.isFinite(value) && value > 0)) return 0;
  const availableWidth = Math.min(viewportWidth * 0.94, 1600);
  const availableHeight = viewportHeight * 0.9;
  return Math.min(naturalWidth, availableWidth, naturalWidth * (availableHeight / naturalHeight));
}

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
  const [zoomLevelIndex, setZoomLevelIndex] = useState(0);
  const [zoomFitWidth, setZoomFitWidth] = useState<number>();
  const loader = loadAsset ?? unavailableLoader;
  const loaderRef = useRef<LoadAsset>(loader);
  const lightboxImageRef = useRef<HTMLImageElement>(null);

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

    const syncFitWidth = () => {
      const image = lightboxImageRef.current;
      if (!image || !image.naturalWidth || !image.naturalHeight) return;
      const fitted = fitLightboxImageWidth(image.naturalWidth, image.naturalHeight, window.innerWidth, window.innerHeight);
      if (fitted > 0) setZoomFitWidth(fitted);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setZoomed(false);
        return;
      }
      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoomLevelIndex((index) => stepImageZoomIndex(index, 1));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoomLevelIndex((index) => stepImageZoomIndex(index, -1));
      }
    };

    window.addEventListener("resize", syncFitWidth);
    document.addEventListener("keydown", onKeyDown);
    syncFitWidth();
    return () => {
      window.removeEventListener("resize", syncFitWidth);
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
    const openZoom = (event: SyntheticEvent) => {
      if (!zoomable) return;
      event.preventDefault();
      event.stopPropagation();
      setZoomLevelIndex(0);
      setZoomFitWidth(undefined);
      setZoomed(true);
    };
    const closeZoom = (event: SyntheticEvent) => {
      event.preventDefault();
      setZoomed(false);
    };
    const stopLightboxClose = (event: SyntheticEvent) => {
      event.stopPropagation();
    };
    const changeZoom = (event: SyntheticEvent, direction: 1 | -1) => {
      event.preventDefault();
      event.stopPropagation();
      setZoomLevelIndex((index) => stepImageZoomIndex(index, direction));
    };
    const increaseZoom = (event: SyntheticEvent) => changeZoom(event, 1);
    const zoomScale = IMAGE_ZOOM_LEVELS[zoomLevelIndex];
    const canZoomOut = zoomLevelIndex > 0;
    const canZoomIn = zoomLevelIndex < IMAGE_ZOOM_LEVELS.length - 1;
    const zoomWidth = zoomFitWidth ? zoomFitWidth * zoomScale : undefined;
    const image = (
      <img
        className={imageClassName}
        src={objectUrl}
        alt={alt}
        width={width}
        height={height}
        decoding="async"
      />
    );
    return (
      <>
        <div className={rootClassName} data-asset-id={assetId} data-state="ready" data-zoomable={zoomable || undefined}>
          {zoomable ? (
            <span
              className="asset-image-zoom-trigger"
              role="button"
              tabIndex={0}
              aria-label={`放大查看：${alt}`}
              onClick={openZoom}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") openZoom(event);
              }}
            >{image}</span>
          ) : image}
        </div>
        {zoomable && zoomed && typeof document !== "undefined" && createPortal(
          <div className="asset-image-lightbox" role="dialog" aria-modal="true" aria-label={`查看大图：${alt}`} onClick={closeZoom}>
            <div className="asset-image-lightbox-viewport">
              <div className="asset-image-lightbox-canvas">
                <img
                  ref={lightboxImageRef}
                  className="asset-image-lightbox-image"
                  src={objectUrl}
                  alt={alt}
                  decoding="async"
                  data-zoom-ready={Boolean(zoomFitWidth)}
                  data-can-zoom-in={canZoomIn}
                  style={zoomWidth ? { width: `${zoomWidth}px` } : undefined}
                  onLoad={(event) => {
                    const fitted = fitLightboxImageWidth(
                      event.currentTarget.naturalWidth,
                      event.currentTarget.naturalHeight,
                      window.innerWidth,
                      window.innerHeight,
                    );
                    if (fitted > 0) setZoomFitWidth(fitted);
                  }}
                  onClick={increaseZoom}
                />
              </div>
            </div>
            <span
              className="asset-image-lightbox-close"
              role="button"
              tabIndex={0}
              aria-label="关闭大图"
              onClick={(event) => {
                stopLightboxClose(event);
                closeZoom(event);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" || event.key === " ") {
                  stopLightboxClose(event);
                  closeZoom(event);
                }
              }}
            >×</span>
            <div className="asset-image-lightbox-controls" role="toolbar" aria-label="图片缩放" onClick={stopLightboxClose}>
              <span
                className="asset-image-lightbox-control"
                role="button"
                tabIndex={canZoomOut ? 0 : -1}
                aria-label="缩小图片"
                aria-disabled={!canZoomOut}
                data-disabled={!canZoomOut}
                onClick={(event) => changeZoom(event, -1)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") changeZoom(event, -1);
                }}
              >−</span>
              <span className="asset-image-lightbox-scale" aria-live="polite">{Math.round(zoomScale * 100)}%</span>
              <span
                className="asset-image-lightbox-control"
                role="button"
                tabIndex={canZoomIn ? 0 : -1}
                aria-label="放大图片"
                aria-disabled={!canZoomIn}
                data-disabled={!canZoomIn}
                onClick={(event) => changeZoom(event, 1)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") changeZoom(event, 1);
                }}
              >+</span>
            </div>
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
