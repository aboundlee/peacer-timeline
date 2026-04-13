export const CATS = ["제조", "사업자/인허가", "마케팅", "디자인", "계약", "기타"];

export const CC: Record<string, { bg: string; bd: string; tx: string }> = {
  "제조": { bg: "#EFEBFA", bd: "#A896C4", tx: "#3A2E5A" },
  "사업자/인허가": { bg: "#E4EFF5", bd: "#7A9AAD", tx: "#2E3E5A" },
  "마케팅": { bg: "#FAF0F0", bd: "#C49696", tx: "#5A2E2E" },
  "디자인": { bg: "#F5EEE6", bd: "#C4A896", tx: "#5A3E2E" },
  "계약": { bg: "#EBF3E6", bd: "#A8C496", tx: "#3E5A2E" },
  "기타": { bg: "#F5F1EA", bd: "#DDD3C2", tx: "#4A3F38" },
};

export const STS = ["todo", "doing", "waiting", "done"] as const;

export const SL: Record<string, string> = {
  todo: "할 일",
  doing: "진행중",
  waiting: "대기",
  done: "완료",
};

export const SC: Record<string, { bg: string; tx: string; bd: string }> = {
  todo: { bg: "#FAF6EF", tx: "#8A7D72", bd: "#DDD3C2" },
  doing: { bg: "#EFEBFA", tx: "#5F4B82", bd: "#A896C4" },
  waiting: { bg: "#F5EEE6", tx: "#8B5A3C", bd: "#C4A896" },
  done: { bg: "#EBF3E6", tx: "#3E5A2E", bd: "#A8C496" },
};

export const OWNERS = ["풍성", "은채", "공동"];

export const MST = [
  { label: "프리오더 런칭", date: "2026-04-14", color: "#5F4B82" },
  { label: "출하 목표", date: "2026-05-19", color: "#8B5A3C" },
];

export const OKR = {
  objective: "제품 출시 후 찐 팬 100명 모으기",
  krs: [
    "고객 경험 100% 구현된 제품 런칭",
    "초기 결제 고객 100명",
    "NPS 달성 → 리뷰 20건",
  ],
};

// Utility functions
export function dU(d: string | null): number {
  if (!d) return 999;
  const n = new Date();
  n.setHours(0, 0, 0, 0);
  return Math.ceil((new Date(d + "T00:00:00").getTime() - n.getTime()) / 864e5);
}

export function fD(d: string | null): string {
  if (!d) return "";
  const p = d.split("-");
  return `${+p[1]}/${+p[2]}`;
}

export function uid(): string {
  return "t" + Date.now() + Math.random().toString(36).slice(2, 5);
}
