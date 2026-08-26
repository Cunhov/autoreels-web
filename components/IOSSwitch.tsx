'use client';
import React, { useCallback } from 'react';

export type IOSSwitchProps = {
  checked: boolean;
  onChange: (next: boolean) => void;
  label?: string;
  ariaLabel?: string;
  ariaLabelledBy?: string;
  disabled?: boolean;
  id?: string;
  className?: string;
};

/**
 * BK-32: Switch reutilizável acessível.
 * - role="switch"
 * - aria-checked
 * - tabIndex 0 (keyboard focável)
 * - Space / Enter alterna
 * - disabled via aria-disabled + tabIndex -1
 */
export default function IOSSwitch({
  checked,
  onChange,
  label,
  ariaLabel,
  ariaLabelledBy,
  disabled = false,
  id,
  className = '',
}: IOSSwitchProps) {
  const toggle = useCallback(() => {
    if (disabled) return;
    onChange(!checked);
  }, [checked, onChange, disabled]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === ' ' || e.key === 'Enter' || e.key === 'Spacebar') {
      e.preventDefault();
      toggle();
    }
  }, [toggle]);

  return (
    <button
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={ariaLabel ?? label}
      aria-labelledby={ariaLabelledBy}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      tabIndex={disabled ? -1 : 0}
      onClick={toggle}
      onKeyDown={handleKeyDown}
      className={`w-[51px] h-[31px] rounded-full p-[2px] transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue focus-visible:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed ${checked ? 'bg-ios-green' : 'bg-ios-separator'} ${className}`}
    >
      <span
        className={`block w-[27px] h-[27px] rounded-full bg-white shadow transition-transform ${checked ? 'translate-x-[20px]' : ''}`}
      />
    </button>
  );
}
