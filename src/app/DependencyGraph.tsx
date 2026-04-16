'use client';

import React, { useMemo, useState, useRef, useEffect, useCallback } from 'react';
import type { AppTask } from '@/lib/criticalPath';
import { CC, fD, dU } from '@/lib/constants';

// ── Swim lane config ──
const LANES: { key: string; label: string; match: (t: AppTask) => boolean }[] = [
  { key: 'product', label: '제품', match: (t) => t.category === '제품' || t.category === '제조' || t.category === '디자인' },
  { key: 'ops', label: '운영', match: (t) => t.category === '운영' || t.category === '사업자/인허가' || t.category === '계약' },
  { key: 'marketing', label: '마케팅', match: (t) => t.category === '마케팅' },
  { key: 'etc', label: '기타', match: (t) => !['제품', '운영', '마케팅', '제조', '디자인', '사업자/인허가', '계약'].includes(t.category) },
];

// ── Layout constants ──
const LANE_LABEL_W = 90;
const CARD_W = 160;
const CARD_H = 72;
const CARD_GAP_Y = 10;
const HEADER_H = 32;
const DAY_MIN_W = 56;
const LANE_PAD_TOP = 12;
const LANE_PAD_BOT = 16;

// ── Status colors ──
const statusColor = (s: string) => {
  if (s === 'doing') return { bg: '#EFEBFA', bd: '#A896C4', tx: '#5F4B82' };
  if (s === 'waiting') return { bg: '#F5EEE6', bd: '#C4A896', tx: '#8B5A3C' };
  if (s === 'done') return { bg: '#F2F4F6', bd: '#D1D6DB', tx: '#8B95A1' };
  return { bg: '#FAF6EF', bd: '#DDD3C2', tx: '#1A1613' }; // todo
};

const statusLabel = (s: string) => {
  if (s === 'doing') return '진행중';
  if (s === 'waiting') return '대기';
  if (s === 'done') return '완료';
  return '시작 전';
};

// ── Critical path: reverse DFS using remaining-days cost ──
function findCriticalPath(tasks: AppTask[], shipDate: string): Set<string> {
  const byId: Record<string, AppTask> = {};
  tasks.forEach(t => { byId[t.id] = t; });

  // Build forward graph: task → tasks it blocks
  const blocks: Record<string, string[]> = {};
  tasks.forEach(t => {
    (t.dependsOn || []).forEach(depId => {
      if (!blocks[depId]) blocks[depId] = [];
      blocks[depId].push(t.id);
    });
  });

  // Find sink nodes (tasks that block nothing and are not done)
  const sinks = tasks.filter(t => (!blocks[t.id] || blocks[t.id].length === 0) && t.status !== 'done');

  // Cost = remaining days until deadline (negative = overdue = highest urgency)
  const taskCost = (t: AppTask): number => {
    if (t.status === 'done') return 0;
    if (!t.deadline) return 14; // assume 2 weeks for unscheduled
    return Math.max(1, dU(t.deadline));
  };

  // DFS backwards from each sink — find path with highest total cost (most time-consuming)
  const memo: Record<string, { path: string[]; cost: number }> = {};
  function costliestPathFrom(id: string, visited: Set<string>): { path: string[]; cost: number } {
    if (memo[id]) return memo[id];
    if (visited.has(id)) return { path: [id], cost: taskCost(byId[id]) };
    visited.add(id);
    const t = byId[id];
    if (!t) return { path: [id], cost: 0 };
    const deps = (t.dependsOn || []).filter(d => byId[d] && byId[d].status !== 'done');
    const myCost = taskCost(t);
    if (deps.length === 0) {
      memo[id] = { path: [id], cost: myCost };
      return memo[id];
    }
    let best = { path: [] as string[], cost: 0 };
    for (const dep of deps) {
      const sub = costliestPathFrom(dep, new Set(visited));
      if (sub.cost > best.cost) best = sub;
    }
    memo[id] = { path: [...best.path, id], cost: best.cost + myCost };
    return memo[id];
  }

  let criticalChain: string[] = [];
  let maxCost = 0;
  for (const sink of sinks) {
    const { path, cost } = costliestPathFrom(sink.id, new Set());
    if (cost > maxCost) { criticalChain = path; maxCost = cost; }
  }

  return new Set(criticalChain);
}

// ── Date helpers ──
function dateRange(startStr: string, endStr: string): string[] {
  const dates: string[] = [];
  const start = new Date(startStr + 'T00:00:00');
  const end = new Date(endStr + 'T00:00:00');
  const d = new Date(start);
  while (d <= end) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function dayLabel(d: string): string {
  const day = new Date(d + 'T00:00:00').getDay();
  return ['일', '월', '화', '수', '목', '금', '토'][day];
}

function isWeekend(d: string): boolean {
  const day = new Date(d + 'T00:00:00').getDay();
  return day === 0 || day === 6;
}

// ── Main component ──
export default function DependencyGraph({ tasks }: { tasks: AppTask[] }) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [showDone, setShowDone] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const todayStr = new Date().toISOString().slice(0, 10);
  const shipDate = '2026-05-19';

  // Filter tasks: must have deps or be depended upon, or deadline in range
  const allRelevant = useMemo(() => {
    return tasks.filter(t => {
      const hasDeps = (t.dependsOn || []).length > 0;
      const isDepOf = tasks.some(o => (o.dependsOn || []).includes(t.id));
      const inRange = t.deadline && t.deadline >= todayStr && t.deadline <= shipDate;
      return hasDeps || isDepOf || inRange;
    });
  }, [tasks, todayStr]);

  // Apply done filter
  const relevantTasks = useMemo(() => {
    if (showDone) return allRelevant;
    return allRelevant.filter(t => t.status !== 'done');
  }, [allRelevant, showDone]);

  const doneCount = useMemo(() => allRelevant.filter(t => t.status === 'done').length, [allRelevant]);

  // Date axis
  const dates = useMemo(() => dateRange(todayStr, shipDate), [todayStr]);
  const dayW = Math.max(DAY_MIN_W, CARD_W / 3);

  // Tasks with no deadline → separate "unscheduled" bucket
  const { scheduled, unscheduled } = useMemo(() => {
    const scheduled: AppTask[] = [];
    const unscheduled: AppTask[] = [];
    relevantTasks.forEach(t => {
      if (t.deadline) scheduled.push(t);
      else unscheduled.push(t);
    });
    return { scheduled, unscheduled };
  }, [relevantTasks]);

  // Assign tasks to lanes (scheduled only for main chart)
  const laneData = useMemo(() => {
    return LANES.map(lane => {
      const laneTasks = scheduled.filter(lane.match);
      return { ...lane, tasks: laneTasks };
    }).filter(l => l.tasks.length > 0);
  }, [scheduled]);

  // Critical path (computed on all tasks, not just visible)
  const criticalSet = useMemo(() => findCriticalPath(tasks, shipDate), [tasks]);

  // Card positions
  const { positions, laneYOffsets, totalHeight, totalWidth } = useMemo(() => {
    const positions: Record<string, { x: number; y: number; laneIdx: number }> = {};
    const laneYOffsets: number[] = [];
    let currentY = HEADER_H + 4;

    const dateToX = (d: string | null): number => {
      if (!d) return (dates.length - 1) * dayW;
      const idx = dates.indexOf(d);
      if (idx >= 0) return idx * dayW;
      if (d < dates[0]) return 0;
      return (dates.length - 1) * dayW;
    };

    for (let li = 0; li < laneData.length; li++) {
      const lane = laneData[li];
      laneYOffsets.push(currentY);

      const sorted = [...lane.tasks].sort((a, b) => {
        const da = a.deadline || '9999-12-31';
        const db = b.deadline || '9999-12-31';
        if (da !== db) return da < db ? -1 : 1;
        return a.id < b.id ? -1 : 1;
      });

      const placed: { x: number; y: number; right: number }[] = [];
      for (const t of sorted) {
        const x = dateToX(t.deadline) - CARD_W / 2;
        let row = 0;
        while (true) {
          const y = LANE_PAD_TOP + row * (CARD_H + CARD_GAP_Y);
          const overlap = placed.some(p =>
            p.y === y && !(x >= p.right + 8 || x + CARD_W + 8 <= p.x)
          );
          if (!overlap) {
            placed.push({ x, y, right: x + CARD_W });
            positions[t.id] = { x: Math.max(0, x), y: currentY + LANE_PAD_TOP + row * (CARD_H + CARD_GAP_Y), laneIdx: li };
            break;
          }
          row++;
        }
      }

      const maxRows = Math.max(1, placed.reduce((m, p) => {
        const r = Math.round((p.y - LANE_PAD_TOP) / (CARD_H + CARD_GAP_Y));
        return Math.max(m, r + 1);
      }, 0));
      currentY += LANE_PAD_TOP + maxRows * (CARD_H + CARD_GAP_Y) + LANE_PAD_BOT;
    }

    return {
      positions,
      laneYOffsets,
      totalHeight: currentY + 20,
      totalWidth: LANE_LABEL_W + dates.length * dayW + 20,
    };
  }, [laneData, dates, dayW]);

  // Scroll to today on mount
  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollLeft = 0;
  }, []);

  const byId: Record<string, AppTask> = {};
  tasks.forEach(t => { byId[t.id] = t; });

  // Edge path helper
  const getEdgePath = useCallback((fromId: string, toId: string): string | null => {
    const from = positions[fromId];
    const to = positions[toId];
    if (!from || !to) return null;

    const x1 = LANE_LABEL_W + from.x + CARD_W;
    const y1 = from.y + CARD_H / 2;
    const x2 = LANE_LABEL_W + to.x;
    const y2 = to.y + CARD_H / 2;

    const dx = x2 - x1;
    const cp = Math.max(30, Math.abs(dx) * 0.3);
    return `M${x1},${y1} C${x1 + cp},${y1} ${x2 - cp},${y2} ${x2},${y2}`;
  }, [positions]);

  // Collect all edges
  const edges = useMemo(() => {
    const result: { from: string; to: string; critical: boolean }[] = [];
    for (const t of relevantTasks) {
      for (const depId of (t.dependsOn || [])) {
        if (positions[depId] && positions[t.id]) {
          const critical = criticalSet.has(depId) && criticalSet.has(t.id);
          result.push({ from: depId, to: t.id, critical });
        }
      }
    }
    return result;
  }, [relevantTasks, positions, criticalSet]);

  const selectedTask = selectedId ? byId[selectedId] : null;

  // Active focus: clicked card takes priority over hover
  const focusId = selectedId || hoveredId;
  const connectedToFocus = useMemo(() => {
    if (!focusId) return new Set<string>();
    const ids = new Set<string>([focusId]);
    const addUpstream = (id: string) => {
      const t = tasks.find(x => x.id === id);
      if (!t) return;
      (t.dependsOn || []).forEach(depId => {
        if (!ids.has(depId)) { ids.add(depId); addUpstream(depId); }
      });
    };
    const addDownstream = (id: string) => {
      tasks.forEach(t => {
        if ((t.dependsOn || []).includes(id) && !ids.has(t.id)) {
          ids.add(t.id);
          addDownstream(t.id);
        }
      });
    };
    addUpstream(focusId);
    addDownstream(focusId);
    return ids;
  }, [focusId, tasks]);

  const hasFocus = focusId !== null;

  // Is this edge connected to focused task?
  const isEdgeHighlighted = (e: { from: string; to: string }) => {
    if (!hasFocus) return true;
    return connectedToFocus.has(e.from) && connectedToFocus.has(e.to);
  };

  return (
    <div style={{ position: 'relative' }}>
      {/* Title bar */}
      <div style={{
        padding: '14px 16px 10px',
        display: 'flex', alignItems: 'baseline', gap: 12, flexWrap: 'wrap',
      }}>
        <h3 style={{ margin: 0, fontSize: 15, fontWeight: 600, color: '#1A1613', letterSpacing: '-0.01em' }}>
          어떤 태스크가 어떤 태스크를 막고 있는가
        </h3>
        <p style={{ margin: 0, fontSize: 12, color: '#8A7D72', lineHeight: 1.5 }}>
          선으로 이어진 것들은 앞 태스크가 끝나야 뒤 태스크를 시작할 수 있음.
          <span style={{ color: '#B84848', fontWeight: 500 }}> 붉은 선</span>은 {fD(shipDate)} 출시까지의 크리티컬 패스.
        </p>
      </div>

      {/* Legend + controls */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 16, padding: '0 16px 10px',
        fontSize: 11, color: '#8A7D72', flexWrap: 'wrap',
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#5F4B82' }} /> 진행 중
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#1A1613' }} /> 시작 전
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="24" height="2"><line x1="0" y1="1" x2="24" y2="1" stroke="#C4B8A8" strokeWidth="1.5" /></svg>
          의존 관계
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <svg width="24" height="2"><line x1="0" y1="1" x2="24" y2="1" stroke="#B84848" strokeWidth="2" /></svg>
          크리티컬 패스
        </span>

        {/* Done toggle */}
        <button
          onClick={() => setShowDone(!showDone)}
          style={{
            marginLeft: 'auto',
            padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 500,
            background: showDone ? '#EBF3E6' : '#F2F4F6',
            color: showDone ? '#3E5A2E' : '#8B95A1',
            border: `1px solid ${showDone ? '#A8C496' : '#E5E8EB'}`,
            cursor: 'pointer',
          }}
        >
          {showDone ? `완료 ${doneCount}개 숨기기` : `완료 ${doneCount}개 보기`}
        </button>
      </div>

      {/* Scrollable graph area */}
      <div
        ref={scrollRef}
        style={{
          overflowX: 'auto',
          overflowY: 'hidden',
          WebkitOverflowScrolling: 'touch',
          position: 'relative',
        }}
      >
        <div
          onClick={(e) => { if (e.target === e.currentTarget) setSelectedId(null); }}
          style={{ minWidth: totalWidth, position: 'relative', height: totalHeight }}
        >
          {/* Lane labels (absolute, left side) */}
          <div style={{
            position: 'absolute', left: 0, top: 0,
            width: LANE_LABEL_W, height: totalHeight,
            zIndex: 10, background: '#FAFAF8',
            borderRight: '1px solid #E8DFCE',
            pointerEvents: 'none',
          }}>
            {laneData.map((lane, i) => (
              <div key={lane.key} style={{
                position: 'absolute',
                top: laneYOffsets[i],
                left: 0,
                width: LANE_LABEL_W,
                padding: '8px 12px',
                fontSize: 12,
                fontWeight: 600,
                color: '#4E5968',
                letterSpacing: '-0.01em',
              }}>
                {lane.label}
              </div>
            ))}
          </div>

          {/* Date header */}
          <div style={{
            position: 'sticky',
            top: 0,
            marginLeft: LANE_LABEL_W,
            height: HEADER_H,
            display: 'flex',
            zIndex: 5,
            background: '#FAFAF8',
            borderBottom: '1px solid #E8DFCE',
          }}>
            {dates.map((d, i) => {
              const isToday = d === todayStr;
              const isShip = d === shipDate;
              const showLabel = isToday || isShip || i % 3 === 0;
              return (
                <div key={d} style={{
                  width: dayW,
                  flexShrink: 0,
                  display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
                  fontSize: 10,
                  fontWeight: isToday || isShip ? 700 : 400,
                  color: isToday ? '#B84848' : isShip ? '#5F4B82' : isWeekend(d) ? '#C4A896' : '#8A7D72',
                  borderRight: '1px solid #F2F0EC',
                  background: isWeekend(d) ? 'rgba(0,0,0,.015)' : 'transparent',
                }}>
                  {showLabel && (
                    <>
                      <span>{fD(d)}</span>
                      <span style={{ fontSize: 9 }}>{isToday ? 'TODAY' : isShip ? '출시' : dayLabel(d)}</span>
                    </>
                  )}
                </div>
              );
            })}
          </div>

          {/* Lane backgrounds */}
          {laneData.map((lane, i) => {
            const nextY = i < laneData.length - 1 ? laneYOffsets[i + 1] : totalHeight - 20;
            const h = nextY - laneYOffsets[i];
            return (
              <div
                key={lane.key + '-bg'}
                onClick={() => setSelectedId(null)}
                style={{
                  position: 'absolute',
                  top: laneYOffsets[i],
                  left: LANE_LABEL_W,
                  right: 0,
                  height: h,
                  borderBottom: '1px solid #F2F0EC',
                  background: i % 2 === 0 ? 'transparent' : 'rgba(0,0,0,.01)',
                  cursor: selectedId ? 'pointer' : 'default',
                }}
              />
            );
          })}

          {/* Today vertical line */}
          {dates.indexOf(todayStr) >= 0 && (
            <div style={{
              position: 'absolute',
              left: LANE_LABEL_W + dates.indexOf(todayStr) * dayW + dayW / 2,
              top: HEADER_H,
              bottom: 0,
              width: 0,
              borderLeft: '1.5px dashed #B84848',
              opacity: 0.5,
              zIndex: 3,
            }} />
          )}

          {/* Ship date vertical line */}
          {dates.indexOf(shipDate) >= 0 && (
            <div style={{
              position: 'absolute',
              left: LANE_LABEL_W + dates.indexOf(shipDate) * dayW + dayW / 2,
              top: HEADER_H,
              bottom: 0,
              width: 0,
              borderLeft: '1.5px dashed #5F4B82',
              opacity: 0.4,
              zIndex: 3,
            }} />
          )}

          {/* Task cards — rendered BEFORE SVG so edges appear ON TOP */}
          {relevantTasks.map(t => {
            const pos = positions[t.id];
            if (!pos) return null;
            const sc = statusColor(t.status);
            const isCritical = criticalSet.has(t.id);
            const isSelected = selectedId === t.id;
            const isHovered = hoveredId === t.id;
            const isFaded = hasFocus && !connectedToFocus.has(t.id);
            const catColor = CC[t.category] || CC['기타'];
            return (
              <div
                key={t.id}
                onClick={(e) => { e.stopPropagation(); setSelectedId(isSelected ? null : t.id); setHoveredId(null); }}
                onMouseEnter={() => { if (!selectedId) setHoveredId(t.id); }}
                onMouseLeave={() => { if (!selectedId) setHoveredId(null); }}
                style={{
                  position: 'absolute',
                  left: LANE_LABEL_W + pos.x,
                  top: pos.y,
                  width: CARD_W,
                  height: CARD_H,
                  background: isSelected ? '#FFF' : sc.bg,
                  border: `1.5px solid ${isCritical ? '#B84848' : isHovered ? '#5F4B82' : sc.bd}`,
                  borderRadius: 8,
                  padding: '6px 10px',
                  cursor: 'pointer',
                  zIndex: isSelected ? 20 : isHovered ? 8 : 4,
                  opacity: isFaded ? 0.25 : 1,
                  boxShadow: isSelected
                    ? '0 4px 16px rgba(0,0,0,.12)'
                    : isHovered
                      ? '0 2px 8px rgba(0,0,0,.08)'
                      : isCritical
                        ? '0 0 0 1px rgba(184,72,72,.15)'
                        : 'none',
                  transition: 'opacity .15s, box-shadow .15s, border-color .15s',
                  overflow: 'hidden',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'space-between',
                }}
              >
                {/* Top: id + status */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span style={{
                    fontSize: 9, color: '#8A7D72', fontWeight: 500,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>
                    {t.id.toUpperCase()}
                  </span>
                  {t.status !== 'todo' && (
                    <span style={{
                      fontSize: 8, fontWeight: 600, padding: '1px 5px', borderRadius: 100,
                      background: sc.bd, color: '#FFF',
                      textTransform: 'uppercase',
                    }}>
                      {statusLabel(t.status)}
                    </span>
                  )}
                </div>

                {/* Title */}
                <div style={{
                  fontSize: 11, fontWeight: 600, color: sc.tx,
                  lineHeight: 1.3,
                  overflow: 'hidden', textOverflow: 'ellipsis',
                  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical',
                  flex: 1,
                  marginTop: 2,
                }}>
                  {t.title}
                </div>

                {/* Bottom: category + deadline */}
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 4 }}>
                  <span style={{
                    fontSize: 9, padding: '0px 5px', borderRadius: 100, fontWeight: 500,
                    background: catColor.bg, color: catColor.tx, border: `1px solid ${catColor.bd}`,
                  }}>
                    {t.category}
                  </span>
                  {t.deadline && (
                    <span style={{
                      fontSize: 10, fontWeight: 600,
                      color: isCritical ? '#B84848' : dU(t.deadline) < 0 ? '#B84848' : '#8A7D72',
                    }}>
                      {fD(t.deadline)}
                    </span>
                  )}
                </div>
              </div>
            );
          })}

          {/* SVG edges — z-index 6 = ABOVE cards (4) but below selected (20) */}
          <svg
            style={{
              position: 'absolute', top: 0, left: 0,
              width: totalWidth, height: totalHeight,
              pointerEvents: 'none', zIndex: 6,
            }}
          >
            <defs>
              <marker id="arrow-gray" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6" fill="none" stroke="#C4B8A8" strokeWidth="1" />
              </marker>
              <marker id="arrow-red" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6" fill="none" stroke="#B84848" strokeWidth="1.2" />
              </marker>
              <marker id="arrow-purple" markerWidth="6" markerHeight="6" refX="5" refY="3" orient="auto">
                <path d="M0,0 L6,3 L0,6" fill="none" stroke="#5F4B82" strokeWidth="1.2" />
              </marker>
            </defs>
            {/* Non-critical edges first */}
            {edges.filter(e => !e.critical).map((e, i) => {
              const path = getEdgePath(e.from, e.to);
              if (!path) return null;
              const highlighted = isEdgeHighlighted(e);
              return (
                <path
                  key={`e-${i}`}
                  d={path}
                  fill="none"
                  stroke={hasFocus && highlighted ? '#5F4B82' : '#C4B8A8'}
                  strokeWidth={hasFocus && highlighted ? 1.8 : 1.2}
                  strokeOpacity={hasFocus ? (highlighted ? 0.8 : 0.1) : 0.5}
                  markerEnd={hasFocus && highlighted ? 'url(#arrow-purple)' : 'url(#arrow-gray)'}
                  style={{ transition: 'stroke-opacity .15s, stroke .15s' }}
                />
              );
            })}
            {/* Critical edges on top */}
            {edges.filter(e => e.critical).map((e, i) => {
              const path = getEdgePath(e.from, e.to);
              if (!path) return null;
              const highlighted = isEdgeHighlighted(e);
              return (
                <path
                  key={`ce-${i}`}
                  d={path}
                  fill="none"
                  stroke="#B84848"
                  strokeWidth={2}
                  strokeOpacity={hasFocus ? (highlighted ? 1 : 0.1) : 1}
                  markerEnd="url(#arrow-red)"
                  style={{ transition: 'stroke-opacity .15s' }}
                />
              );
            })}
          </svg>
        </div>
      </div>

      {/* Unscheduled tasks (no deadline) */}
      {unscheduled.length > 0 && (
        <div style={{
          margin: '8px 16px 4px',
          padding: '8px 12px',
          background: '#FAF6EF',
          border: '1px solid #E8DFCE',
          borderRadius: 8,
          fontSize: 11,
        }}>
          <div style={{ fontSize: 11, fontWeight: 600, color: '#8A7D72', marginBottom: 6 }}>
            마감일 미정 ({unscheduled.length}개)
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {unscheduled.map(t => {
              const sc = statusColor(t.status);
              const isCritical = criticalSet.has(t.id);
              return (
                <span
                  key={t.id}
                  onClick={() => setSelectedId(selectedId === t.id ? null : t.id)}
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 4,
                    padding: '3px 8px', borderRadius: 6,
                    background: sc.bg,
                    border: `1px solid ${isCritical ? '#B84848' : sc.bd}`,
                    cursor: 'pointer', fontWeight: 500, color: sc.tx,
                    fontSize: 10,
                  }}
                >
                  {isCritical && <span style={{ width: 5, height: 5, borderRadius: '50%', background: '#B84848' }} />}
                  {t.title}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Selected task detail panel */}
      {selectedTask && (
        <div style={{
          margin: '4px 16px 8px',
          padding: '12px 16px',
          background: '#FFF',
          border: '1px solid #E8DFCE',
          borderRadius: 10,
          fontSize: 12,
          color: '#4E5968',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 8 }}>
            <div>
              <span style={{ fontSize: 10, color: '#8A7D72', fontWeight: 500 }}>{selectedTask.id.toUpperCase()}</span>
              <h4 style={{ margin: '2px 0 0', fontSize: 14, fontWeight: 600, color: '#1A1613' }}>{selectedTask.title}</h4>
            </div>
            <button
              onClick={() => setSelectedId(null)}
              style={{ background: 'none', border: 'none', fontSize: 18, color: '#8A7D72', cursor: 'pointer', padding: '0 4px' }}
            >×</button>
          </div>

          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 11 }}>
            <div>
              <span style={{ color: '#8A7D72' }}>상태 </span>
              <span style={{ fontWeight: 600 }}>{statusLabel(selectedTask.status)}</span>
            </div>
            <div>
              <span style={{ color: '#8A7D72' }}>담당 </span>
              <span style={{ fontWeight: 600 }}>{selectedTask.owner}</span>
            </div>
            <div>
              <span style={{ color: '#8A7D72' }}>마감 </span>
              <span style={{ fontWeight: 600, color: selectedTask.deadline && dU(selectedTask.deadline) < 0 ? '#B84848' : '#1A1613' }}>
                {selectedTask.deadline ? fD(selectedTask.deadline) : '없음'}
              </span>
            </div>
            <div>
              <span style={{ color: '#8A7D72' }}>분류 </span>
              <span style={{ fontWeight: 600 }}>{selectedTask.category}</span>
            </div>
            {criticalSet.has(selectedTask.id) && (
              <span style={{
                fontSize: 10, fontWeight: 600, padding: '1px 8px', borderRadius: 100,
                background: '#FDE8E8', color: '#B84848', border: '1px solid #F0C4C4',
              }}>
                크리티컬 패스
              </span>
            )}
          </div>

          {/* Dependencies */}
          {(selectedTask.dependsOn || []).length > 0 && (
            <div style={{ marginTop: 8 }}>
              <span style={{ fontSize: 10, color: '#8A7D72', fontWeight: 500 }}>선행 태스크:</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                {(selectedTask.dependsOn || []).map(depId => {
                  const dep = byId[depId];
                  if (!dep) return null;
                  return (
                    <span
                      key={depId}
                      onClick={() => setSelectedId(depId)}
                      style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 6,
                        background: dep.status === 'done' ? '#EBF3E6' : '#FAF6EF',
                        border: `1px solid ${dep.status === 'done' ? '#A8C496' : '#DDD3C2'}`,
                        cursor: 'pointer', fontWeight: 500,
                        color: dep.status === 'done' ? '#3E5A2E' : '#4E5968',
                        textDecoration: dep.status === 'done' ? 'line-through' : 'none',
                      }}
                    >
                      {dep.title}
                    </span>
                  );
                })}
              </div>
            </div>
          )}

          {/* Blocks */}
          {(() => {
            const blocked = tasks.filter(t2 => (t2.dependsOn || []).includes(selectedTask.id));
            if (blocked.length === 0) return null;
            return (
              <div style={{ marginTop: 8 }}>
                <span style={{ fontSize: 10, color: '#8A7D72', fontWeight: 500 }}>이 태스크가 막고 있는:</span>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 4 }}>
                  {blocked.map(b => (
                    <span
                      key={b.id}
                      onClick={() => setSelectedId(b.id)}
                      style={{
                        fontSize: 10, padding: '2px 8px', borderRadius: 6,
                        background: '#FAF6EF', border: '1px solid #DDD3C2',
                        cursor: 'pointer', fontWeight: 500, color: '#4E5968',
                      }}
                    >
                      {b.title}
                    </span>
                  ))}
                </div>
              </div>
            );
          })()}

          {/* Note */}
          {selectedTask.note && (
            <div style={{ marginTop: 8, padding: '8px 10px', background: '#FAF6EF', borderRadius: 6, fontSize: 11, color: '#4E5968', lineHeight: 1.5 }}>
              {selectedTask.note}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
