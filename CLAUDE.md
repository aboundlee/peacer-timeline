# PEACER Timeline — 프로젝트 컨텍스트

## 프로젝트 개요
피서(PEACER) 샤워밤 브랜드의 런칭 프로젝트 관리 도구.
Next.js 16 + Supabase + Vercel로 배포 완료.

## 현재 상태
- **배포 완료**: Vercel에서 라이브 (GitHub 연동 — push하면 자동 재배포)
- **Supabase**: tasks 테이블 생성 + 시드 데이터 22개 + Realtime 활성화
- **Claude API**: 프록시 라우트 구현됨 (`/api/claude`), ANTHROPIC_API_KEY는 아직 미설정

## 기술 스택
- **프레임워크**: Next.js 16 (App Router, TypeScript)
- **DB/실시간**: Supabase (PostgreSQL + Realtime subscriptions)
- **배포**: Vercel (GitHub `aboundlee/peacer-timeline` 연동)
- **AI**: Claude API (서버사이드 프록시로 키 보호)
- **스타일**: 인라인 CSS (DM Serif Display + IBM Plex Sans KR)

## 파일 구조
```
src/
├── app/
│   ├── page.tsx          # 메인 앱 (모든 뷰 + 모달 포함, ~900줄)
│   ├── layout.tsx        # 루트 레이아웃
│   ├── api/claude/route.ts  # Claude API 프록시 (ANTHROPIC_API_KEY 서버사이드)
│   └── globals.css
├── lib/
│   ├── supabase.ts       # Supabase 클라이언트 + dbToApp/appToDb 변환
│   ├── constants.ts      # 카테고리, 상태, 색상, 마일스톤, OKR, 유틸함수
│   └── criticalPath.ts   # 크리티컬 패스 계산 로직 + AppTask 타입
├── supabase-schema.sql   # DB 스키마 + RLS + Realtime + 시드 데이터
└── .env.local.example    # 환경변수 템플릿
```

## 6개 뷰
1. **⚡ 오늘의 전투** — 크리티컬 패스 자동 계산, 지연/오늘/이번주 섹션
2. **📁 프로젝트 뷰** — 카테고리 > 프로젝트 > 태스크 트리, 진행률 바
3. **📋 보드** — 칸반 드래그앤드롭 (todo/doing/waiting/done)
4. **🗺 로드맵** — 간트 차트 (주/일 헤더, 마일스톤 라인, 주말 표시)
5. **📋 텍스트 동기화** — 회의록/메모 붙여넣기 → Claude AI가 태스크 추출
6. **🔗 AI 구조 분석** — 전체 태스크 의존관계 자동 추론

## Supabase tasks 테이블 스키마
```sql
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
```

## 환경변수 (Vercel에 설정됨)
- `NEXT_PUBLIC_SUPABASE_URL` = https://posbpvqxnmylxnxmdyxk.supabase.co
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` = sb_publishable_3a7eTyjcf_7eTgfbBrDKug_vNnVCbYK
- `ANTHROPIC_API_KEY` = 미설정 (나중에 추가 예정)

## 핵심 설계 결정
- **인증 없음**: 공유 URL로 풍성+은채 동시 접속
- **Optimistic UI**: 로컬 state 먼저 업데이트 → Supabase에 비동기 저장
- **Realtime**: Supabase postgres_changes로 INSERT/UPDATE/DELETE 실시간 반영
- **Claude API 프록시**: 클라이언트에서 직접 호출하지 않고 /api/claude 경유 (키 보호)
- **snake_case ↔ camelCase**: DB는 depends_on/blocks_count, 앱은 dependsOn/blocksCount

## 원본
`peacer_timeline_v5.jsx` (Claude Artifact용 단일 JSX) → Next.js + Supabase로 변환
```

여기에 복사할 수 있는 텍스트 버전도 드릴게요:

[CLAUDE.md 보기](computer:///sessions/loving-vigilant-galileo/mnt/outputs/peacer-timeline/CLAUDE.md)

이 파일이 이미 프로젝트 루트에 `CLAUDE.md`로 저장되어 있어서, Claude Code가 자동으로 읽어요. `git push`만 하면 됩니다:

```bash
cd ~/Desktop/peacer-timeline
git add CLAUDE.md
git commit -m "docs: add project context for Claude Code"
git push
```

그 다음 `claude` 실행하면 바로 맥락을 이해한 상태로 시작해요!