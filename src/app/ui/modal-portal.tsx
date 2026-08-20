"use client";

import { useEffect, type ReactNode } from "react";
import { createPortal } from "react-dom";

let openPortalCount = 0;
let lockedWorkspace: HTMLElement | null = null;
let originalWorkspaceOverflow = "";
let backgroundRoot: HTMLElement | null = null;
let backgroundWasInert = false;
let backgroundAriaHidden: string | null = null;

export function ModalPortal({ children }: { children: ReactNode }) {
  useEffect(() => {
    const workspace = document.querySelector<HTMLElement>(".workspace");
    if (!workspace) return;
    if (openPortalCount === 0) {
      lockedWorkspace = workspace;
      originalWorkspaceOverflow = workspace.style.overflow;
      workspace.style.overflow = "hidden";
      backgroundRoot = document.querySelector<HTMLElement>(".app-shell");
      if (backgroundRoot) {
        backgroundWasInert = backgroundRoot.inert;
        backgroundAriaHidden = backgroundRoot.getAttribute("aria-hidden");
        backgroundRoot.inert = true;
        backgroundRoot.setAttribute("aria-hidden", "true");
      }
    }
    openPortalCount += 1;
    return () => {
      openPortalCount = Math.max(0, openPortalCount - 1);
      if (openPortalCount === 0 && lockedWorkspace) {
        lockedWorkspace.style.overflow = originalWorkspaceOverflow;
        lockedWorkspace = null;
        if (backgroundRoot) {
          backgroundRoot.inert = backgroundWasInert;
          if (backgroundAriaHidden === null) backgroundRoot.removeAttribute("aria-hidden");
          else backgroundRoot.setAttribute("aria-hidden", backgroundAriaHidden);
          backgroundRoot = null;
          backgroundAriaHidden = null;
        }
      }
    };
  }, []);

  if (typeof document === "undefined") return null;
  return createPortal(children, document.body);
}
