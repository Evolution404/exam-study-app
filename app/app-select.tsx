"use client";

import * as Select from "@radix-ui/react-select";
import { Check, ChevronDown, ChevronUp } from "lucide-react";

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
  id?: string;
}

export function AppSelect({ value, onValueChange, options, ariaLabel, placeholder, disabled, className, id }: AppSelectProps) {
  return <Select.Root value={value} onValueChange={onValueChange} disabled={disabled}>
    <Select.Trigger id={id} className={["app-select-trigger", className].filter(Boolean).join(" ")} aria-label={ariaLabel}>
      <Select.Value placeholder={placeholder} />
      <Select.Icon className="app-select-icon"><ChevronDown size={15} aria-hidden="true" /></Select.Icon>
    </Select.Trigger>
    <Select.Portal>
      <Select.Content
        className="app-select-content"
        position="popper"
        sideOffset={6}
        collisionPadding={16}
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
