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

// Track > Phase > Task structure
// Phase.projects = list of `project` field values on tasks that belong to this phase
export type Phase = { name: string; projects: string[] };
export type Track = { name: string; emoji: string; goal: string; phases: Phase[] };

export const TRACKS: Track[] = [
  {
    name: "제품", emoji: "🧴", goal: "출시일 맞추기",
    phases: [
      { name: "샘플 테스트", projects: ["샘플링"] },
      { name: "본생산 준비", projects: ["본생산", "패키지 디자인"] },
      { name: "발주/출하", projects: ["패키지", "발주", "3PL"] },
    ],
  },
  {
    name: "운영", emoji: "🏢", goal: "온라인 판매 인프라 완성",
    phases: [
      { name: "법인/사업자", projects: ["법인 설립"] },
      { name: "인허가", projects: ["인허가"] },
      { name: "판매 인프라", projects: ["판매 인프라"] },
    ],
  },
  {
    name: "마케팅", emoji: "📣", goal: "출시 전 고객 100명",
    phases: [
      { name: "자체 채널", projects: ["리뷰 채널", "프리오더 캠페인"] },
      { name: "씨딩", projects: ["인플루언서 씨딩"] },
    ],
  },
];

// Project metadata — goals, deadlines, KR mapping (kept for backward compat)
export const PROJECT_META: Record<string, { goal: string; emoji: string; kr?: string }> = {
  "샘플링": { goal: "제품 확정", emoji: "🧪", kr: "고객 경험 100% 구현된 제품 런칭" },
  "본생산": { goal: "본생산 완료", emoji: "🏭", kr: "고객 경험 100% 구현된 제품 런칭" },
  "법인 설립": { goal: "법인+계좌+인증서", emoji: "🏢" },
  "인허가": { goal: "화장품 책임판매업", emoji: "📋" },
  "패키지": { goal: "패키지 입고", emoji: "📦", kr: "고객 경험 100% 구현된 제품 런칭" },
  "패키지 디자인": { goal: "전성분표 디자인 확정", emoji: "🎨", kr: "고객 경험 100% 구현된 제품 런칭" },
  "프리오더 캠페인": { goal: "사전 예약 100명", emoji: "🚀", kr: "초기 결제 고객 100명" },
  "인플루언서 씨딩": { goal: "인플루언서 10명 씨딩", emoji: "📣", kr: "초기 결제 고객 100명" },
  "리뷰 채널": { goal: "팔로우 100명 (오가닉)", emoji: "📱", kr: "NPS 달성 → 리뷰 20건" },
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
