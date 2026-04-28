'use client';

import React, { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { supabase, dbToApp, appToDb } from '@/lib/supabase';
import type { AppTask } from '@/lib/criticalPath';
import { fD, dU, OWNERS, STS, SL } from '@/lib/constants';

const SHIP_DATE = '2026-05-19';
const STAGE_ORDER = ['', '컨택', '테스트', '확정', '발주', '본생산', '출시'];

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

  const soon = tasks.filter(t => t.status !== 'done' && t.deadline && dU(t.deadline) >= 0 && dU(t.deadline) <= 3);
  if (soon.length > 0) return { status: 'at-risk', label: '임박', color: '#E8A04C' };
  return { status: 'on-track', label: '정상', color: '#3E5A2E' };
}

function sortTasks(tasks: AppTask[]): AppTask[] {
  const today = ymd(new Date());
  return [...tasks].sort((a, b) => {
    if (a.status === 'done' && b.status !== 'done') return 1;
    if (a.status !== 'done' && b.status === 'done') return -1;
    const aOd = a.deadline && a.deadline < today && a.status !== 'done' ? 1 : 0;
    const bOd = b.deadline && b.deadline < today && b.status !== 'done' ? 1 : 0;
    if (aOd !== bOd) return bOd - aOd;
    const da = a.deadline || '9999-12-31';
    const db = b.deadline || '9999-12-31';
    if (da !== db) return da < db ? -1 : 1;
    const sa = a.stage ? STAGE_ORDER.indexOf(a.stage) : 99;
    const sb = b.stage ? STAGE_ORDER.indexOf(b.stage) : 99;
    return sa - sb;
  });
}

function uid(): string {
  return 't' + Date.now() + Math.random().toString(36).slice(2, 5);
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

  // Optimistic update + persist
  const updateTask = useCallback(async (id: string, patch: Partial<AppTask>) => {
    setTasks(prev => prev.map(t => t.id === id ? { ...t, ...patch } as AppTask : t));
    const dbPatch = appToDb(patch as Record<string, unknown>);
    const { error } = await supabase.from('tasks').update(dbPatch).eq('id', id);
    if (error) {
      console.error(error);
      fetchTasks(); // revert
    }
  }, [fetchTasks]);

  // Create new task with pipeline pre-filled
  const createTask = useCallback(async (pipeline: string, partial: Partial<AppTask>) => {
    const id = uid();
    const newTask: AppTask = {
      id,
      title: partial.title || '새 할 일',
      category: partial.category || '기타',
      project: partial.project || null,
      pipeline,
      stage: partial.stage || null,
      owner: partial.owner || OWNERS[0],
      deadline: partial.deadline || null,
      status: 'todo',
      priority: 'medium',
      note: '',
      dependsOn: [],
      blocksCount: 0,
    };
    setTasks(prev => [...prev, newTask]);
    const dbRow = appToDb(newTask as unknown as Record<string, unknown>);
    const { error } = await supabase.from('tasks').insert(dbRow);
    if (error) {
      console.error(error);
      fetchTasks();
    }
  }, [fetchTasks]);

  // Delete task
  const deleteTask = useCallback(async (id: string) => {
    setTasks(prev => prev.filter(t => t.id !== id));
    const { error } = await supabase.from('tasks').delete().eq('id', id);
    if (error) {
      console.error(error);
      fetchTasks();
    }
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
      const nextAction = sorted.find(t => t.status !== 'done');
      const activeDeadlines = group.filter(t => t.status !== 'done' && t.deadline).map(t => t.deadline!);
      const nearestDeadline = activeDeadlines.length > 0 ? activeDeadlines.reduce((a, b) => a < b ? a : b) : null;
      return {
        name, tasks: sorted, visible, total, done, health, nextAction, nearestDeadline,
        pct: total > 0 ? Math.round((done / total) * 100) : 0,
      };
    });
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
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 6 }}>
          PROJECTS
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.02em' }}>
          프로젝트별 일정
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8B95A1', lineHeight: 1.5 }}>
          각 프로젝트가 어디까지 왔는지, 다음 액션이 뭔지 한눈에. 출하 <strong style={{ color: '#5F4B82' }}>{fD(SHIP_DATE)} (D-{dU(SHIP_DATE)})</strong>.
          <br />
          <span style={{ fontSize: 11, color: '#A8B0BA' }}>
            팁: 날짜 · 제목 · 상태 · 담당 클릭하면 바로 편집 가능. ⌫로 행 삭제.
          </span>
        </p>
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 16, alignItems: 'center', justifyContent: 'space-between' }}>
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
              onUpdate={updateTask}
              onCreate={createTask}
              onDelete={deleteTask}
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

function ProjectCard({ project, expanded, onToggle, onUpdate, onCreate, onDelete }: {
  project: ProjectData;
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (id: string, patch: Partial<AppTask>) => void;
  onCreate: (pipeline: string, partial: Partial<AppTask>) => void;
  onDelete: (id: string) => void;
}) {
  const { name, visible, done, total, health, nextAction, pct } = project;
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newStage, setNewStage] = useState<string>('');

  const showAll = expanded;
  const previewCount = 4;
  const tasksToShow = showAll ? visible : visible.slice(0, previewCount);
  const moreCount = Math.max(0, visible.length - tasksToShow.length);

  // Default: derive category from existing tasks in this pipeline
  const defaultCategory = project.tasks[0]?.category || '기타';

  const handleAdd = () => {
    if (!newTitle.trim()) { setAdding(false); return; }
    onCreate(name, {
      title: newTitle.trim(),
      deadline: newDate || null,
      stage: newStage || null,
      category: defaultCategory,
    });
    setNewTitle('');
    setNewDate('');
    setNewStage('');
    setAdding(false);
  };

  return (
    <div style={{
      background: '#FFF',
      border: `1px solid ${health.status === 'overdue' ? '#F0C4C4' : '#E5E8EB'}`,
      borderLeft: `3px solid ${health.color}`,
      borderRadius: 12,
      overflow: 'hidden',
    }}>
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

      {visible.length > 0 && (
        <div style={{ padding: '6px 0' }}>
          {tasksToShow.map((task, i) => (
            <EditableTaskRow
              key={task.id}
              task={task}
              onUpdate={onUpdate}
              onDelete={onDelete}
              isLast={i === tasksToShow.length - 1 && moreCount === 0 && !adding}
            />
          ))}
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

      {/* Add task row */}
      {adding ? (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '8px 16px',
          borderTop: '1px solid #F2F4F6',
          background: '#FAF6EF',
        }}
        onClick={(e) => e.stopPropagation()}
        >
          <input
            type="date"
            value={newDate}
            onChange={(e) => setNewDate(e.target.value)}
            style={{
              flexShrink: 0, width: 120, fontSize: 11,
              padding: '4px 6px', border: '1px solid #DDD3C2', borderRadius: 4,
              background: '#FFF', color: '#1A1613', outline: 'none',
            }}
          />
          <select
            value={newStage}
            onChange={(e) => setNewStage(e.target.value)}
            style={{
              flexShrink: 0, width: 70, fontSize: 11,
              padding: '4px 6px', border: '1px solid #DDD3C2', borderRadius: 4,
              background: '#FFF', color: '#1A1613', outline: 'none',
            }}
          >
            <option value="">단계</option>
            {STAGE_ORDER.filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
          <input
            autoFocus
            value={newTitle}
            onChange={(e) => setNewTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleAdd();
              if (e.key === 'Escape') { setAdding(false); setNewTitle(''); }
            }}
            placeholder="할 일 제목 (Enter 저장 / ESC 취소)"
            style={{
              flex: 1, fontSize: 12,
              padding: '4px 8px', border: '1px solid #DDD3C2', borderRadius: 4,
              background: '#FFF', color: '#1A1613', outline: 'none',
            }}
          />
          <button
            onClick={handleAdd}
            style={{
              fontSize: 11, fontWeight: 600, padding: '4px 12px',
              background: '#191F28', color: '#FFF',
              border: 'none', borderRadius: 4, cursor: 'pointer',
            }}
          >저장</button>
        </div>
      ) : (
        <button
          onClick={(e) => { e.stopPropagation(); setAdding(true); }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
            width: '100%', padding: '8px 16px',
            background: 'transparent',
            borderTop: visible.length > 0 ? '1px dashed #F2F4F6' : 'none',
            border: 'none',
            color: '#8B95A1', fontSize: 11, fontWeight: 500,
            cursor: 'pointer',
          }}
        >
          + 할 일 추가
        </button>
      )}
    </div>
  );
}

function EditableTaskRow({ task, onUpdate, onDelete, isLast }: {
  task: AppTask;
  onUpdate: (id: string, patch: Partial<AppTask>) => void;
  onDelete: (id: string) => void;
  isLast: boolean;
}) {
  const [editingField, setEditingField] = useState<'title' | 'date' | null>(null);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const dateRef = useRef<HTMLInputElement>(null);

  useEffect(() => { setTitleDraft(task.title); }, [task.title]);

  const today = ymd(new Date());
  const overdue = task.deadline && task.deadline < today && task.status !== 'done';
  const si = statusInfo[task.status] || statusInfo.todo;
  const dColor = overdue ? '#B84848' : task.deadline && dU(task.deadline) <= 3 ? '#E8A04C' : '#8B95A1';

  const cycleStatus = (e: React.MouseEvent) => {
    e.stopPropagation();
    const idx = STS.indexOf(task.status as typeof STS[number]);
    const next = STS[(idx + 1) % STS.length];
    onUpdate(task.id, { status: next });
  };

  const cycleOwner = (e: React.MouseEvent) => {
    e.stopPropagation();
    const idx = OWNERS.indexOf(task.owner);
    const next = OWNERS[(idx + 1) % OWNERS.length];
    onUpdate(task.id, { owner: next });
  };

  const cycleStage = (e: React.MouseEvent) => {
    e.stopPropagation();
    const cur = task.stage || '';
    const idx = STAGE_ORDER.indexOf(cur);
    const next = STAGE_ORDER[(idx + 1) % STAGE_ORDER.length];
    onUpdate(task.id, { stage: next || null });
  };

  const saveTitle = () => {
    const t = titleDraft.trim();
    if (t && t !== task.title) onUpdate(task.id, { title: t });
    setEditingField(null);
  };

  const handleDateClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditingField('date');
    setTimeout(() => {
      dateRef.current?.focus();
      dateRef.current?.showPicker?.();
    }, 0);
  };

  const handleDelete = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirm(`"${task.title}" 삭제할까요?`)) {
      onDelete(task.id);
    }
  };

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '6px 16px',
        borderBottom: isLast ? 'none' : '1px dashed #F2F4F6',
        opacity: task.status === 'done' ? 0.55 : 1,
        transition: 'background .12s',
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = '#FAFAF8'; }}
      onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
    >
      {/* Date */}
      <div style={{ flexShrink: 0, width: 60, position: 'relative' }}>
        {editingField === 'date' ? (
          <input
            ref={dateRef}
            type="date"
            defaultValue={task.deadline || ''}
            onBlur={(e) => {
              const v = e.target.value;
              if (v !== (task.deadline || '')) {
                onUpdate(task.id, { deadline: v || null });
              }
              setEditingField(null);
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', fontSize: 11,
              padding: '2px 4px', border: '1px solid #5F4B82', borderRadius: 4,
              background: '#FFF', color: '#1A1613', outline: 'none',
            }}
          />
        ) : (
          <button
            onClick={handleDateClick}
            title="클릭해서 날짜 변경"
            style={{
              border: 'none', background: 'transparent',
              fontSize: 11, fontWeight: 600,
              color: dColor,
              fontVariantNumeric: 'tabular-nums',
              cursor: 'pointer', padding: '2px 0',
              textAlign: 'left', width: '100%',
            }}
          >
            {task.deadline ? fD(task.deadline) : '날짜+'}
          </button>
        )}
      </div>

      {/* Stage chip — click to cycle */}
      <button
        onClick={cycleStage}
        title="클릭해서 단계 순환"
        style={{
          flexShrink: 0, width: 56,
          background: 'transparent', border: 'none',
          fontSize: 10, color: '#8B95A1', fontWeight: 500,
          textAlign: 'left', cursor: 'pointer',
          padding: '2px 0',
        }}
      >
        {task.stage || <span style={{ color: '#D1D6DB' }}>단계+</span>}
      </button>

      {/* Title — click to edit */}
      <div style={{ flex: 1, minWidth: 0 }}>
        {editingField === 'title' ? (
          <input
            autoFocus
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={saveTitle}
            onKeyDown={(e) => {
              if (e.key === 'Enter') saveTitle();
              if (e.key === 'Escape') { setTitleDraft(task.title); setEditingField(null); }
            }}
            onClick={(e) => e.stopPropagation()}
            style={{
              width: '100%', fontSize: 12,
              padding: '2px 4px', border: '1px solid #5F4B82', borderRadius: 4,
              background: '#FFF', color: '#1A1613', outline: 'none',
            }}
          />
        ) : (
          <span
            onClick={(e) => { e.stopPropagation(); setEditingField('title'); }}
            title="클릭해서 제목 편집"
            style={{
              fontSize: 12,
              color: task.status === 'done' ? '#8B95A1' : '#1A1613',
              textDecoration: task.status === 'done' ? 'line-through' : 'none',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              cursor: 'text', display: 'block',
            }}
          >
            {task.title}
          </span>
        )}
      </div>

      {/* Owner — click to cycle */}
      <button
        onClick={cycleOwner}
        title="클릭해서 담당 변경"
        style={{
          flexShrink: 0,
          background: 'transparent', border: 'none',
          fontSize: 10, color: '#8B95A1',
          cursor: 'pointer', padding: '2px 4px',
        }}
      >
        {task.owner || <span style={{ color: '#D1D6DB' }}>담당+</span>}
      </button>

      {/* Status pill — click to cycle */}
      <button
        onClick={cycleStatus}
        title="클릭해서 상태 순환"
        style={{
          flexShrink: 0,
          fontSize: 9, fontWeight: 600, padding: '2px 8px', borderRadius: 100,
          background: si.bg, color: si.tx,
          border: 'none', cursor: 'pointer',
        }}
      >
        {si.label}
      </button>

      {/* Delete */}
      <button
        onClick={handleDelete}
        title="삭제"
        style={{
          flexShrink: 0,
          background: 'transparent', border: 'none',
          fontSize: 12, color: '#D1D6DB',
          cursor: 'pointer', padding: '2px 4px',
        }}
        onMouseEnter={(e) => { e.currentTarget.style.color = '#B84848'; }}
        onMouseLeave={(e) => { e.currentTarget.style.color = '#D1D6DB'; }}
      >×</button>
    </div>
  );
}
