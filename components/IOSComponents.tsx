"use client";
import React from "react";

// --- Card ---
export default function IOSCard({
    children,
    className = "",
}: {
    children: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            className={`ios-card shadow-sm border border-ios-separator/50 ${className}`}
        >
            {children}
        </div>
    );
}

// --- Grouped List ---
export function IOSGroup({
    children,
    header,
    footer,
}: {
    children: React.ReactNode;
    header?: string;
    footer?: string;
}) {
    return (
        <div className="mb-6">
            {header && (
                <div className="px-4 pb-2 text-xs font-medium text-ios-text-secondary uppercase tracking-wide">
                    {header}
                </div>
            )}
            <div className="ios-inset-grouped bg-ios-card divide-y divide-ios-separator">
                {children}
            </div>
            {footer && (
                <div className="px-4 pt-2 text-xs text-ios-text-secondary">
                    {footer}
                </div>
            )}
        </div>
    );
}

// --- Standard Row ---
export function IOSRow({
    label,
    value,
    onClick,
    icon,
    className = "",
}: {
    label: string;
    value?: React.ReactNode;
    onClick?: () => void;
    icon?: React.ReactNode;
    className?: string;
}) {
    return (
        <div
            role={onClick ? "button" : undefined}
            tabIndex={onClick ? 0 : undefined}
            aria-disabled={onClick ? undefined : undefined}
            onClick={onClick}
            onKeyDown={
                onClick
                    ? (e) => {
                          if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              onClick();
                          }
                      }
                    : undefined
            }
            className={`flex items-center justify-between p-4 bg-ios-card ${onClick ? "cursor-pointer active:bg-gray-100 dark:active:bg-gray-800 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ios-blue focus-visible:ring-inset" : ""} ${className}`}
        >
            <div className="flex items-center gap-3">
                {icon && <span className="text-ios-blue">{icon}</span>}
                <span className="text-[17px] text-ios-text">{label}</span>
            </div>
            <div className="text-[17px] text-ios-text-secondary flex items-center gap-2">
                {value}
                {onClick && <span className="text-gray-300">›</span>}
            </div>
        </div>
    );
}

// --- Input Row ---
export function IOSInputRow({
    label,
    value,
    onChange,
    type = "text",
    placeholder,
    className = "",
}: {
    label: string;
    value: string;
    onChange: (e: React.ChangeEvent<HTMLInputElement>) => void;
    type?: string;
    placeholder?: string;
    className?: string;
}) {
    return (
        <div
            className={`flex items-center justify-between p-4 bg-ios-card ${className}`}
        >
            <label className="text-[17px] text-ios-text w-24 flex-shrink-0">
                {label}
            </label>
            <input
                type={type}
                value={value}
                onChange={onChange}
                placeholder={placeholder}
                className="flex-1 bg-transparent text-[17px] text-ios-blue text-right placeholder:text-gray-300 focus:outline-none"
            />
        </div>
    );
}
