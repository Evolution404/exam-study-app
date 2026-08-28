"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";
import { useRef, useState, type CSSProperties } from "react";

export interface AppSelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface AppSelectProps {
  value: string;
  onValueChange: (value: string) => void;
  options: readonly AppSelectOption[];
  ariaLabel: string;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  id?: string;
  style?: CSSProperties;
}

function pointerHitsTrigger(trigger: HTMLButtonElement | null, event: PointerEvent) {
  if (!trigger) return false;
  const rect = trigger.getBoundingClientRect();
  return event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom;
}

export function AppSelect({ value, onValueChange, options, ariaLabel, placeholder, disabled, className, contentClassName, id, style }: AppSelectProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  return <Select.Root value={value} onValueChange={onValueChange} disabled={disabled} open={open} onOpenChange={setOpen}>
    <Select.Trigger
      ref={triggerRef}
      id={id}
      className={["app-select-trigger", className].filter(Boolean).join(" ")}
      aria-label={ariaLabel}
      style={style}
      onPointerDown={(event) => {
        // Radix opens mouse Selects on pointerdown. Consume the same event when
        // this trigger is already open so it behaves as a toggle instead.
        if (!open || event.pointerType !== "mouse") return;
        event.preventDefault();
        setOpen(false);
      }}
      onClick={(event) => {
        // Radix opens touch/pen Selects on click. Its default handler only ever
        // opens, so an open trigger needs to consume the click and close itself.
        if (!open) return;
        event.preventDefault();
        setOpen(false);
      }}
    >
      <Select.Value placeholder={placeholder} />
      <Select.Icon className="app-select-icon"><ChevronDown size={15} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content
        className={["app-select-content", contentClassName].filter(Boolean).join(" ")}
        position="popper"
        sideOffset={6}
        collisionPadding={16}
        onPointerDownOutside={(event) => {
          // While Select is open Radix disables pointer events outside its
          // dismissable layer, so Safari/WebKit can target the document rather
          // than the trigger. Recover the intended trigger tap from coordinates.
          const originalEvent = event.detail.originalEvent;
          if (!pointerHitsTrigger(triggerRef.current, originalEvent)) return;
          originalEvent.preventDefault();
          event.preventDefault();
          setOpen(false);
        }}
      >
        <Select.ScrollUpButton className="app-select-scroll-button"><ChevronUp size={15} /></Select.ScrollUpButton>
        <Select.Viewport className="app-select-viewport">
          {options.map((option) => <Select.Item
            className="app-select-item"
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            textValue={option.label}
          >
            <Select.ItemText>{option.label}</Select.ItemText>
            <Select.ItemIndicator className="app-select-indicator"><Check size={14} /></Select.ItemIndicator>
          </Select.Item>)}
        </Select.Viewport>
        <Select.ScrollDownButton className="app-select-scroll-button"><ChevronDown size={15} /></Select.ScrollDownButton>
      </Select.Content>
    </Select.Portal>
  </Select.Root>;
}
