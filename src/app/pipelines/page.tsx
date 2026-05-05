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
  const [collapsedTracks, setCollapsedTracks] = useState<Set<string>>(new Set());
  const [addingProjectInTrack, setAddingProjectInTrack] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  // Persist track collapsed state
  useEffect(() => {
    try {
      const raw = localStorage.getItem('peacer-pipelines-collapsed-tracks');
      if (raw) setCollapsedTracks(new Set(JSON.parse(raw)));
    } catch {}
  }, []);
  const toggleTrack = (name: string) => {
    setCollapsedTracks(prev => {
      const n = new Set(prev);
      if (n.has(name)) n.delete(name); else n.add(name);
      try { localStorage.setItem('peacer-pipelines-collapsed-tracks', JSON.stringify([...n])); } catch {}
      return n;
    });
  };

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

  // Rename pipeline (updates all tasks with this pipeline name)
  const renamePipeline = useCallback(async (oldName: string, newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    setTasks(prev => prev.map(t => t.pipeline === oldName ? { ...t, pipeline: trimmed } : t));
    const { error } = await supabase.from('tasks').update({ pipeline: trimmed }).eq('pipeline', oldName);
    if (error) {
      console.error(error);
      fetchTasks();
    }
  }, [fetchTasks]);

  // All pipeline names (for "move to" menu)
  const allPipelineNames = useMemo(() => {
    const set = new Set<string>();
    tasks.forEach(t => { if (t.pipeline) set.add(t.pipeline); });
    return [...set].sort();
  }, [tasks]);

  // Group by pipeline (search filters tasks; pipelines with 0 visible tasks are hidden)
  const projects = useMemo(() => {
    const q = search.trim().toLowerCase();
    const matches = (t: AppTask): boolean => {
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        (t.pipeline || '').toLowerCase().includes(q) ||
        (t.stage || '').toLowerCase().includes(q) ||
        (t.owner || '').toLowerCase().includes(q) ||
        (t.note || '').toLowerCase().includes(q)
      );
    };

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
      let visible = hideDone ? sorted.filter(t => t.status !== 'done') : sorted;
      if (q) visible = visible.filter(matches);
      const nextAction = sorted.find(t => t.status !== 'done');
      const activeDeadlines = group.filter(t => t.status !== 'done' && t.deadline).map(t => t.deadline!);
      const nearestDeadline = activeDeadlines.length > 0 ? activeDeadlines.reduce((a, b) => a < b ? a : b) : null;
      const matchesProjectName = !q || name.toLowerCase().includes(q);
      const hasVisibleTask = visible.length > 0;
      return {
        name, tasks: sorted, visible, total, done, health, nextAction, nearestDeadline,
        pct: total > 0 ? Math.round((done / total) * 100) : 0,
        hidden: q !== '' && !matchesProjectName && !hasVisibleTask,
      };
    }).filter(p => !p.hidden);

    let unassignedFiltered = hideDone ? unassigned.filter(t => t.status !== 'done') : unassigned;
    if (q) unassignedFiltered = unassignedFiltered.filter(matches);

    list.sort((a, b) => {
      const order = { overdue: 0, 'at-risk': 1, 'on-track': 2, idle: 3, done: 4 };
      const oa = order[a.health.status as keyof typeof order];
      const ob = order[b.health.status as keyof typeof order];
      if (oa !== ob) return oa - ob;
      if (a.nearestDeadline && b.nearestDeadline) return a.nearestDeadline < b.nearestDeadline ? -1 : 1;
      return a.name < b.name ? -1 : 1;
    });
    return { list, unassigned: unassignedFiltered, allUnassigned: unassigned };
  }, [tasks, hideDone, search]);

  // Group projects by track (dominant category)
  const tracks = useMemo(() => {
    const TRACK_ORDER = ['제품', '운영', '마케팅', '기타'];
    const TRACK_META: Record<string, { emoji: string; color: string; bg: string }> = {
      '제품':   { emoji: '🧴', color: '#5F4B82', bg: '#EFEBFA' },
      '운영':   { emoji: '🏢', color: '#2E5A82', bg: '#E4EFF5' },
      '마케팅': { emoji: '📣', color: '#8B4848', bg: '#FAF0F0' },
      '기타':   { emoji: '📌', color: '#4A3F38', bg: '#F5F1EA' },
    };
    const buckets: Record<string, ProjectData[]> = {};
    TRACK_ORDER.forEach(t => { buckets[t] = []; });

    projects.list.forEach(p => {
      // Determine dominant category
      const counts: Record<string, number> = {};
      p.tasks.forEach(t => {
        const c = t.category || '기타';
        counts[c] = (counts[c] || 0) + 1;
      });
      // Map legacy categories to current 4
      const legacyMap: Record<string, string> = {
        '제조': '제품', '디자인': '제품', '사업자/인허가': '운영', '계약': '운영',
      };
      const remapped: Record<string, number> = {};
      Object.entries(counts).forEach(([k, v]) => {
        const target = legacyMap[k] || k;
        const final = TRACK_ORDER.includes(target) ? target : '기타';
        remapped[final] = (remapped[final] || 0) + v;
      });
      const dominant = Object.entries(remapped).sort((a, b) => b[1] - a[1])[0]?.[0] || '기타';
      buckets[dominant].push(p);
    });

    return TRACK_ORDER.map(name => {
      const projs = buckets[name];
      const total = projs.reduce((s, p) => s + p.total, 0);
      const done = projs.reduce((s, p) => s + p.done, 0);
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      const overdue = projs.filter(p => p.health.status === 'overdue').length;
      const atRisk = projs.filter(p => p.health.status === 'at-risk').length;
      // Hide if no projects AND it's "기타" (avoid empty etc track)
      // Always show 제품/운영/마케팅 even if empty (so user sees they can add)
      return { name, projects: projs, total, done, pct, overdue, atRisk, ...TRACK_META[name] };
    }).filter(t => t.name !== '기타' || t.projects.length > 0);
  }, [projects.list]);

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

      <div style={{ display: 'flex', gap: 8, marginBottom: 12, alignItems: 'center' }}>
        <input
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="제목, 프로젝트, 단계, 담당, 메모로 검색…"
          style={{
            flex: 1, padding: '8px 12px',
            border: '1px solid #E5E8EB', borderRadius: 8,
            background: '#FFF', fontSize: 13, color: '#1A1613', outline: 'none',
            fontFamily: 'inherit',
          }}
        />
        {search && (
          <button
            onClick={() => setSearch('')}
            style={{
              padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 500,
              background: '#F2F4F6', color: '#4E5968', border: '1px solid #E5E8EB',
              cursor: 'pointer',
            }}
          >초기화</button>
        )}
        <button
          onClick={() => setHideDone(!hideDone)}
          style={{
            padding: '6px 12px', borderRadius: 8, fontSize: 11, fontWeight: 500,
            background: hideDone ? '#EFEBFA' : '#F2F4F6',
            color: hideDone ? '#5F4B82' : '#8B95A1',
            border: `1px solid ${hideDone ? '#A896C4' : '#E5E8EB'}`,
            cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {hideDone ? '완료 보기' : '완료 숨기기'}
        </button>
      </div>

      <div style={{ fontSize: 12, color: '#8B95A1', marginBottom: 12 }}>
        <strong style={{ color: '#1A1613', fontSize: 14, fontWeight: 700 }}>{projects.list.length}</strong> 프로젝트 ·
        <strong style={{ color: '#B84848', fontSize: 14, fontWeight: 700, marginLeft: 6 }}>
          {projects.list.filter(p => p.health.status === 'overdue').length}
        </strong> 지연 ·
        <strong style={{ color: '#E8A04C', fontSize: 14, fontWeight: 700, marginLeft: 6 }}>
          {projects.list.filter(p => p.health.status === 'at-risk').length}
        </strong> 임박
        {projects.allUnassigned.filter(t => t.status !== 'done').length > 0 && (
          <span style={{ marginLeft: 6 }}>
            ·
            <strong style={{ color: '#8B95A1', fontSize: 14, fontWeight: 700, marginLeft: 6 }}>
              {projects.allUnassigned.filter(t => t.status !== 'done').length}
            </strong> 미지정
          </span>
        )}
      </div>

      {projects.list.length === 0 && projects.unassigned.length === 0 ? (
        <div style={{
          padding: '60px 20px', textAlign: 'center', background: '#FFF',
          border: '1px solid #E5E8EB', borderRadius: 12, color: '#8B95A1',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 6, color: '#4E5968' }}>
            {search ? '검색 결과 없음' : '아직 프로젝트가 없어요'}
          </div>
          <p style={{ fontSize: 12, margin: 0 }}>
            {search ? '다른 검색어를 시도해보세요.' : '태스크에 워크스트림을 지정하면 여기에 나타나요.'}
          </p>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
          {tracks.map(track => {
            const isCollapsed = collapsedTracks.has(track.name);
            const isAdding = addingProjectInTrack === track.name;
            return (
              <section key={track.name}>
                {/* Track header */}
                <div
                  onClick={() => toggleTrack(track.name)}
                  style={{
                    display: 'flex', alignItems: 'center', gap: 10,
                    padding: '10px 12px', marginBottom: 8,
                    background: track.bg,
                    border: `1px solid ${track.color}33`,
                    borderRadius: 10,
                    cursor: 'pointer',
                  }}
                >
                  <span style={{ fontSize: 16 }}>{track.emoji}</span>
                  <h2 style={{
                    margin: 0, fontSize: 15, fontWeight: 700,
                    color: track.color, letterSpacing: '-0.01em', flex: 1,
                  }}>
                    {track.name}
                  </h2>
                  {track.projects.length > 0 ? (
                    <>
                      <span style={{ fontSize: 11, color: track.color, fontWeight: 600 }}>
                        {track.projects.length}개 프로젝트
                      </span>
                      <span style={{ fontSize: 11, color: '#8B95A1' }}>
                        · {track.done}/{track.total} ({track.pct}%)
                      </span>
                      {track.overdue > 0 && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 100,
                          background: '#FDE8E8', color: '#B84848', border: '1px solid #F0C4C4',
                        }}>
                          지연 {track.overdue}
                        </span>
                      )}
                      {track.atRisk > 0 && (
                        <span style={{
                          fontSize: 10, fontWeight: 600, padding: '1px 7px', borderRadius: 100,
                          background: '#FFF4E0', color: '#8B5A2A', border: '1px solid #E8A04C',
                        }}>
                          임박 {track.atRisk}
                        </span>
                      )}
                    </>
                  ) : (
                    <span style={{ fontSize: 11, color: '#8B95A1', fontStyle: 'italic' }}>
                      비어 있음 — 첫 프로젝트를 추가해보세요
                    </span>
                  )}
                  <span style={{
                    fontSize: 12, color: track.color, marginLeft: 4,
                    transform: isCollapsed ? 'rotate(0)' : 'rotate(90deg)',
                    transition: 'transform .2s',
                  }}>▸</span>
                </div>

                {/* Track body */}
                {!isCollapsed && (
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingLeft: 4 }}>
                    {track.projects.map(proj => (
                      <ProjectCard
                        key={proj.name}
                        project={proj}
                        allPipelines={allPipelineNames}
                        expanded={expandedProjects.has(proj.name)}
                        onToggle={() => toggleExpand(proj.name)}
                        onUpdate={updateTask}
                        onCreate={createTask}
                        onDelete={deleteTask}
                        onRenamePipeline={renamePipeline}
                      />
                    ))}
                    {/* Add new project in this track */}
                    {isAdding ? (
                      <NewProjectForm
                        trackName={track.name}
                        onCancel={() => setAddingProjectInTrack(null)}
                        onCreate={(projName, taskTitle, deadline, stage) => {
                          createTask(projName, {
                            title: taskTitle,
                            deadline: deadline || null,
                            stage: stage || null,
                            category: track.name,
                          });
                          setAddingProjectInTrack(null);
                        }}
                      />
                    ) : (
                      <button
                        onClick={() => setAddingProjectInTrack(track.name)}
                        style={{
                          padding: '10px 14px',
                          background: 'transparent',
                          border: `1px dashed ${track.color}66`,
                          borderRadius: 8,
                          color: track.color,
                          fontSize: 12, fontWeight: 500, cursor: 'pointer',
                          textAlign: 'left',
                        }}
                      >
                        + 새 프로젝트 ({track.name})
                      </button>
                    )}
                  </div>
                )}
              </section>
            );
          })}

          {/* Unassigned tasks as a pseudo-project */}
          {projects.unassigned.length > 0 && (
            <UnassignedCard
              tasks={projects.unassigned}
              allPipelines={allPipelineNames}
              expanded={expandedProjects.has('__unassigned__')}
              onToggle={() => toggleExpand('__unassigned__')}
              onUpdate={updateTask}
              onDelete={deleteTask}
            />
          )}
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

function ProjectCard({ project, allPipelines, expanded, onToggle, onUpdate, onCreate, onDelete, onRenamePipeline }: {
  project: ProjectData;
  allPipelines: string[];
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (id: string, patch: Partial<AppTask>) => void;
  onCreate: (pipeline: string, partial: Partial<AppTask>) => void;
  onDelete: (id: string) => void;
  onRenamePipeline: (oldName: string, newName: string) => void;
}) {
  const { name, visible, done, total, health, nextAction, pct } = project;
  const [adding, setAdding] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDate, setNewDate] = useState('');
  const [newStage, setNewStage] = useState<string>('');
  const [editingName, setEditingName] = useState(false);
  const [nameDraft, setNameDraft] = useState(name);

  useEffect(() => { setNameDraft(name); }, [name]);

  const saveName = () => {
    const t = nameDraft.trim();
    if (t && t !== name) onRenamePipeline(name, t);
    setEditingName(false);
  };

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
            {editingName ? (
              <input
                autoFocus
                value={nameDraft}
                onChange={(e) => setNameDraft(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') saveName();
                  if (e.key === 'Escape') { setNameDraft(name); setEditingName(false); }
                }}
                onClick={(e) => e.stopPropagation()}
                style={{
                  fontSize: 15, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.01em',
                  padding: '2px 6px', border: '1.5px solid #5F4B82', borderRadius: 4,
                  background: '#FFF', outline: 'none', minWidth: 120,
                }}
              />
            ) : (
              <h3
                onClick={(e) => { e.stopPropagation(); setEditingName(true); }}
                title="클릭해서 이름 변경"
                style={{
                  margin: 0, fontSize: 15, fontWeight: 700, color: '#1A1613',
                  letterSpacing: '-0.01em', cursor: 'text',
                  padding: '2px 4px', borderRadius: 4,
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#F2F4F6'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {name}
              </h3>
            )}
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
              allPipelines={allPipelines}
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

function EditableTaskRow({ task, allPipelines, onUpdate, onDelete, isLast }: {
  task: AppTask;
  allPipelines: string[];
  onUpdate: (id: string, patch: Partial<AppTask>) => void;
  onDelete: (id: string) => void;
  isLast: boolean;
}) {
  const [editingField, setEditingField] = useState<'title' | 'date' | null>(null);
  const [titleDraft, setTitleDraft] = useState(task.title);
  const [menuOpen, setMenuOpen] = useState(false);
  const dateRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [menuOpen]);

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

      {/* More menu — move to other pipeline / unassign */}
      <div ref={menuRef} style={{ position: 'relative', flexShrink: 0 }}>
        <button
          onClick={(e) => { e.stopPropagation(); setMenuOpen(!menuOpen); }}
          title="이동/메뉴"
          style={{
            background: 'transparent', border: 'none',
            fontSize: 12, color: '#D1D6DB',
            cursor: 'pointer', padding: '2px 4px',
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = '#5F4B82'; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = '#D1D6DB'; }}
        >⋯</button>
        {menuOpen && (
          <div style={{
            position: 'absolute', top: '100%', right: 0, zIndex: 50,
            marginTop: 4, minWidth: 180,
            background: '#FFF', border: '1px solid #E5E8EB', borderRadius: 8,
            boxShadow: '0 8px 24px rgba(0,0,0,.08)',
            padding: 4, fontSize: 11,
          }}
          onClick={(e) => e.stopPropagation()}
          >
            <div style={{ padding: '6px 10px 4px', fontSize: 10, color: '#8B95A1', fontWeight: 600, letterSpacing: '0.05em' }}>
              다른 프로젝트로 이동
            </div>
            {allPipelines.filter(p => p !== task.pipeline).map(p => (
              <button
                key={p}
                onClick={() => { onUpdate(task.id, { pipeline: p }); setMenuOpen(false); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 10px', borderRadius: 4,
                  background: 'transparent', border: 'none', fontSize: 12,
                  color: '#1A1613', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#F2F4F6'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >
                {p}
              </button>
            ))}
            <button
              onClick={() => {
                const name = window.prompt('새 프로젝트 이름');
                if (name && name.trim()) {
                  onUpdate(task.id, { pipeline: name.trim() });
                }
                setMenuOpen(false);
              }}
              style={{
                display: 'block', width: '100%', textAlign: 'left',
                padding: '6px 10px', borderRadius: 4,
                background: 'transparent', border: 'none', fontSize: 12,
                color: '#5F4B82', fontWeight: 600, cursor: 'pointer',
              }}
              onMouseEnter={(e) => { e.currentTarget.style.background = '#F2F4F6'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
            >+ 새 프로젝트…</button>
            <div style={{ height: 1, background: '#F2F4F6', margin: '4px 0' }} />
            {task.pipeline && (
              <button
                onClick={() => { onUpdate(task.id, { pipeline: null }); setMenuOpen(false); }}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '6px 10px', borderRadius: 4,
                  background: 'transparent', border: 'none', fontSize: 12,
                  color: '#8B95A1', cursor: 'pointer',
                }}
                onMouseEnter={(e) => { e.currentTarget.style.background = '#F2F4F6'; }}
                onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; }}
              >프로젝트 해제</button>
            )}
          </div>
        )}
      </div>

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

function UnassignedCard({ tasks, allPipelines, expanded, onToggle, onUpdate, onDelete }: {
  tasks: AppTask[];
  allPipelines: string[];
  expanded: boolean;
  onToggle: () => void;
  onUpdate: (id: string, patch: Partial<AppTask>) => void;
  onDelete: (id: string) => void;
}) {
  const sorted = sortTasks(tasks);
  const previewCount = 4;
  const tasksToShow = expanded ? sorted : sorted.slice(0, previewCount);
  const moreCount = Math.max(0, sorted.length - tasksToShow.length);

  return (
    <div style={{
      background: '#FFF',
      border: '1px dashed #E5E8EB',
      borderLeft: '3px solid #C4B8A8',
      borderRadius: 12,
      overflow: 'hidden',
    }}>
      <div
        onClick={onToggle}
        style={{
          padding: '14px 16px', cursor: 'pointer',
          display: 'flex', alignItems: 'center', gap: 12,
          borderBottom: tasks.length > 0 ? '1px solid #F2F4F6' : 'none',
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3 }}>
            <span style={{
              fontSize: 9, padding: '2px 7px', borderRadius: 100, fontWeight: 600,
              background: '#F2F4F6', color: '#8B95A1', border: '1px solid #E5E8EB',
            }}>
              미지정
            </span>
            <h3 style={{ margin: 0, fontSize: 14, fontWeight: 600, color: '#4E5968' }}>
              프로젝트 미지정 태스크
            </h3>
          </div>
          <div style={{ fontSize: 11, color: '#8B95A1' }}>
            아래 메뉴(⋯)에서 프로젝트로 이동시키세요.
          </div>
        </div>
        <span style={{ fontSize: 12, color: '#8B95A1', fontWeight: 600 }}>
          {tasks.length}개
        </span>
        <span style={{
          fontSize: 12, color: '#8B95A1',
          transform: expanded ? 'rotate(90deg)' : 'rotate(0)',
          transition: 'transform .2s',
        }}>▸</span>
      </div>

      {tasks.length > 0 && (
        <div style={{ padding: '6px 0' }}>
          {tasksToShow.map((task, i) => (
            <EditableTaskRow
              key={task.id}
              task={task}
              allPipelines={allPipelines}
              onUpdate={onUpdate}
              onDelete={onDelete}
              isLast={i === tasksToShow.length - 1 && moreCount === 0}
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
        </div>
      )}
    </div>
  );
}

function NewProjectForm({ trackName, onCancel, onCreate }: {
  trackName: string;
  onCancel: () => void;
  onCreate: (projName: string, taskTitle: string, deadline: string, stage: string) => void;
}) {
  const [projName, setProjName] = useState('');
  const [taskTitle, setTaskTitle] = useState('');
  const [date, setDate] = useState('');
  const [stage, setStage] = useState('');

  const submit = () => {
    if (!projName.trim() || !taskTitle.trim()) return;
    onCreate(projName.trim(), taskTitle.trim(), date, stage);
  };

  return (
    <div style={{
      padding: '12px 14px',
      background: '#FAF6EF',
      border: '1.5px solid #5F4B82',
      borderRadius: 10,
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 600 }}>
        새 프로젝트 in {trackName}
      </div>
      <input
        autoFocus
        value={projName}
        onChange={(e) => setProjName(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') onCancel(); }}
        placeholder="프로젝트 이름 (예: 자체 채널, 씨딩, 사우나 컨택…)"
        style={{
          padding: '8px 10px', border: '1px solid #DDD3C2', borderRadius: 6,
          background: '#FFF', fontSize: 13, color: '#1A1613', outline: 'none',
          fontFamily: 'inherit',
        }}
      />
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="date"
          value={date}
          onChange={(e) => setDate(e.target.value)}
          style={{
            flexShrink: 0, width: 130, padding: '6px 8px',
            border: '1px solid #DDD3C2', borderRadius: 6,
            background: '#FFF', fontSize: 12, color: '#1A1613', outline: 'none',
          }}
        />
        <select
          value={stage}
          onChange={(e) => setStage(e.target.value)}
          style={{
            flexShrink: 0, width: 80, padding: '6px 8px',
            border: '1px solid #DDD3C2', borderRadius: 6,
            background: '#FFF', fontSize: 12, color: '#1A1613', outline: 'none',
          }}
        >
          <option value="">단계</option>
          {STAGE_ORDER.filter(Boolean).map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <input
          value={taskTitle}
          onChange={(e) => setTaskTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') onCancel();
          }}
          placeholder="첫 할 일 제목 (예: 컨택 메시지 초안)"
          style={{
            flex: 1, padding: '6px 10px', border: '1px solid #DDD3C2', borderRadius: 6,
            background: '#FFF', fontSize: 12, color: '#1A1613', outline: 'none',
            fontFamily: 'inherit',
          }}
        />
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6 }}>
        <button
          onClick={onCancel}
          style={{
            fontSize: 11, fontWeight: 500, padding: '6px 12px',
            background: '#F2F4F6', color: '#4E5968',
            border: '1px solid #E5E8EB', borderRadius: 6, cursor: 'pointer',
          }}
        >취소</button>
        <button
          onClick={submit}
          disabled={!projName.trim() || !taskTitle.trim()}
          style={{
            fontSize: 11, fontWeight: 600, padding: '6px 14px',
            background: !projName.trim() || !taskTitle.trim() ? '#D1D6DB' : '#191F28',
            color: '#FFF',
            border: 'none', borderRadius: 6,
            cursor: !projName.trim() || !taskTitle.trim() ? 'not-allowed' : 'pointer',
          }}
        >만들기</button>
      </div>
    </div>
  );
}
