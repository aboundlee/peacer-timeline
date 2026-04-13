# PEACER 런칭 타임라인

피서(PEACER) 팀의 런칭 프로젝트 관리 도구. Supabase 실시간 동기화 + Claude AI 기반 태스크 관리.

## 배포 가이드

### 1. Supabase 프로젝트 생성

1. [supabase.com](https://supabase.com) 접속 → New Project
2. 프로젝트명: `peacer-timeline`
3. 리전: Northeast Asia (ap-northeast-1) 또는 Seoul
4. **SQL Editor**에서 `supabase-schema.sql` 파일 내용을 복사 붙여넣기 후 실행
5. **Settings → API**에서 `Project URL`과 `anon public` 키를 복사

> ⚠️ Realtime이 활성화되어야 합니다. SQL에 포함되어 있지만 확인:
> Database → Replication → `tasks` 테이블이 활성화되어 있는지 확인

### 2. GitHub 리포지토리 생성

```bash
cd peacer-timeline
git init
git add .
git commit -m "feat: PEACER timeline v6 — Next.js + Supabase"
gh repo create peacer-timeline --public --source=. --push
```

### 3. Vercel 배포

1. [vercel.com](https://vercel.com) → Import Git Repository → `peacer-timeline` 선택
2. **Environment Variables** 설정:
   - `NEXT_PUBLIC_SUPABASE_URL` = Supabase Project URL
   - `NEXT_PUBLIC_SUPABASE_ANON_KEY` = Supabase anon key
   - `ANTHROPIC_API_KEY` = Claude API 키 (sk-ant-...)
3. Deploy 클릭

### 4. 접속

배포 완료 후 Vercel이 제공하는 URL로 접속하면 끝!
풍성과 은채 모두 같은 URL로 접속하면 실시간 동기화됩니다.

## 기능

- ⚡ **오늘의 전투** — 크리티컬 패스 자동 계산
- 📁 **프로젝트 뷰** — 카테고리 > 프로젝트 > 태스크
- 📋 **보드** — 드래그앤드롭 칸반
- 🗺 **로드맵** — 간트 차트
- 📋 **텍스트 동기화** — 회의록/메모에서 AI로 태스크 추출
- 🔗 **AI 구조 분석** — 의존관계 자동 추론

## 로컬 개발

```bash
cp .env.local.example .env.local
# .env.local에 실제 값 입력
npm install
npm run dev
```
