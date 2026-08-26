"use client";
import { useEffect } from "react";
import IOSButton from "@/components/IOSButton";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center p-8 text-center">
      <div className="w-20 h-20 rounded-2xl bg-ios-red/10 flex items-center justify-center mb-6">
        <span className="text-4xl">⚠️</span>
      </div>
      <h1 className="text-[22px] font-bold text-ios-text mb-2">
        Algo deu errado
      </h1>
      <p className="text-[15px] text-ios-text-secondary mb-6 max-w-sm">
        Ocorreu um erro inesperado. Tente novamente.
      </p>
      <div className="flex gap-3">
        <IOSButton variant="primary" onClick={reset} className="px-8">
          Tentar novamente
        </IOSButton>
        <IOSButton
          variant="secondary"
          onClick={() => (window.location.href = "/")}
          className="px-6"
        >
          Início
        </IOSButton>
      </div>
    </div>
  );
}
