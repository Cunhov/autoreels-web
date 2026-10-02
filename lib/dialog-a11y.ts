'use client';

import { useEffect, useRef } from 'react';

type DialogEntry = { id: symbol; close: () => void };
const dialogStack: DialogEntry[] = [];
let bodyLockCount = 0;
let previousBodyOverflow = '';

function lockBodyScroll() {
  if (bodyLockCount++ === 0) {
    previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
  }
}

function unlockBodyScroll() {
  bodyLockCount = Math.max(0, bodyLockCount - 1);
  if (bodyLockCount === 0) document.body.style.overflow = previousBodyOverflow;
}

const FOCUSABLE = [
  'a[href]', 'area[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])', 'textarea:not([disabled])', 'iframe', 'object', 'embed',
  '[contenteditable="true"]', '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Shared modal keyboard, focus, and scroll behavior. Attach the returned ref to role="dialog". */
export function useDialogA11y<T extends HTMLElement = HTMLDivElement>(isOpen: boolean, onClose: () => void) {
  const dialogRef = useRef<T>(null);
  const closeRef = useRef(onClose);
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => {
    if (!isOpen) return;
    const id = Symbol('dialog');
    const entry = { id, close: () => closeRef.current() };
    previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogStack.push(entry);
    lockBodyScroll();

    const isFocusable = (el: HTMLElement) =>
      !el.hasAttribute('disabled') &&
      el.tabIndex >= 0 &&
      el.getClientRects().length > 0 &&
      getComputedStyle(el).visibility !== 'hidden' &&
      !el.closest('[aria-hidden="true"], [inert]');
    const getFocusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? [])
      .filter(isFocusable);
    const focusInitial = () => {
      const dialog = dialogRef.current;
      const autofocus = Array.from(dialog?.querySelectorAll<HTMLElement>('[data-autofocus]') ?? []).find(isFocusable);
      const target = autofocus ?? getFocusable()[0] ?? dialog;
      target?.focus();
    };
    const isTop = () => dialogStack[dialogStack.length - 1]?.id === id;
    const focusTimer = window.setTimeout(() => {
      if (isTop()) focusInitial();
    }, 0);
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isTop()) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopImmediatePropagation();
        entry.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = getFocusable();
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current?.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown, true);

    return () => {
      window.clearTimeout(focusTimer);
      document.removeEventListener('keydown', handleKeyDown, true);
      const index = dialogStack.findIndex((item) => item.id === id);
      if (index >= 0) dialogStack.splice(index, 1);
      unlockBodyScroll();
      const restore = previousFocusRef.current;
      if (restore?.isConnected) window.setTimeout(() => restore.focus(), 0);
    };
  }, [isOpen]);

  return dialogRef;
}
