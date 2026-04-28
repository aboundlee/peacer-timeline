'use client';

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, dbToApp } from '@/lib/supabase';
import type { AppTask } from '@/lib/criticalPath';
import { fD, dU } from '@/lib/constants';

const SHIP_DATE = '2026-05-19';
const STAGE_ORDER = ['컨택', '테스트', '확정', '발주', '본생산', '출시'];

const statusInfo: Record<string, { label: string; bg: string; tx: string; bd: string; dot: string }> = {
  doing: { label: '진행중', bg: '#EFEBFA', tx: '#5F4B82', bd: '#A896C4', dot: '#5F4B82' },
  waiting: { label: '대기', bg: '#F5EEE6', tx: '#8B5A3C', bd: '#C4A896', dot: '#8B5A3C' },
  done: { label: '완료', bg: '#EBF3E6', tx: '#3E5A2E', bd: '#A8C496', dot: '#A8C496' },
  todo: { label: '시작 전', bg: '#FAF6EF', tx: '#8A7D72', bd: '#DDD3C2', dot: '#DDD3C2' },
};

function ymd(d: Date) { return d.toISOString().slice(0, 10); }

function projectHealth(tasks: AppTask[]): {
  status: 'on-track' | 'at-risk' | 'overdue' | 'done' | 'idle';
  label: string;
  color: string;
} {
  const today = ymd(new Date());
  const total = tasks.length;
  const done = tasks.filter(t => t.status === 'done').length;
  const overdue = tasks.filter(t => t.status !== 'done' && t.deadline && t.deadline < today);
  const doing = tasks.filter(t => t.status === 'doing' || t.status === 'waiting');

  if (total === 0) return { status: 'idle', label: '미정', color: '#8B95A1' };
  if (done === total) return { status: 'done', label: '완료', color: '#3E5A2E' };
  if (overdue.length > 0) return { status: 'overdue', label: `${overdue.length}건 지연`, color: '#B84848' };
  if (doing.length === 0) return { status: 'idle', label: '대기 중', color: '#8B95A1' };

  // Check for upcoming risk (deadline within 3 days)
  const soon = tasks.filter(t => t.status !== 'done' && t.deadline && dU(t.deadline) >= 0 && dU(t.deadline) <= 3);
  if (soon.length > 0) return { status: 'at-risk', label: '임박', color: '#E8A04C' };
  return { status: 'on-track', label: '정상', color: '#3E5A2E' };
}

// Sort tasks within a project: status priority (overdue/doing first), then deadline asc
function sortTasks(tasks: AppTask[]): AppTask[] {
  const today = ymd(new Date());
  return [...tasks].sort((a, b) => {
    // Done at the bottom
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    // Overdue first
    const aOd = a.deadline && a.deadline < today && a.status !== 'done' ? 1 : 0;
    const bOd = b.deadline && b.deadline < today && b.status !== 'done' ? 1 : 0;
    if (aOd !== bOd) return bOd - aOd;
    // Then by deadline asc (no deadline = at the end)
    const da = a.deadline || '9999-12-31';
    const db = b.deadline || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    // Then by stage order
    const sa = a.stage ? STAGE_ORDER.indexOf(a.stage) : 99;
    const sb = b.stage ? STAGE_ORDER.indexOf(b.stage) : 99;
    return sa - sb;
  });
}

export default function ProjectsPage() {
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [hideDone, setHideDone] = useState(true);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  const fetchTasks = useCallback(async () => {
    const { data, error } = await supabase
      .from('tasks').select('*').order('created_at', { ascending: true });
    if (error) { console.error(error); return; }
    if (data) {
      setTasks(data.map(dbToApp));
      setLoaded(true);
    }
  }, []);

  useEffect(() => { fetchTasks(); }, [fetchTasks]);

  useEffect(() => {
    const ch = supabase.channel('projects-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, () => fetchTasks())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchTasks]);

  // Group by pipeline
  const projects = useMemo(() => {
    const groups: Record<string, AppTask[]> = {};
    const unassigned: AppTask[] = [];
    tasks.forEach(t => {
      if (t.pipeline) {
        if (!groups[t.pipeline]) groups[t.pipeline] = [];
        groups[t.pipeline].push(t);
      } else {
        unassigned.push(t);
      }
    });
    const list = Object.entries(groups).map(([name, group]) => {
      const health = projectHealth(group);
      const total = group.length;
      const done = group.filter(t => t.status === 'done').length;
      const sorted = sortTasks(group);
      const visible = hideDone ? sorted.filter(t => t.status !== 'done') : sorted;
      // Next action = first non-done sorted task
      const nextAction = sorted.find(t => t.status !== 'done');
      // Earliest active deadline
      const activeDeadlines = group.filter(t => t.status !== 'done' && t.deadline).map(t => t.deadline!);
      const nearestDeadline = activeDeadlines.length > 0 ? activeDeadlines.reduce((a, b) => a < b ? a : b) : null;
      return {
        name, tasks: sorted, visible, total, done, health, nextAction, nearestDeadline,
        pct: total > 0 ? Math.round((done / total) * 100) : 0,
      };
    });
    // Sort: overdue/at-risk first, then by nearest deadline, then by name
    list.sort((a, b) => {
      const order = { overdue: 0, 'at-risk': 1, 'on-track': 2, idle: 3, done: 4 };
      const oa = order[a.health.status as keyof typeof order];
      const ob = order[b.health.status as keyof typeof order];
      if (oa !== ob) return oa - ob;
      if (a.nearestDeadline && b.nearestDeadline) return a.nearestDeadline < b.nearestDeadline ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    });
    return { list, unassigned };
  }, [tasks, hideDone]);

  const toggleExpand = (name: string) => {
    setExpandedProjects(prev => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      return n;
    });
  };

  if (!loaded) {
    return <div style={{ padding: '100px 20px', textAlign: 'center', color: '#8B95A1', fontSize: 13 }}>불러오는 중…</div>;
  }

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px', fontFamily: 'Pretendard, "Noto Sans KR", sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 6 }}>
          PROJECTS
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.02em' }}>
          프로젝트별 일정
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8B95A1', lineHeight: 1.5 }}>
          각 프로젝트가 어디까지 왔는지, 다음 액션이 뭔지 한눈에. 출하 <strong style={{ color: '#5F4B82' }}>{fD(SHIP_DATE)} (D-{dU(SHIP_DATE)})</strong>.
        </p>
      </div>

      {/* Controls */}
      <div style={{
        display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', justifyContent: 'space-between',
      }}>
        <div style={{ fontSize: 12, color: '#8B95A1' }}>
          <strong style={{ color: '#1A1613', fontSize: 14, fontWeight: 700 }}>{projects.list.length}</strong> 프로젝트 ·
          <strong style={{ color: '#B84848', fontSize: 14, fontWeight: 700, marginLeft: 6 }}>
            {projects.list.filter(p => p.health.status === 'overdue').length}
          </strong> 지연 ·
          <strong style={{ color: '#E8A04C', fontSize: 14, fontWeight: 700, marginLeft: 6 }}>
            {projects.list.filter(p => p.health.status === 'at-risk').length}
          </strong> 임박
        </div>
        <button
          onClick={() => setHideDone(!hideDone)}
          style={{
            padding: '4px 12px', borderRadius: 100, fontSize: 11, fontWeight: 500,
            background: hideDone ? '#EFEBFA' : '#F2F4F6',
            color: hideDone ? '#5F4B82' : '#8B95A1',
            border: `1px solid ${hideDone ? '#A896C4' : '#E5E8EB'}`,
            cursor: 'pointer',
          }}
        >
          {hideDone ? '완료 보기' : '완료 숨기기'}
        </button>
      </div>

      {/* Project cards */}
      {projects.list.length === 0 ? (
        <div style={{
          padding: '60px 20px', textAlign: 'center', background: '#FFF',
          border: '1px solid #E5E8EB', borderRadius: 12, color: '#8B95A1',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#4E5968' }}>아직 프로젝트가 없어요</div>
          <p style={{ fontSize: 12, margin: 0 }}>태스크에 워크스트림을 지정하면 여기에 나타나요.</p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {projects.list.map(proj => (
            <ProjectCard
              key={proj.name}
              project={proj}
              expanded={expandedProjects.has(proj.name)}
              onToggle={() => toggleExpand(proj.name)}
            />
          ))}
        </div>
      )}

      {projects.unassigned.length > 0 && (
        <div style={{ marginTop: 16, padding: '10px 14px', background: '#FAFAF8', border: '1px dashed #E5E8EB', borderRadius: 8, fontSize: 11, color: '#8B95A1' }}>
          ⚠ 워크스트림 미지정 태스크 {projects.unassigned.filter(t => t.status !== 'done').length}개 — 태스크 편집에서 워크스트림을 지정해주세요.
        </div>
      )}
    </div>
  );
}

type ProjectData = {
  name: string;
  tasks: AppTask[];
  visible: AppTask[];
  total: number;
  done: number;
  health: ReturnType<typeof projectHealth>;
  nextAction: AppTask | undefined;
  nearestDeadline: string | null;
  pct: number;
};

function ProjectCard({ project, expanded, onToggle }: {
  project: ProjectData;
  expanded: boolean;
  onToggle: () => void;
}) {
  const { name, visible, done, total, health, nextAction, nearestDeadline, pct } = project;
  const showAll = expanded;
  const previewCount = 4;
  const tasksToShow = showAll ? visible : visible.slice(0, previewCount);
  const moreCount = Math.max(0, visible.length - tasksToShow.length);

  return (
    <div style={{
      background: '#FFF',
      border: `1px solid ${health.status === 'overdue' ? '#F0C4C4' : '#E5E8EB'}`,
      borderLeft: `3px solid ${health.color}`,
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      {/* Header */}
      <div
        onClick={onToggle}
        style={{
          padding: '14px 16px',
          display: 'flex', alignItems: 'center', gap: 12,
          cursor: 'pointer',
          background: '#FFF',
          borderBottom: visible.length > 0 ? '1px solid #F2F4F6' : 'none',
        }}
      >
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 100, fontWeight: 600,
              background: health.color === '#3E5A2E' ? '#EBF3E6' : health.color === '#B84848' ? '#FDE8E8' : health.color === '#E8A04C' ? '#FFF4E0' : '#F2F4F6',
              color: health.color, border: `1px solid ${health.color}33`,
            }}>
              {health.label}
            </span>
            <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.01em' }}>
              {name}
            </h3>
          </div>
          {nextAction ? (
            <div style={{ fontSize: 12, color: '#4E5968', display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <span style={{ color: '#8B95A1', fontWeight: 500 }}>다음:</span>
              <span style={{ fontWeight: 500 }}>{nextAction.title}</span>
              {nextAction.deadline && (
                <span style={{
                  fontSize: 11, fontWeight: 600,
                  color: dU(nextAction.deadline) < 0 ? '#B84848' : dU(nextAction.deadline) <= 3 ? '#E8A04C' : '#8B95A1',
                }}>
                  {fD(nextAction.deadline)} {dU(nextAction.deadline) < 0 ? `(D+${Math.abs(dU(nextAction.deadline))})` : dU(nextAction.deadline) === 0 ? '(오늘)' : `(D-${dU(nextAction.deadline)})`}
                </span>
              )}
              {nextAction.owner && (
                <span style={{ fontSize: 10, color: '#8B95A1' }}>· {nextAction.owner}</span>
              )}
            </div>
          ) : (
            <div style={{ fontSize: 12, color: '#8B95A1' }}>모든 작업 완료 🎉</div>
          )}
        </div>

        {/* Right side: progress + count */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexShrink: 0 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500 }}>
              {done}/{total}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 2 }}>
              <div style={{ width: 60, height: 4, background: '#F2F4F6', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{
                  width: `${pct}%`, height: '100%',
                  background: pct === 100 ? '#A8C496' : '#A896C4',
                }} />
              </div>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#4E5968', minWidth: 28 }}>
                {pct}%
              </span>
            </div>
          </div>
          <span style={{
            fontSize: 12, color: '#8B95A1',
            transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
            transition: 'transform .2s',
          }}>▸</span>
        </div>
      </div>

      {/* Timeline body */}
      {visible.length > 0 && (
        <div style={{ padding: '8px 0' }}>
          {tasksToShow.map((task, i) => {
            const isLast = i === tasksToShow.length - 1 && moreCount === 0;
            return <TaskRow key={task.id} task={task} isLast={isLast} />;
          })}
          {moreCount > 0 && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              style={{
                marginLeft: 16, marginTop: 4,
                background: 'none', border: 'none',
                fontSize: 11, color: '#5F4B82', fontWeight: 500, cursor: 'pointer',
                padding: '4px 0',
              }}
            >
              + {moreCount}개 더 보기
            </button>
          )}
          {showAll && visible.length > previewCount && (
            <button
              onClick={(e) => { e.stopPropagation(); onToggle(); }}
              style={{
                marginLeft: 16, marginTop: 4,
                background: 'none', border: 'none',
                fontSize: 11, color: '#8B95A1', fontWeight: 500, cursor: 'pointer',
                padding: '4px 0',
              }}
            >
              접기
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function TaskRow({ task, isLast }: { task: AppTask; isLast: boolean }) {
  const today = ymd(new Date());
  const overdue = task.deadline && task.deadline < today && task.status !== 'done';
  const si = statusInfo[task.status] || statusInfo.todo;
  const dColor = overdue ? '#B84848' : task.deadline && dU(task.deadline) <= 3 ? '#E8A04C' : '#8B95A1';

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      padding: '8px 16px',
      borderBottom: isLast ? 'none' : '1px dashed #F2F4F6',
      opacity: task.status === 'done' ? 0.55 : 1,
      background: 'transparent',
    }}>
      {/* Date column */}
      <div style={{
        flexShrink: 0, width: 56,
        textAlign: 'left', fontSize: 11, fontWeight: 600,
        color: dColor,
        fontVariantNumeric: 'tabular-nums',
      }}>
        {task.deadline ? fD(task.deadline) : '─'}
      </div>

      {/* Stage chip */}
      <div style={{
        flexShrink: 0, width: 48,
        fontSize: 10, color: '#8B95A1', fontWeight: 500,
      }}>
        {task.stage || ''}
      </div>

      {/* Title */}
      <div style={{
        flex: 1, minWidth: 0,
        fontSize: 12,
        color: task.status === 'done' ? '#8B95A1' : '#1A1613',
        textDecoration: task.status === 'done' ? 'line-through' : 'none',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
      }}>
        {task.title}
      </div>

      {/* Owner */}
      {task.owner && (
        <span style={{ fontSize: 10, color: '#8B95A1', flexShrink: 0 }}>
          {task.owner}
        </span>
      )}

      {/* Status pill */}
      <span style={{
        flexShrink: 0,
        fontSize: 9, fontWeight: 600, padding: '1px 7px', borderRadius: 100,
        background: si.bg, color: si.tx,
      }}>
        {si.label}
      </span>
    </div>
  );
}
