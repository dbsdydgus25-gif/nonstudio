import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NON FITTING — AI 피팅 스튜디오',
  description:
    'NON FITTING 내부 AI 피팅 스튜디오. 제품 사진으로 모델 착용 화보를 제작하고 포즈를 다양화합니다.',
  keywords: ['가상피팅', 'AI 피팅', 'NON FITTING', 'VTON', '가상착용'],
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ko" className={inter.variable} suppressHydrationWarning>
      <body className={`${inter.className} bg-white antialiased`} suppressHydrationWarning>
        {children}
      </body>
    </html>
  );
}
