'use client';

import React, { useMemo } from 'react';

// ─────────────────────────────────────────────────────────
// Peacer V1 출시 시나리오 타임라인 (5/13 기준 · 순차 시나리오)
// 이미지로 공유된 일정표를 그대로 시각화하는 정적 컴포넌트.
// 편집 가능한 태스크 데이터(Supabase)와 별개로 "현재 가정한 시나리오"를 보여줌.
// ─────────────────────────────────────────────────────────

type Bar = {
  label: string;
  start: string; // YYYY-MM-DD
  end: string;
  endNote?: string; // e.g., "~6/13 입고"
  tone: 'sample' | 'design' | 'box' | 'pouch' | 'mfg' | 'qc' | 'ship' | 'admin';
  critical?: boolean;
};

type Lane = {
  name: string;
  detail?: string;
  bars: Bar[];
};

const TODAY = '2026-05-13';
const D_DAY = '2026-07-17';

const LANES: Lane[] = [
  {
    name: '샘플·계약',
    bars: [
      { label: '샘플 확정',  start: '2026-05-13', end: '2026-05-15', tone: 'sample' },
      { label: 'OEM 계약',  start: '2026-05-18', end: '2026-05-21', tone: 'sample' },
    ],
  },
  {
    name: '디자인',
    bars: [
      { label: '최종 확정', start: '2026-05-13', end: '2026-05-22', endNote: '~5/22 마감', tone: 'design' },
    ],
  },
  {
    name: '박스',
    detail: '2~3주',
    bars: [
      { label: '단상자 제작', start: '2026-05-23', end: '2026-06-13', endNote: '~6/13 입고', tone: 'box' },
    ],
  },
  {
    name: '개별포장',
    detail: '15~30일 ★',
    bars: [
      { label: '비닐 파우치 제작 (보수: 30일)', start: '2026-05-23', end: '2026-06-22', endNote: '~6/22 입고', tone: 'pouch', critical: true },
    ],
  },
  {
    name: '제조',
    detail: '원부자재 후 3주',
    bars: [
      { label: '메타폴리아 제조 (1,000세트)', start: '2026-06-22', end: '2026-07-13', endNote: '~7/13', tone: 'mfg', critical: true },
    ],
  },
  {
    name: '충전·QC',
    bars: [
      { label: '', start: '2026-07-13', end: '2026-07-15', endNote: '~7/15', tone: 'qc', critical: true },
    ],
  },
  {
    name: '출고',
    bars: [
      { label: '7/17', start: '2026-07-17', end: '2026-07-17', tone: 'ship', critical: true },
    ],
  },
  {
    name: '행정',
    detail: '사업자·화책판·Cafe24',
    bars: [
      { label: '백그라운드 처리 (5/20 ~ 6/30)', start: '2026-05-20', end: '2026-06-30', tone: 'admin' },
    ],
  },
];

// Palette — 부드러운 톤, 크리티컬은 따로 빨간 보더
const TONES: Record<Bar['tone'], { bg: string; bd: string; tx: string }> = {
  sample: { bg: '#FCEEDD', bd: '#E8A468', tx: '#8B5A2A' },
  design: { bg: '#DDEFE3', bd: '#7DBA92', tx: '#2E5A3E' },
  box:    { bg: '#E3E1F6', bd: '#9F95C9', tx: '#3A2E5A' },
  pouch:  { bg: '#F8DDDA', bd: '#D88A82', tx: '#7A2E28' },
  mfg:    { bg: '#FBE0E5', bd: '#D08089', tx: '#7A2E3A' },
  qc:     { bg: '#DDE6F2', bd: '#7A95B8', tx: '#2E3E5A' },
  ship:   { bg: '#DCEFD8', bd: '#7DB672', tx: '#2E5A28' },
  admin:  { bg: '#EFE7DA', bd: '#C2B095', tx: '#5A4A38' },
};

const CRITICAL_BD = '#C04848';

const DAY_MS = 86_400_000;

function parseDate(s: string): Date {
  return new Date(s + 'T00:00:00');
}
function daysBetween(a: string, b: string): number {
  return Math.round((parseDate(b).getTime() - parseDate(a).getTime()) / DAY_MS);
}
function formatMD(d: string): string {
  const p = d.split('-');
  return `${+p[1]}/${+p[2]}`;
}

// Tick marks every Monday between range
function mondays(start: string, end: string): string[] {
  const out: string[] = [];
  const d = parseDate(start);
  // Roll forward to next Monday (or stay if it is one)
  const day = d.getDay();
  const offset = day === 1 ? 0 : (day === 0 ? 1 : 8 - day);
  d.setDate(d.getDate() + offset);
  const endD = parseDate(end);
  while (d <= endD) {
    out.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 7);
  }
  return out;
}

export default function LaunchTimelineV1() {
  // Range: from a few days before today to D-Day + small pad
  const RANGE_START = '2026-05-12';
  const RANGE_END = '2026-07-19';
  const totalDays = daysBetween(RANGE_START, RANGE_END);

  // Convert date → percentage within range [0..100]
  const pct = (d: string) => (daysBetween(RANGE_START, d) / totalDays) * 100;

  const ticks = useMemo(() => mondays(RANGE_START, RANGE_END), []);
  const todayPct = pct(TODAY);
  const ddayPct = pct(D_DAY);

  return (
    <div style={{
      background: '#FFFFFF',
      border: '1px solid #E5E8EB',
      borderRadius: 12,
      padding: '20px 22px 18px',
      fontFamily: 'inherit',
      color: '#191F28',
    }}>
      {/* ── Header ───────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap', marginBottom: 4 }}>
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700, color: '#191F28', letterSpacing: '-0.01em' }}>
          Peacer V1 타임라인
        </h2>
        <span style={{ fontSize: 12, color: '#8B95A1', fontWeight: 500 }}>
          5/13 기준 · 순차 시나리오
        </span>
      </div>
      <div style={{ fontSize: 12, color: '#8B95A1', marginBottom: 14 }}>
        메타폴리아 리드타임 3주 (원부자재 입고 후) · 예상 출고 <strong style={{ color: '#4E5968' }}>7/17</strong>
      </div>

      {/* ── Scrollable chart area ───────────────── */}
      <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch', margin: '0 -22px', padding: '0 22px' }}>
        <div style={{ minWidth: 700, position: 'relative' }}>
          {/* Date axis */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: '110px 1fr',
            marginBottom: 8,
          }}>
            <div /> {/* spacer for lane labels */}
            <div style={{ position: 'relative', height: 18 }}>
              {ticks.map(d => (
                <div key={d} style={{
                  position: 'absolute',
                  left: `${pct(d)}%`,
                  transform: 'translateX(-50%)',
                  fontSize: 10.5,
                  color: '#8B95A1',
                  fontWeight: 500,
                  whiteSpace: 'nowrap',
                }}>
                  {formatMD(d)}
                </div>
              ))}
            </div>
          </div>

          {/* Chart body */}
          <div style={{ position: 'relative' }}>
            {/* Vertical guide lines for ticks */}
            <div style={{ position: 'absolute', top: 0, bottom: 24, left: 110, right: 0, pointerEvents: 'none' }}>
              {ticks.map(d => (
                <div key={d} style={{
                  position: 'absolute',
                  left: `${(daysBetween(RANGE_START, d) / totalDays) * 100}%`,
                  top: 0, bottom: 0, width: 0,
                  borderLeft: '1px dashed #F2F4F6',
                }} />
              ))}
            </div>

            {/* TODAY line (5/13) */}
            <div style={{
              position: 'absolute',
              left: `calc(110px + ${todayPct}% - ${todayPct * 1.1}px)`,
              // We need a div positioned within the bar area. Switch strategy:
              display: 'none',
            }} />

            {/* Lanes */}
            {LANES.map((lane, i) => (
              <LaneRow key={lane.name} lane={lane} pct={pct} zebra={i % 2 === 1} />
            ))}

            {/* Overlay: today + dday lines, sized to bar area */}
            <div style={{ position: 'absolute', top: 0, bottom: 24, left: 110, right: 0, pointerEvents: 'none' }}>
              {/* Today line */}
              <div style={{
                position: 'absolute',
                left: `${todayPct}%`,
                top: 0, bottom: 0, width: 0,
                borderLeft: '1.5px dashed #C04848',
              }}>
                <span style={{
                  position: 'absolute', top: -22, left: 0, transform: 'translateX(-50%)',
                  fontSize: 10, fontWeight: 700, color: '#C04848',
                  background: '#FFFFFF', padding: '0 4px',
                  whiteSpace: 'nowrap',
                }}>오늘</span>
              </div>
              {/* D-day line */}
              <div style={{
                position: 'absolute',
                left: `${ddayPct}%`,
                top: 0, bottom: 0, width: 0,
                borderLeft: '1.5px dashed #2E7A4E',
              }}>
                <span style={{
                  position: 'absolute', bottom: 0, left: 0, transform: 'translate(-50%, 100%)',
                  fontSize: 10, fontWeight: 700, color: '#2E7A4E',
                  background: '#FFFFFF', padding: '2px 4px', marginTop: 2, whiteSpace: 'nowrap',
                }}>D-Day 7/17</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Footer callouts ──────────────────────── */}
      <div style={{
        marginTop: 18,
        padding: '11px 14px',
        background: '#FAF6F4',
        border: '1px solid #F0E0DC',
        borderRadius: 8,
        fontSize: 12,
        color: '#4E5968',
        lineHeight: 1.7,
      }}>
        <div>
          <span style={{ color: '#C04848', fontWeight: 700 }}>★ 크리티컬 패스</span>
          <span style={{ margin: '0 6px', color: '#C5CCD3' }}>·</span>
          개별포장(30일) → <strong>6/22</strong> → 제조 3주 → <strong>7/13</strong> → QC → <strong>7/17</strong>
        </div>
        <div style={{ marginTop: 4 }}>
          <span style={{ color: '#8B5A3C', fontWeight: 700 }}>★ 미확정</span>
          <span style={{ margin: '0 6px', color: '#C5CCD3' }}>·</span>
          메타폴리아 답변 대기 — 포장재 입고 전 제조 병행 가능? YES면 <strong>-2~3주 단축</strong>
        </div>
      </div>
    </div>
  );
}

function LaneRow({ lane, pct, zebra }: { lane: Lane; pct: (d: string) => number; zebra: boolean }) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '110px 1fr',
      alignItems: 'center',
      minHeight: 44,
      background: zebra ? '#FAFAF8' : 'transparent',
    }}>
      {/* Lane label */}
      <div style={{
        padding: '8px 12px 8px 4px',
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
      }}>
        <div style={{ fontSize: 12.5, fontWeight: 600, color: '#191F28', letterSpacing: '-0.01em' }}>
          {lane.name}
        </div>
        {lane.detail && (
          <div style={{ fontSize: 10, color: '#8B95A1', marginTop: 2 }}>
            {lane.detail}
          </div>
        )}
      </div>

      {/* Bars area */}
      <div style={{ position: 'relative', height: 44 }}>
        {lane.bars.map((b, i) => {
          const left = pct(b.start);
          const right = pct(b.end);
          const width = Math.max(0.6, right - left);
          const tone = TONES[b.tone];
          const isPoint = b.start === b.end;
          const durationDays = Math.max(0, daysBetween(b.start, b.end));
          // Narrow bars: render label outside (to the right) instead of inside
          const labelOutside = !isPoint && durationDays < 5 && !!b.label;
          return (
            <React.Fragment key={i}>
              <div
                style={{
                  position: 'absolute',
                  top: (44 - 24) / 2,
                  left: `${left}%`,
                  width: isPoint ? 'auto' : `${width}%`,
                  minWidth: isPoint ? 28 : 14,
                  height: 24,
                  background: tone.bg,
                  border: `${b.critical ? 1.6 : 1.2}px solid ${b.critical ? CRITICAL_BD : tone.bd}`,
                  borderRadius: 5,
                  display: 'flex', alignItems: 'center', justifyContent: isPoint ? 'center' : 'flex-start',
                  padding: isPoint ? '0 6px' : labelOutside ? '0' : '0 7px',
                  overflow: 'hidden',
                  boxShadow: b.critical ? '0 0 0 2px rgba(192,72,72,0.08)' : undefined,
                }}
                title={`${b.label || lane.name} (${formatMD(b.start)} – ${formatMD(b.end)})`}
              >
                {!labelOutside && (b.label || isPoint) && (
                  <span style={{
                    fontSize: 10.5, fontWeight: 600, color: b.critical ? CRITICAL_BD : tone.tx,
                    whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                  }}>
                    {b.label || formatMD(b.start)}
                  </span>
                )}
              </div>
              {labelOutside && (
                <div style={{
                  position: 'absolute',
                  top: '50%', transform: 'translateY(-50%)',
                  left: `calc(${right}% + 6px)`,
                  fontSize: 10.5, fontWeight: 600,
                  color: b.critical ? CRITICAL_BD : tone.tx,
                  whiteSpace: 'nowrap',
                }}>
                  {b.label}
                </div>
              )}
              {b.endNote && (
                <div style={{
                  position: 'absolute',
                  top: '50%', transform: 'translateY(-50%)',
                  left: `calc(${right}% + 6px)`,
                  fontSize: 10, color: '#8B95A1', fontWeight: 500,
                  whiteSpace: 'nowrap',
                  // If label is outside, push endNote further right to avoid overlap
                  marginLeft: labelOutside ? `${(b.label?.length || 0) * 7 + 4}px` : 0,
                }}>
                  {b.endNote}
                </div>
              )}
            </React.Fragment>
          );
        })}
      </div>
    </div>
  );
}
