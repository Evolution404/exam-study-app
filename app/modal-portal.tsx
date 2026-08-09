"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

let openPortalCount = 0;
let lockedWorkspace: HTMLElement | null = null;
let originalWorkspaceOverflow = "";

export function ModalPortal({ children }: { children: ReactNode }) {
  useEffect(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (!workspace) return;
    if (openPortalCount === 0) {
      lockedWorkspace = workspace;
      originalWorkspaceOverflow = workspace.style.overflow;
      workspace.style.overflow = "hidden";
    }
    openPortalCount += 1;
    return () => {
      openPortalCount = Math.max(0, openPortalCount - 1);
      if (openPortalCount === 0 && lockedWorkspace) {
        lockedWorkspace.style.overflow = originalWorkspaceOverflow;
        lockedWorkspace = null;
      }
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
