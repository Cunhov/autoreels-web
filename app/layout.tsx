import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Providers from "@/components/Providers";
import AuthGuard from "@/components/AuthGuard";
import Sidebar from "@/components/Sidebar";
import TabBar from "@/components/TabBar";

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
    <html lang="en" suppressHydrationWarning>
      <body className={`${inter.className} bg-ios-background text-ios-text antialiased`} suppressHydrationWarning>
        <Providers>
          <AuthGuard>
            <div className="flex min-h-screen">
              {/* Desktop Sidebar */}
              <Sidebar />

              <div className="flex-1 flex flex-col min-h-screen pb-[83px] md:pb-0">
                {/* Mobile Header (optional, or rely on page Large Titles) 
                   For now, we let pages handle their titles, but this container handles safe areas.
               */}
                <main className="flex-1 p-4 md:p-8 max-w-5xl mx-auto w-full">
                  {children}
                </main>
              </div>

              {/* Mobile Tab Bar */}
              <TabBar />
            </div>
          </AuthGuard>
        </Providers>
      </body>
    </html>
  );
}
