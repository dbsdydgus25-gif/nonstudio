import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import './globals.css';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'NonFitting - AI 가상 피팅 위젯 데모',
  description:
    'AI 기반 가상 피팅 위젯 데모 페이지. 체형 정보를 입력하고 장바구니 상품을 가상으로 착용해보세요.',
  keywords: ['가상피팅', 'AI 피팅', '온라인 쇼핑', 'VTON', '가상착용'],
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
