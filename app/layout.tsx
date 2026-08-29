import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

export const metadata: Metadata = {
  manifest: '/manifest.webmanifest',
  metadataBase: new URL(
    process.env.NEXT_PUBLIC_SITE_URL ?? 'https://myplan.trungvanle.workers.dev',
  ),
  title: 'myplan — Today',
  description: 'A calm place to plan your day, goals, and focus.',
  openGraph: {
    title: 'myplan',
    description: 'Turn direction into daily action.',
    images: [
      {
        url: '/og.png',
        width: 1200,
        height: 630,
        alt: 'myplan — Turn direction into daily action.',
      },
    ],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'myplan',
    description: 'Turn direction into daily action.',
    images: ['/og.png'],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
