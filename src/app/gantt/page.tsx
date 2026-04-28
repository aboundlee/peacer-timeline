'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, dbToApp } from '@/lib/supabase';
import type { AppTask } from '@/lib/criticalPath';
import { fD, dU } from '@/lib/constants';

const SHIP_DATE = '2026-05-19';
const BUFFER_END_DATE = '2026-06-02'; // 2주 risk buffer
const DAY_W = 18; // px per day
const LANE_LABEL_W = 110;
const LANE_H = 56;
const HEADER_H = 56;

// Status colors for bars
const statusColor = (s: string) => {
  if (s === 'done') return { bg: '#EBF3E6', bd: '#A8C496', tx: '#3E5A2E' };
  if (s === 'doing') return { bg: '#EFEBFA', bd: '#A896C4', tx: '#5F4B82' };
  if (s === 'waiting') return { bg: '#F5EEE6', bd: '#C4A896', tx: '#8B5A3C' };
  return { bg: '#FAF6EF', bd: '#DDD3C2', tx: '#8A7D72' };
};

// ── Date helpers ──
function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

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

// ── Compute start date for a task ──
function computeStart(task: AppTask, byId: Record<string, AppTask>): string | null {
  const deps = (task.dependsOn || []).filter(d => byId[d]);
  if (deps.length > 0) {
    const depEnds = deps.map(d => byId[d].deadline).filter(Boolean) as string[];
    if (depEnds.length > 0) {
      const maxDepEnd = depEnds.reduce((a, b) => a > b ? a : b);
      // Start = day after max dep deadline
      return addDays(maxDepEnd, 1);
    }
  }
  // No deps: assume 3-day duration ending on deadline
  if (task.deadline) return addDays(task.deadline, -2);
  return null;
}

// ── Critical path (cost = remaining days) ──
function findCriticalPath(tasks: AppTask[]): Set<string> {
  const byId: Record<string, AppTask> = {};
  tasks.forEach(t => { byId[t.id] = t; });
  const blocks: Record<string, string[]> = {};
  tasks.forEach(t => {
    (t.dependsOn || []).forEach(depId => {
      if (!blocks[depId]) blocks[depId] = [];
      blocks[depId].push(t.id);
    });
  });
  const sinks = tasks.filter(t => (!blocks[t.id] || blocks[t.id].length === 0) && t.status !== 'done');

  const taskCost = (t: AppTask): number => {
    if (t.status === 'done') return 0;
    if (!t.deadline) return 14;
    return Math.max(1, dU(t.deadline));
  };

  const memo: Record<string, { path: string[]; cost: number }> = {};
  function go(id: string, visited: Set<string>): { path: string[]; cost: number } {
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
      const sub = go(dep, new Set(visited));
      if (sub.cost > best.cost) best = sub;
    }
    memo[id] = { path: [...best.path, id], cost: best.cost + myCost };
    return memo[id];
  }
  let bestChain: string[] = [];
  let bestCost = 0;
  for (const sink of sinks) {
    const r = go(sink.id, new Set());
    if (r.cost > bestCost) { bestChain = r.path; bestCost = r.cost; }
  }
  return new Set(bestChain);
}

export default function GanttPage() {
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [expandedLane, setExpandedLane] = useState<string | null>(null);
  const [hideDone, setHideDone] = useState(true);

  const fetchTasks = useCallback(async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { console.error(error); return; }
    if (data) {
      setTasks(data.map(dbToApp));
      setLoaded(true);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  useEffect(() => {
    const ch = supabase
      .channel('gantt-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => fetchTasks())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchTasks]);

  // Determine date range
  const todayStr = useMemo(() => new Date().toISOString().slice(0, 10), []);

  // Build byId, critical set
  const { byId, criticalSet } = useMemo(() => {
    const map: Record<string, AppTask> = {};
    tasks.forEach(t => { map[t.id] = t; });
    return { byId: map, criticalSet: findCriticalPath(tasks) };
  }, [tasks]);

  // Group tasks by pipeline → compute lane spans
  const lanes = useMemo(() => {
    type Lane = {
      name: string;
      start: string;
      end: string;
      tasks: { task: AppTask; start: string; end: string }[];
      hasCritical: boolean;
      done: number;
      total: number;
    };
    const groups: Record<string, AppTask[]> = {};
    tasks.forEach(t => {
      if (!t.pipeline) return;
      if (hideDone && t.status === 'done') {
        // include done in done count but skip from range
      }
      if (!groups[t.pipeline]) groups[t.pipeline] = [];
      groups[t.pipeline].push(t);
    });

    const result: Lane[] = [];
    Object.entries(groups).forEach(([name, group]) => {
      const taskSpans = group
        .map(task => {
          const start = computeStart(task, byId);
          const end = task.deadline;
          return start && end ? { task, start, end } : null;
        })
        .filter((x): x is { task: AppTask; start: string; end: string } => x !== null);

      if (taskSpans.length === 0) return;

      const visibleSpans = hideDone
        ? taskSpans.filter(x => x.task.status !== 'done')
        : taskSpans;

      if (visibleSpans.length === 0) return;

      const start = visibleSpans.reduce((a, b) => a.start < b.start ? a : b).start;
      const end = visibleSpans.reduce((a, b) => a.end > b.end ? a : b).end;
      const hasCritical = group.some(t => criticalSet.has(t.id));
      const done = group.filter(t => t.status === 'done').length;

      result.push({ name, start, end, tasks: taskSpans, hasCritical, done, total: group.length });
    });

    // Sort: critical lanes first, then by start date
    result.sort((a, b) => {
      if (a.hasCritical !== b.hasCritical) return a.hasCritical ? -1 : 1;
      return a.start < b.start ? -1 : 1;
    });
    return result;
  }, [tasks, byId, criticalSet, hideDone]);

  // Compute date axis range — ensure it covers all lanes + ship + today
  const { rangeStart, rangeEnd, dates } = useMemo(() => {
    let minStart = todayStr;
    let maxEnd = BUFFER_END_DATE;
    lanes.forEach(l => {
      if (l.start < minStart) minStart = l.start;
      if (l.end > maxEnd) maxEnd = l.end;
    });
    // Pad with a bit of breathing room
    minStart = addDays(minStart, -3);
    maxEnd = addDays(maxEnd, 5);
    return { rangeStart: minStart, rangeEnd: maxEnd, dates: dateRange(minStart, maxEnd) };
  }, [lanes, todayStr]);

  const dateToX = useCallback((d: string): number => {
    const idx = dates.indexOf(d);
    if (idx >= 0) return idx * DAY_W;
    if (d < dates[0]) return 0;
    return (dates.length - 1) * DAY_W;
  }, [dates]);

  const totalWidth = LANE_LABEL_W + dates.length * DAY_W + 24;

  if (!loaded) {
    return <div style={{ padding: '100px 20px', textAlign: 'center', color: '#8B95A1', fontSize: 13 }}>불러오는 중…</div>;
  }

  return (
    <div style={{ maxWidth: 1400, margin: '0 auto', padding: '24px 20px 80px', fontFamily: 'Pretendard, "Noto Sans KR", sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 6 }}>
          GANTT
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.02em' }}>
          출시 일정
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8B95A1', lineHeight: 1.5 }}>
          오늘 <strong style={{ color: '#4E5968' }}>{fD(todayStr)} (D-{dU(SHIP_DATE)})</strong> →
          출하 <strong style={{ color: '#5F4B82' }}>{fD(SHIP_DATE)}</strong>.
          빨간 막대가 크리티컬 패스, 회색 영역이 리스크 버퍼.
        </p>
      </div>

      {/* Legend + controls */}
      <div style={{
        display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 14px', background: '#FFF', border: '1px solid #E5E8EB', borderRadius: 10,
        marginBottom: 16, fontSize: 11,
      }}>
        <LegendBar color="#B84848" label="크리티컬" />
        <LegendBar color="#A896C4" label="진행중" />
        <LegendBar color="#A8C496" label="완료" />
        <LegendBar color="#DDD3C2" label="대기" />
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#8A7D72' }}>
          <span style={{ width: 14, height: 0, borderTop: '1.5px dashed #B84848' }} />
          오늘
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#8A7D72' }}>
          <span style={{
            width: 12, height: 12, transform: 'rotate(45deg)',
            background: '#E8A04C', display: 'inline-block',
          }} />
          출시
        </span>
        <button
          onClick={() => setHideDone(!hideDone)}
          style={{
            marginLeft: 'auto',
            padding: '3px 10px', borderRadius: 100, fontSize: 11, fontWeight: 500,
            background: hideDone ? '#EFEBFA' : '#F2F4F6',
            color: hideDone ? '#5F4B82' : '#8B95A1',
            border: `1px solid ${hideDone ? '#A896C4' : '#E5E8EB'}`,
            cursor: 'pointer',
          }}
        >
          {hideDone ? '완료 보기' : '완료 숨기기'}
        </button>
      </div>

      {/* Gantt area */}
      {lanes.length === 0 ? (
        <div style={{
          padding: '60px 20px', textAlign: 'center', background: '#FFF',
          border: '1px solid #E5E8EB', borderRadius: 12, color: '#8B95A1',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#4E5968' }}>표시할 일정이 없어요</div>
          <p style={{ fontSize: 12, margin: 0 }}>태스크에 워크스트림과 마감일을 지정해주세요.</p>
        </div>
      ) : (
        <div style={{
          background: '#FFF', border: '1px solid #E5E8EB', borderRadius: 12,
          overflow: 'auto', WebkitOverflowScrolling: 'touch', position: 'relative',
        }}>
          <div style={{ position: 'relative', minWidth: totalWidth }}>
            {/* Date axis */}
            <div style={{
              position: 'sticky', top: 0, zIndex: 10,
              display: 'flex', alignItems: 'flex-end',
              height: HEADER_H,
              background: '#FAFAF8',
              borderBottom: '1px solid #E5E8EB',
              paddingLeft: LANE_LABEL_W,
            }}>
              {dates.map((d, i) => {
                const isToday = d === todayStr;
                const isShip = d === SHIP_DATE;
                const dayOfMonth = new Date(d + 'T00:00:00').getDate();
                const showDateLabel = dayOfMonth === 1 || (i === 0) || isToday || isShip;
                const showDayNum = dayOfMonth % 2 === 1 || isToday || isShip;
                return (
                  <div key={d} style={{
                    width: DAY_W,
                    flexShrink: 0,
                    display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end',
                    paddingBottom: 4,
                    fontSize: 9,
                    fontWeight: isToday || isShip ? 700 : 400,
                    color: isToday ? '#B84848' : isShip ? '#5F4B82' : isWeekend(d) ? '#C4A896' : '#8A7D72',
                    background: isWeekend(d) ? 'rgba(0,0,0,.015)' : 'transparent',
                    borderRight: '1px solid rgba(0,0,0,.03)',
                    height: HEADER_H,
                  }}>
                    {showDateLabel && (
                      <span style={{ fontSize: 10, fontWeight: 600, marginBottom: 2 }}>
                        {dayOfMonth === 1 ? `${new Date(d).getMonth() + 1}월` : fD(d)}
                      </span>
                    )}
                    {showDayNum && (
                      <span style={{ fontSize: 9 }}>{dayOfMonth}</span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Lanes container */}
            <div style={{ position: 'relative' }}>
              {/* Today vertical line */}
              {dates.indexOf(todayStr) >= 0 && (
                <div style={{
                  position: 'absolute',
                  left: LANE_LABEL_W + dateToX(todayStr) + DAY_W / 2,
                  top: 0, bottom: 0,
                  width: 0,
                  borderLeft: '1.5px dashed #B84848',
                  zIndex: 5, pointerEvents: 'none',
                }} />
              )}
              {/* Ship date line */}
              {dates.indexOf(SHIP_DATE) >= 0 && (
                <div style={{
                  position: 'absolute',
                  left: LANE_LABEL_W + dateToX(SHIP_DATE) + DAY_W / 2,
                  top: 0, bottom: 0,
                  width: 0,
                  borderLeft: '1.5px dashed #5F4B82',
                  zIndex: 5, pointerEvents: 'none',
                }} />
              )}

              {/* Lane rows */}
              {lanes.map((lane, idx) => {
                const isExpanded = expandedLane === lane.name;
                const startX = dateToX(lane.start);
                const endX = dateToX(lane.end) + DAY_W;
                const barColor = lane.hasCritical ? '#B84848' : '#A896C4';
                const barBg = lane.hasCritical ? '#FDE8E8' : '#EFEBFA';
                const days = (new Date(lane.end).getTime() - new Date(lane.start).getTime()) / 864e5 + 1;
                return (
                  <div key={lane.name}>
                    <div
                      onClick={() => setExpandedLane(isExpanded ? null : lane.name)}
                      style={{
                        position: 'relative',
                        height: LANE_H,
                        background: idx % 2 === 1 ? '#FAFAF8' : '#FFF',
                        borderBottom: '1px solid #F2F4F6',
                        cursor: 'pointer',
                      }}
                    >
                      {/* Lane label */}
                      <div style={{
                        position: 'absolute', top: 0, left: 0,
                        width: LANE_LABEL_W, height: LANE_H,
                        display: 'flex', alignItems: 'center',
                        padding: '0 14px',
                        background: idx % 2 === 1 ? '#FAFAF8' : '#FFF',
                        borderRight: '1px solid #E5E8EB',
                        zIndex: 4,
                      }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <div style={{
                            fontSize: 12, fontWeight: 600,
                            color: lane.hasCritical ? '#B84848' : '#1A1613',
                            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          }}>
                            {lane.name}
                            {lane.hasCritical && <span style={{ marginLeft: 4 }}>⚠</span>}
                          </div>
                          <div style={{ fontSize: 9, color: '#8B95A1', fontWeight: 500 }}>
                            {lane.done}/{lane.total} · {Math.round(days)}일
                          </div>
                        </div>
                      </div>

                      {/* Bar */}
                      <div style={{
                        position: 'absolute',
                        left: LANE_LABEL_W + startX,
                        top: (LANE_H - 22) / 2,
                        width: Math.max(8, endX - startX),
                        height: 22,
                        background: barBg,
                        border: `1.5px solid ${barColor}`,
                        borderRadius: 4,
                        display: 'flex', alignItems: 'center',
                        padding: '0 6px',
                        overflow: 'hidden',
                      }}>
                        <span style={{
                          fontSize: 10, fontWeight: 600, color: barColor,
                          whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                        }}>
                          {fD(lane.start)} → {fD(lane.end)}
                        </span>
                      </div>

                      {/* Expand chevron */}
                      <div style={{
                        position: 'absolute',
                        right: 14, top: (LANE_H - 14) / 2,
                        fontSize: 10, color: '#8B95A1',
                        transform: isExpanded ? 'rotate(90deg)' : 'rotate(0)',
                        transition: 'transform .2s',
                      }}>▸</div>
                    </div>

                    {/* Expanded task bars */}
                    {isExpanded && (
                      <div style={{
                        position: 'relative',
                        background: '#FAFAF8',
                        borderBottom: '1px solid #E5E8EB',
                      }}>
                        {(hideDone ? lane.tasks.filter(x => x.task.status !== 'done') : lane.tasks)
                          .sort((a, b) => a.start < b.start ? -1 : 1)
                          .map((item, i) => {
                          const t = item.task;
                          const sc = statusColor(t.status);
                          const isCrit = criticalSet.has(t.id);
                          const tStartX = dateToX(item.start);
                          const tEndX = dateToX(item.end) + DAY_W;
                          return (
                            <div key={t.id} style={{
                              position: 'relative',
                              height: 30,
                              borderBottom: '1px dashed #F2F4F6',
                            }}>
                              {/* Task label */}
                              <div style={{
                                position: 'absolute', top: 0, left: 0,
                                width: LANE_LABEL_W, height: 30,
                                display: 'flex', alignItems: 'center',
                                padding: '0 14px 0 24px',
                                fontSize: 10,
                                color: isCrit ? '#B84848' : '#4E5968',
                                fontWeight: isCrit ? 600 : 500,
                                overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              }}>
                                {t.title}
                              </div>
                              <div style={{
                                position: 'absolute',
                                left: LANE_LABEL_W + tStartX,
                                top: 6,
                                width: Math.max(6, tEndX - tStartX),
                                height: 18,
                                background: isCrit ? '#FDE8E8' : sc.bg,
                                border: `1.2px solid ${isCrit ? '#B84848' : sc.bd}`,
                                borderRadius: 3,
                                display: 'flex', alignItems: 'center',
                                padding: '0 5px',
                                overflow: 'hidden',
                              }}>
                                <span style={{
                                  fontSize: 9, fontWeight: 500,
                                  color: isCrit ? '#B84848' : sc.tx,
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                                }}>
                                  {fD(item.end)}
                                </span>
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                );
              })}

              {/* Ship milestone diamond */}
              {dates.indexOf(SHIP_DATE) >= 0 && (
                <div style={{
                  position: 'absolute',
                  left: LANE_LABEL_W + dateToX(SHIP_DATE) + DAY_W / 2 - 7,
                  top: -28,
                  width: 14, height: 14,
                  transform: 'rotate(45deg)',
                  background: '#E8A04C',
                  border: '1.5px solid #B87B2A',
                  zIndex: 6,
                  pointerEvents: 'none',
                }} title={`출시 ${fD(SHIP_DATE)}`} />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Footer note */}
      <div style={{
        marginTop: 12, padding: '10px 14px',
        background: '#FAFAF8', border: '1px dashed #E5E8EB', borderRadius: 8,
        fontSize: 11, color: '#8B95A1', lineHeight: 1.6,
      }}>
        시작일은 자동 계산: <code style={{ background: '#F2F4F6', padding: '1px 4px', borderRadius: 3 }}>선행 task의 마감 + 1일</code>.
        선행이 없으면 <code style={{ background: '#F2F4F6', padding: '1px 4px', borderRadius: 3 }}>마감 - 2일</code>.
        정확한 일정이 필요하면 의존 관계를 채워주세요.
      </div>
    </div>
  );
}

function LegendBar({ color, label }: { color: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#8A7D72' }}>
      <span style={{
        width: 18, height: 8, borderRadius: 2,
        background: color === '#B84848' ? '#FDE8E8' : color === '#A896C4' ? '#EFEBFA' : color === '#A8C496' ? '#EBF3E6' : '#FAF6EF',
        border: `1.2px solid ${color}`,
      }} />
      {label}
    </span>
  );
}
