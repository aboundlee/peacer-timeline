import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "PEACER 런칭 타임라인",
  description: "피서 팀 프로젝트 관리 · 실시간 동기화",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body style={{ margin: 0, padding: 0 }}>{children}</body>
    </html>
  );
}
