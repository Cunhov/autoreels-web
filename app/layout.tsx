import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Link from 'next/link';
import { Home, PlusSquare, Settings } from 'lucide-react';

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "AutoReels",
  description: "Automated Instagram Reels Publisher",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} bg-slate-50 text-slate-900`}>
        <div className="min-h-screen flex flex-col">
          <nav className="bg-white border-b border-slate-200 px-4 py-3 flex items-center justify-between sticky top-0 z-10">
            <div className="font-bold text-xl flex items-center gap-2 text-indigo-600">
              <span>AutoReels</span>
            </div>
            <div className="flex gap-4">
              <Link href="/" className="flex items-center gap-2 text-slate-600 hover:text-indigo-600 transition-colors">
                <Home size={20} />
                <span className="hidden sm:inline">Dashboard</span>
              </Link>
              <Link href="/new" className="flex items-center gap-2 text-slate-600 hover:text-indigo-600 transition-colors">
                <PlusSquare size={20} />
                <span className="hidden sm:inline">New Post</span>
              </Link>
              <Link href="/settings" className="flex items-center gap-2 text-slate-600 hover:text-indigo-600 transition-colors">
                <Settings size={20} />
                <span className="hidden sm:inline">Settings</span>
              </Link>
            </div>
          </nav>
          <main className="flex-1 max-w-5xl w-full mx-auto p-4 sm:p-6 lg:p-8">
            {children}
          </main>
        </div>
      </body>
    </html>
  );
}
