import { Haptics, ImpactStyle, NotificationType, type HapticsPlugin } from "@capacitor/haptics";
import { isIOSApp } from "./environment";

export interface PlatformHaptics {
  answer(correct: boolean): Promise<void>;
  selection(): Promise<void>;
  light(): Promise<void>;
}

export interface HapticsOptions {
  /** Injectable platform predicate used by source tests and host integrations. */
  isNative?: () => boolean;
  /** Injectable Capacitor plugin boundary. */
  bridge?: Pick<HapticsPlugin, "notification" | "selectionChanged" | "impact">;
  /** Injectable Web Vibration API boundary. */
  vibrate?: (pattern: number | number[]) => boolean;
}

function webVibrate(pattern: number | number[], vibrate?: HapticsOptions["vibrate"]): void {
  try {
    const operation = vibrate ?? (typeof navigator !== "undefined" && typeof navigator.vibrate === "function" ? navigator.vibrate.bind(navigator) : undefined);
    operation?.(pattern);
  } catch {
    // Haptics are an optional answer affordance and must never block a write.
  }
}

function safeNativeCall(call: () => Promise<void>): Promise<void> {
  try {
    return Promise.resolve(call()).catch(() => undefined);
  } catch {
    return Promise.resolve();
  }
}

/**
 * Keep all platform-specific answer feedback behind one tiny adapter. Web
 * keeps the existing vibration patterns; iOS uses the native notification and
 * impact generators. Every path is best effort and resolves after failures.
 */
export function createPlatformHaptics(options: HapticsOptions = {}): PlatformHaptics {
  const isNative = options.isNative ?? isIOSApp;
  const bridge = options.bridge ?? Haptics;

  function nativeRuntime(): boolean {
    try {
      return isNative();
    } catch {
      return false;
    }
  }

  return {
    answer(correct) {
      if (nativeRuntime()) return safeNativeCall(() => bridge.notification({ type: correct ? NotificationType.Success : NotificationType.Error }));
      webVibrate(correct ? 35 : [45, 35, 45], options.vibrate);
      return Promise.resolve();
    },
    selection() {
      if (nativeRuntime()) return safeNativeCall(() => bridge.selectionChanged());
      webVibrate(12, options.vibrate);
      return Promise.resolve();
    },
    light() {
      if (nativeRuntime()) return safeNativeCall(() => bridge.impact({ style: ImpactStyle.Light }));
      webVibrate(12, options.vibrate);
      return Promise.resolve();
    },
  };
}

export const platformHaptics = createPlatformHaptics();
