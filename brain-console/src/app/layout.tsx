import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Brain 2.0 Console",
  description: "Operator console for the local Brain 2.0 runtime",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="dark" style={{ colorScheme: "dark" }}>
      <body className="bg-background text-foreground font-sans antialiased">{children}</body>
    </html>
  );
}
