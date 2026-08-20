import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Curb — the accessibility audit that fixes your code",
  description:
    "An agent that drives your real pages through real interaction states, judges what a rule engine cannot, and ships patches it has verified.",
};

/**
 * Applies the stored theme before first paint.
 *
 * Reading localStorage in an effect means one frame in the wrong theme, which
 * on a dark-preferring machine is a white flash. This runs synchronously in
 * <head>, before any content renders. It is deliberately tiny and wrapped in
 * try/catch — a storage exception must never block the page.
 */
const THEME_SCRIPT = `
try {
  var t = localStorage.getItem('curb-theme');
  if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
} catch (e) {}
`;

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="flex min-h-full flex-col">{children}</body>
    </html>
  );
}
