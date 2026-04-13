-- ═══════════════════════════════════════════════════
-- PEACER TIMELINE — Supabase Schema
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════

-- 1. Create tasks table
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '기타',
  project TEXT,
  owner TEXT DEFAULT '공동',
  deadline DATE,
  status TEXT NOT NULL DEFAULT 'todo',
  priority TEXT NOT NULL DEFAULT 'medium',
  note TEXT DEFAULT '',
  depends_on TEXT[] DEFAULT '{}',
  blocks_count INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 2. Enable Row Level Security (but allow all for now — no auth)
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;

-- Allow all operations for anonymous users (shared URL access)
CREATE POLICY "Allow all for anon" ON tasks
  FOR ALL
  USING (true)
  WITH CHECK (true);

-- 3. Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE tasks;

-- 4. Auto-update updated_at
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER tasks_updated_at
  BEFORE UPDATE ON tasks
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at();

-- 5. Seed data
INSERT INTO tasks (id, title, category, project, owner, deadline, status, priority, note, depends_on) VALUES
  ('s1', '법인 설립 다시하기', '사업자/인허가', '법인 설립', '풍성', '2026-04-13', 'todo', 'high', '법인명 변경', '{}'),
  ('s2', '티에이치바이오 몰드 제작 요청', '제조', '샘플링', '풍성', '2026-04-13', 'todo', 'high', '전화: 4월 발주 가능? 최단 경로 문의', '{}'),
  ('s3', '센트라이프 샘플 문의', '제조', '샘플링', '은채', '2026-04-13', 'todo', 'medium', '4/13 오전', '{}'),
  ('s4', '메타폴리아로마 샘플 수령', '제조', '샘플링', '풍성', '2026-04-15', 'waiting', 'high', '4/13 발송. 배송 대기.', '{}'),
  ('s5', '사업자 등록', '사업자/인허가', '법인 설립', '풍성', '2026-04-14', 'todo', 'high', '법인 설립 후', '{s1}'),
  ('s6', '법인 계좌 만들기', '사업자/인허가', '법인 설립', '풍성', '2026-04-15', 'todo', 'high', '실사 확인', '{s1}'),
  ('s7', '법인 공인인증서', '사업자/인허가', '법인 설립', '풍성', '2026-04-15', 'todo', 'medium', '계좌 후', '{s6}'),
  ('s8', '화장품책임판매업 등록 확인', '사업자/인허가', '인허가', '풍성', '2026-04-15', 'waiting', 'high', 'nedrug 진행 중. KCL 위수탁 계약.', '{}'),
  ('s9', 'cafe24 이관', '사업자/인허가', '법인 설립', '풍성', '2026-04-16', 'todo', 'medium', '계좌+인증서 후', '{s6,s7}'),
  ('s10', 'PG 신청', '사업자/인허가', '법인 설립', '풍성', '2026-04-17', 'todo', 'medium', 'cafe24에 PG 등록', '{s9}'),
  ('s11', '통신판매업 등록', '사업자/인허가', '인허가', '풍성', '2026-04-17', 'todo', 'medium', '', '{}'),
  ('s12', '티에이치바이오 샘플 수령', '제조', '샘플링', '풍성', '2026-04-23', 'todo', 'high', '몰드 제작 선행', '{s2}'),
  ('s13', '용량/크기 확정', '제조', '본생산', '공동', '2026-04-25', 'todo', 'high', '3종 비교 후', '{s4,s12}'),
  ('s14', '향/지속력/이물감 확정', '제조', '본생산', '공동', '2026-04-27', 'todo', 'high', '실사용 테스트', '{s4,s12}'),
  ('s15', '디자이너에게 전성분표 전달', '디자인', '패키지 디자인', '풍성', '2026-04-30', 'todo', 'medium', '알러젠 표기', '{s13}'),
  ('s16', '향료 발주', '제조', '본생산', '은채', '2026-05-02', 'todo', 'high', '3일 소요', '{s14}'),
  ('s17', '패키지 박스 발주', '제조', '패키지', '풍성', '2026-05-05', 'todo', 'high', '전성분표 확정 후', '{s15}'),
  ('s18', '제조사 발주 계약', '계약', '본생산', '공동', '2026-05-08', 'todo', 'high', '몰드+샘플 확정 후', '{s13,s14}'),
  ('s19', '3PL 창고 계약', '계약', '본생산', '풍성', '2026-05-10', 'todo', 'medium', '', '{}'),
  ('s20', '가설 검증 소재 변경', '마케팅', '프리오더 캠페인', '풍성', NULL, 'doing', 'medium', '', '{}'),
  ('s21', '인플루언서 리스트 작성', '마케팅', '인플루언서 씨딩', '은채', NULL, 'todo', 'medium', '씨딩+공동구매', '{}'),
  ('s22', '책임판매업 교육', '사업자/인허가', '인허가', '풍성', NULL, 'todo', 'low', '6개월 이내', '{}')
ON CONFLICT (id) DO NOTHING;
