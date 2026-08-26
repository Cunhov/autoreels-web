import Link from "next/link";
import IOSButton from "@/components/IOSButton";

export default function NotFound() {
  return (
    <div className="flex min-h-[70dvh] flex-col items-center justify-center p-8 text-center">
      <div className="w-20 h-20 rounded-2xl bg-ios-blue/10 flex items-center justify-center mb-6">
        <span className="text-4xl">🔍</span>
      </div>
      <h1 className="text-[22px] font-bold text-ios-text mb-2">
        Página não encontrada
      </h1>
      <p className="text-[15px] text-ios-text-secondary mb-6 max-w-sm">
        A página que você procurou não existe ou foi movida.
      </p>
      <Link href="/">
        <IOSButton variant="primary" className="px-8">
          Voltar ao início
        </IOSButton>
      </Link>
    </div>
  );
}
