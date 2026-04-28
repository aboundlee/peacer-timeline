'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, dbToApp } from '@/lib/supabase';
import type { AppTask } from '@/lib/criticalPath';
import { fD, dU } from '@/lib/constants';

const SHIP_DATE = '2026-05-19';

// Canonical stage order
const STAGES = ['컨택', '테스트', '확정', '발주', '본생산', '출시'];

const STATUS_PRIORITY: Record<string, number> = { doing: 4, waiting: 3, todo: 2, done: 1 };

type CellState = {
  tasks: AppTask[];
  done: number;
  total: number;
  hasOverdue: boolean;
  hasDoing: boolean;
};

function cellSignal(cell: CellState | null): {
  symbol: string; bg: string; bd: string; tx: string; label: string;
} {
  if (!cell || cell.total === 0) {
    return { symbol: '─', bg: 'transparent', bd: '#F2F4F6', tx: '#D1D6DB', label: '없음' };
  }
  if (cell.done === cell.total) {
    return { symbol: '✓', bg: '#EBF3E6', bd: '#A8C496', tx: '#3E5A2E', label: '완료' };
  }
  if (cell.hasOverdue) {
    return { symbol: '!', bg: '#FDE8E8', bd: '#F04452', tx: '#B84848', label: '지연' };
  }
  if (cell.hasDoing) {
    return { symbol: '●', bg: '#EFEBFA', bd: '#A896C4', tx: '#5F4B82', label: '진행중' };
  }
  if (cell.done > 0) {
    return { symbol: '◐', bg: '#FAF6EF', bd: '#DDD3C2', tx: '#8A7D72', label: '일부 완료' };
  }
  return { symbol: '◯', bg: '#FAF6EF', bd: '#E5E8EB', tx: '#8B95A1', label: '대기' };
}

export default function PipelinesPage() {
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [selectedCell, setSelectedCell] = useState<{ pipeline: string; stage: string } | null>(null);
  const [showUnassigned, setShowUnassigned] = useState(false);

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
      .channel('pipelines-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => fetchTasks())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchTasks]);

  // Determine pipelines + matrix cells
  const { pipelines, matrix, unassigned } = useMemo(() => {
    const pipelineSet = new Set<string>();
    const matrix: Record<string, Record<string, CellState>> = {};
    const unassigned: AppTask[] = [];
    const todayStr = new Date().toISOString().slice(0, 10);

    tasks.forEach(t => {
      if (!t.pipeline) {
        unassigned.push(t);
        return;
      }
      pipelineSet.add(t.pipeline);
      const stage = t.stage || '미분류';
      if (!matrix[t.pipeline]) matrix[t.pipeline] = {};
      if (!matrix[t.pipeline][stage]) {
        matrix[t.pipeline][stage] = { tasks: [], done: 0, total: 0, hasOverdue: false, hasDoing: false };
      }
      const cell = matrix[t.pipeline][stage];
      cell.tasks.push(t);
      cell.total++;
      if (t.status === 'done') cell.done++;
      if (t.status === 'doing' || t.status === 'waiting') cell.hasDoing = true;
      if (t.deadline && t.deadline < todayStr && t.status !== 'done') cell.hasOverdue = true;
    });

    // Sort pipelines: by progress (least done first = needs attention)
    const pipelines = [...pipelineSet].sort((a, b) => {
      const sa = STAGES.reduce((s, st) => s + (matrix[a]?.[st]?.done || 0), 0);
      const ta = STAGES.reduce((s, st) => s + (matrix[a]?.[st]?.total || 0), 0);
      const sb = STAGES.reduce((s, st) => s + (matrix[b]?.[st]?.done || 0), 0);
      const tb = STAGES.reduce((s, st) => s + (matrix[b]?.[st]?.total || 0), 0);
      const pa = ta > 0 ? sa / ta : 0;
      const pb = tb > 0 ? sb / tb : 0;
      return pa - pb; // less progress first
    });

    return { pipelines, matrix, unassigned };
  }, [tasks]);

  // Per-stage bottleneck score (how many pipelines stuck on this stage)
  const stageBottleneck = useMemo(() => {
    const result: Record<string, number> = {};
    STAGES.forEach(stage => {
      let stuck = 0;
      pipelines.forEach(p => {
        const cell = matrix[p]?.[stage];
        if (cell && cell.total > 0 && cell.done < cell.total && !cell.hasDoing) {
          stuck++;
        }
      });
      result[stage] = stuck;
    });
    return result;
  }, [pipelines, matrix]);

  // Per-pipeline progress
  const pipelineProgress = useMemo(() => {
    const result: Record<string, { done: number; total: number; pct: number }> = {};
    pipelines.forEach(p => {
      let done = 0, total = 0;
      STAGES.forEach(stage => {
        const cell = matrix[p]?.[stage];
        if (cell) { done += cell.done; total += cell.total; }
      });
      result[p] = { done, total, pct: total > 0 ? Math.round((done / total) * 100) : 0 };
    });
    return result;
  }, [pipelines, matrix]);

  const selectedTasks = selectedCell
    ? matrix[selectedCell.pipeline]?.[selectedCell.stage]?.tasks || []
    : [];

  if (!loaded) {
    return <div style={{ padding: '100px 20px', textAlign: 'center', color: '#8B95A1', fontSize: 13 }}>불러오는 중…</div>;
  }

  return (
    <div style={{ maxWidth: 1200, margin: '0 auto', padding: '24px 20px 80px', fontFamily: 'Pretendard, "Noto Sans KR", sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 6 }}>
          PIPELINES
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.02em' }}>
          파이프라인
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8B95A1', lineHeight: 1.5 }}>
          각 워크스트림이 어느 단계에 있는지 한눈에. 출하 <strong style={{ color: '#4E5968' }}>{fD(SHIP_DATE)} (D-{dU(SHIP_DATE)})</strong>.
        </p>
      </div>

      {/* Legend */}
      <div style={{
        display: 'flex', gap: 14, alignItems: 'center', flexWrap: 'wrap',
        padding: '10px 14px', background: '#FFF', border: '1px solid #E5E8EB', borderRadius: 10,
        marginBottom: 16, fontSize: 11,
      }}>
        <LegendItem symbol="✓" bg="#EBF3E6" bd="#A8C496" tx="#3E5A2E" label="완료" />
        <LegendItem symbol="●" bg="#EFEBFA" bd="#A896C4" tx="#5F4B82" label="진행중" />
        <LegendItem symbol="◐" bg="#FAF6EF" bd="#DDD3C2" tx="#8A7D72" label="일부 완료" />
        <LegendItem symbol="◯" bg="#FAF6EF" bd="#E5E8EB" tx="#8B95A1" label="대기" />
        <LegendItem symbol="!" bg="#FDE8E8" bd="#F04452" tx="#B84848" label="지연" />
        <LegendItem symbol="─" bg="transparent" bd="#F2F4F6" tx="#D1D6DB" label="해당 없음" />
      </div>

      {/* Matrix */}
      {pipelines.length === 0 ? (
        <div style={{
          padding: '60px 20px', textAlign: 'center', background: '#FFF',
          border: '1px solid #E5E8EB', borderRadius: 12, color: '#8B95A1',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#4E5968' }}>아직 파이프라인이 없어요</div>
          <p style={{ fontSize: 12, margin: 0 }}>태스크 편집에서 워크스트림을 지정하면 여기에 나타나요.</p>
        </div>
      ) : (
        <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
          <table style={{
            width: '100%', minWidth: 720,
            borderCollapse: 'separate', borderSpacing: 0,
            background: '#FFF', borderRadius: 12, overflow: 'hidden',
            border: '1px solid #E5E8EB',
          }}>
            <thead>
              <tr>
                <th style={{ ...thStyle, textAlign: 'left', minWidth: 140, paddingLeft: 16 }}>워크스트림</th>
                <th style={{ ...thStyle, minWidth: 80, textAlign: 'left' }}>진행</th>
                {STAGES.map(stage => {
                  const stuck = stageBottleneck[stage];
                  const isBottleneck = stuck >= 2;
                  return (
                    <th key={stage} style={{
                      ...thStyle, minWidth: 80,
                      color: isBottleneck ? '#B84848' : '#4E5968',
                      background: isBottleneck ? '#FDE8E8' : '#FAFAF8',
                    }}>
                      {stage}
                      {isBottleneck && (
                        <div style={{ fontSize: 9, fontWeight: 500, color: '#B84848', marginTop: 2 }}>
                          {stuck}개 막힘
                        </div>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {pipelines.map((p, idx) => {
                const prog = pipelineProgress[p];
                return (
                  <tr key={p} style={{ background: idx % 2 === 1 ? '#FAFAF8' : '#FFF' }}>
                    <td style={{ ...tdStyle, paddingLeft: 16, fontWeight: 600, color: '#1A1613' }}>
                      {p}
                    </td>
                    <td style={{ ...tdStyle, fontSize: 11, color: '#8B95A1', whiteSpace: 'nowrap' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <div style={{
                          width: 50, height: 4, background: '#F2F4F6', borderRadius: 2, overflow: 'hidden',
                        }}>
                          <div style={{
                            width: `${prog.pct}%`, height: '100%',
                            background: prog.pct === 100 ? '#A8C496' : '#A896C4',
                            transition: 'width .3s',
                          }} />
                        </div>
                        <span style={{ fontWeight: 600, color: '#4E5968', fontSize: 11 }}>
                          {prog.pct}%
                        </span>
                      </div>
                    </td>
                    {STAGES.map(stage => {
                      const cell = matrix[p]?.[stage] || null;
                      const sig = cellSignal(cell);
                      const isSelected = selectedCell?.pipeline === p && selectedCell?.stage === stage;
                      const clickable = cell && cell.total > 0;
                      return (
                        <td
                          key={stage}
                          style={{ ...tdStyle, padding: 4, textAlign: 'center', cursor: clickable ? 'pointer' : 'default' }}
                          onClick={() => clickable && setSelectedCell(isSelected ? null : { pipeline: p, stage })}
                        >
                          <div
                            title={`${sig.label}${cell ? ` (${cell.done}/${cell.total})` : ''}`}
                            style={{
                              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                              width: 38, height: 28, borderRadius: 6,
                              background: sig.bg,
                              border: `1.5px solid ${isSelected ? '#5F4B82' : sig.bd}`,
                              color: sig.tx,
                              fontSize: 13, fontWeight: 700,
                              boxShadow: isSelected ? '0 0 0 3px rgba(95,75,130,.15)' : 'none',
                              transition: 'box-shadow .15s, border-color .15s',
                            }}
                          >
                            {sig.symbol}
                          </div>
                          {cell && cell.total > 0 && (
                            <div style={{ fontSize: 9, color: '#8B95A1', marginTop: 2 }}>
                              {cell.done}/{cell.total}
                            </div>
                          )}
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Selected cell tasks */}
      {selectedCell && (
        <div style={{
          marginTop: 16, padding: '14px 16px',
          background: '#FFF', border: '1px solid #E5E8EB', borderRadius: 12,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
            <div>
              <span style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500 }}>
                {selectedCell.pipeline} · {selectedCell.stage}
              </span>
              <h4 style={{ margin: '2px 0 0', fontSize: 14, fontWeight: 600, color: '#1A1613' }}>
                {selectedTasks.length}개 태스크
              </h4>
            </div>
            <button
              onClick={() => setSelectedCell(null)}
              style={{ background: 'none', border: 'none', fontSize: 18, color: '#8B95A1', cursor: 'pointer' }}
            >×</button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {selectedTasks
              .sort((a, b) => (STATUS_PRIORITY[b.status] || 0) - (STATUS_PRIORITY[a.status] || 0))
              .map(t => <TaskRow key={t.id} task={t} />)}
          </div>
        </div>
      )}

      {/* Unassigned tasks */}
      {unassigned.length > 0 && (
        <div style={{ marginTop: 20 }}>
          <button
            onClick={() => setShowUnassigned(!showUnassigned)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              background: 'none', border: 'none', cursor: 'pointer',
              fontSize: 12, color: '#8B95A1', padding: '8px 4px',
            }}
          >
            <span style={{ transform: showUnassigned ? 'rotate(90deg)' : 'rotate(0)', transition: 'transform .2s' }}>▸</span>
            워크스트림 미지정 {unassigned.filter(t => t.status !== 'done').length}개
          </button>
          {showUnassigned && (
            <div style={{
              marginTop: 4, padding: 12,
              background: '#FAFAF8', border: '1px dashed #E5E8EB', borderRadius: 10,
              display: 'flex', flexDirection: 'column', gap: 6,
            }}>
              {unassigned.filter(t => t.status !== 'done').map(t => <TaskRow key={t.id} task={t} />)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task }: { task: AppTask }) {
  const today = new Date().toISOString().slice(0, 10);
  const overdue = task.deadline && task.deadline < today && task.status !== 'done';
  const statusInfo: Record<string, { label: string; bg: string; tx: string }> = {
    doing: { label: '진행중', bg: '#EFEBFA', tx: '#5F4B82' },
    waiting: { label: '대기', bg: '#F5EEE6', tx: '#8B5A3C' },
    done: { label: '완료', bg: '#EBF3E6', tx: '#3E5A2E' },
    todo: { label: '시작 전', bg: '#FAF6EF', tx: '#8A7D72' },
  };
  const si = statusInfo[task.status] || statusInfo.todo;

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 10px',
      background: task.status === 'done' ? '#FAFAF8' : '#FFF',
      border: '1px solid #F2F4F6',
      borderRadius: 8,
      opacity: task.status === 'done' ? 0.7 : 1,
    }}>
      <span style={{
        fontSize: 9, fontWeight: 600, padding: '1px 7px', borderRadius: 100,
        background: si.bg, color: si.tx, flexShrink: 0,
      }}>
        {si.label}
      </span>
      <span style={{
        fontSize: 12, color: task.status === 'done' ? '#8B95A1' : '#1A1613',
        textDecoration: task.status === 'done' ? 'line-through' : 'none',
        flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {task.title}
      </span>
      {task.owner && (
        <span style={{ fontSize: 10, color: '#8B95A1', fontWeight: 500 }}>{task.owner}</span>
      )}
      {task.deadline && (
        <span style={{
          fontSize: 11, fontWeight: 600,
          color: overdue ? '#B84848' : '#8B95A1',
          flexShrink: 0,
        }}>
          {fD(task.deadline)}
        </span>
      )}
    </div>
  );
}

function LegendItem({ symbol, bg, bd, tx, label }: { symbol: string; bg: string; bd: string; tx: string; label: string }) {
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: '#8B95A1' }}>
      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 22, height: 18, borderRadius: 4,
        background: bg, border: `1px solid ${bd}`, color: tx,
        fontSize: 11, fontWeight: 700,
      }}>
        {symbol}
      </span>
      {label}
    </span>
  );
}

const thStyle: React.CSSProperties = {
  fontSize: 11, fontWeight: 600, color: '#4E5968',
  padding: '12px 8px',
  textAlign: 'center',
  borderBottom: '1px solid #E5E8EB',
  background: '#FAFAF8',
  position: 'sticky', top: 0,
};

const tdStyle: React.CSSProperties = {
  padding: '10px 8px',
  fontSize: 12,
  borderBottom: '1px solid #F2F4F6',
};
