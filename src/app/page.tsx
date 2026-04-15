'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, dbToApp, appToDb } from '@/lib/supabase';
import { CATS, CC, STS, SL, SC, OWNERS, MST, OKR, PROJECT_META, PIPELINES, dU, fD, uid } from '@/lib/constants';
import { calcCriticalPath, AppTask } from '@/lib/criticalPath';

// ═══════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════
const todayStr = () => new Date().toISOString().slice(0, 10);

function parseQuickInput(raw: string): Partial<AppTask> {
  const parts = raw.split(',').map((s) => s.trim());
  const title = parts[0] || '';
  const result: Partial<AppTask> = { title, status: 'todo' as const, priority: 'medium' as const };

  const today = new Date();
  for (let i = 1; i < parts.length; i++) {
    const p = parts[i];
    if (p === '오늘') {
      result.deadline = todayStr();
    } else if (p === '내일') {
      const d = new Date(today);
      d.setDate(d.getDate() + 1);
      result.deadline = d.toISOString().slice(0, 10);
    } else if (p === '이번주') {
      const d = new Date(today);
      const day = d.getDay();
      const diff = day === 0 ? 5 : 5 - day;
      d.setDate(d.getDate() + (diff < 0 ? 0 : diff));
      result.deadline = d.toISOString().slice(0, 10);
    } else if (p === '다음주') {
      const d = new Date(today);
      const day = d.getDay();
      const diff = day === 0 ? 1 : 8 - day;
      d.setDate(d.getDate() + diff);
      result.deadline = d.toISOString().slice(0, 10);
    } else if (OWNERS.includes(p)) {
      result.owner = p;
    } else if (['긴급', '급해', '중요'].includes(p)) {
      result.priority = 'high';
    } else if (CATS.includes(p)) {
      result.category = p;
    }
  }
  return result;
}

function getWeekDays(): { date: Date; str: string; label: string }[] {
  const today = new Date();
  const day = today.getDay();
  const monday = new Date(today);
  monday.setDate(today.getDate() - (day === 0 ? 6 : day - 1));
  const dayLabels = ['월', '화', '수', '목', '금', '토', '일'];
  const result = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    result.push({
      date: d,
      str: d.toISOString().slice(0, 10),
      label: dayLabels[i],
    });
  }
  return result;
}

function getDownstream(taskId: string, allTasks: AppTask[], visited = new Set<string>()): AppTask[] {
  if (visited.has(taskId)) return [];
  visited.add(taskId);
  const blocked = allTasks.filter((t) => (t.dependsOn || []).includes(taskId));
  let result = [...blocked];
  for (const b of blocked) {
    result = result.concat(getDownstream(b.id, allTasks, visited));
  }
  return result;
}

const catEmoji: Record<string, string> = {
  '제조': '🧪', '마케팅': '📣', '사업자/인허가': '🏢',
  '디자인': '🎨', '계약': '📝', '기타': '📌',
};

const ownerColors: Record<string, { bg: string; accent: string }> = {
  '풍성': { bg: '#D4C5EA', accent: '#5F4B82' },
  '은채': { bg: '#EDD9C4', accent: '#8B5A3C' },
  '공동': { bg: '#DDD3C2', accent: '#4A3F38' },
};

// ═══════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════
export default function App() {
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [fCat, setFCat] = useState('all');
  const [fOwn, setFOwn] = useState('all');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [cmdText, setCmdText] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [selectMode, setSelectMode] = useState(false);
  const [datePickerId, setDatePickerId] = useState<string | null>(null);
  const [datePickerPos, setDatePickerPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [cascadeConfirm, setCascadeConfirm] = useState<{ taskId: string; newDate: string; oldDate: string; downstream: AppTask[]; diffDays: number } | null>(null);
  const [undoStack, setUndoStack] = useState<{ id: string; prev: Partial<AppTask>; label: string }[]>([]);
  const [toast, setToast] = useState<{ message: string; undoAction?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmdRef = useRef<HTMLInputElement>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());

  // Show toast with optional undo
  const showToast = useCallback((message: string, undoAction?: () => void) => {
    if (toastTimer.current) clearTimeout(toastTimer.current);
    setToast({ message, undoAction });
    toastTimer.current = setTimeout(() => setToast(null), 4000);
  }, []);

  // Undo last action
  const undo = useCallback(() => {
    if (undoStack.length === 0) return;
    const last = undoStack[undoStack.length - 1];
    setUndoStack((prev) => prev.slice(0, -1));
    up(last.id, last.prev);
    showToast(`되돌림: ${last.label}`);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [undoStack, showToast]);

  // Tracked update — saves undo history
  const upWithUndo = (id: string, updates: Partial<AppTask>, label: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const prev: Partial<AppTask> = {};
    for (const key of Object.keys(updates)) {
      (prev as Record<string, unknown>)[key] = (task as Record<string, unknown>)[key];
    }
    setUndoStack((stack) => [...stack.slice(-19), { id, prev, label }]);
    up(id, updates);
  };

  // Cmd+K to focus command bar, Cmd+Z to undo
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        cmdRef.current?.focus();
      }
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        const tag = (e.target as HTMLElement)?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
        e.preventDefault();
        undo();
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, [undo]);

  // Load collapsed state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('peacer-collapsed');
      if (saved) setCollapsed(JSON.parse(saved));
      else {
        if (window.innerWidth < 768) {
          setCollapsed({ weekly: true, projects: true, kanban: true });
        }
      }
    } catch { /* ignore */ }
  }, []);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => {
      const next = { ...prev, [key]: !prev[key] };
      try { localStorage.setItem('peacer-collapsed', JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  };

  // ─── Load from Supabase ───
  const fetchTasks = useCallback(async () => {
    const { data, error } = await supabase
      .from('tasks')
      .select('*')
      .order('created_at', { ascending: true });

    if (error) {
      console.error('Fetch error:', error);
      return;
    }
    if (data) {
      setTasks(data.map(dbToApp));
      setLoaded(true);
    }
  }, []);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  // ─── Realtime subscription ───
  useEffect(() => {
    const channel = supabase
      .channel('tasks-realtime')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'tasks' },
        (payload) => {
          if (payload.eventType === 'INSERT') {
            const newTask = dbToApp(payload.new);
            setTasks((prev) => {
              if (prev.find((t) => t.id === newTask.id)) return prev;
              return [...prev, newTask];
            });
          } else if (payload.eventType === 'UPDATE') {
            const updated = dbToApp(payload.new);
            setTasks((prev) => prev.map((t) => (t.id === updated.id ? updated : t)));
          } else if (payload.eventType === 'DELETE') {
            const old = payload.old as { id: string };
            setTasks((prev) => prev.filter((t) => t.id !== old.id));
          }
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') setRealtimeStatus('connected');
        else if (status === 'CHANNEL_ERROR') setRealtimeStatus('error');
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  // ─── CRUD operations ───
  const up = async (id: string, updates: Partial<AppTask>) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...updates } : t)));
    const dbUpdates = appToDb(updates);
    await supabase.from('tasks').update(dbUpdates).eq('id', id);
  };

  const del = async (id: string) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
    await supabase.from('tasks').delete().eq('id', id);
  };

  const add = async (t: Partial<AppTask>) => {
    const newTask: AppTask = {
      id: uid(),
      title: t.title || '',
      category: t.category || '기타',
      project: t.project || null,
      owner: t.owner || '공동',
      deadline: t.deadline || null,
      status: (t.status as AppTask['status']) || 'todo',
      priority: (t.priority as AppTask['priority']) || 'medium',
      note: t.note || '',
      dependsOn: t.dependsOn || [],
      blocksCount: 0,
    };
    setTasks((prev) => [...prev, newTask]);
    const dbTask = appToDb(newTask);
    await supabase.from('tasks').insert(dbTask);
  };

  const addBatch = async (arr: Partial<AppTask>[]) => {
    const newTasks = arr.map((t) => ({
      id: uid(),
      title: t.title || '',
      category: t.category || '기타',
      project: t.project || null,
      owner: t.owner || '공동',
      deadline: t.deadline || null,
      status: (t.status as AppTask['status']) || 'todo',
      priority: (t.priority as AppTask['priority']) || 'medium',
      note: t.note || '',
      dependsOn: t.dependsOn || [],
      blocksCount: 0,
    }));
    setTasks((prev) => [...prev, ...newTasks]);
    const dbTasks = newTasks.map(appToDb);
    await supabase.from('tasks').insert(dbTasks);
  };

  const applyDeps = async (depsMap: Record<string, string[]>) => {
    setTasks((prev) =>
      prev.map((t) => (depsMap[t.id] ? { ...t, dependsOn: depsMap[t.id] } : t))
    );
    for (const [id, deps] of Object.entries(depsMap)) {
      await supabase.from('tasks').update({ depends_on: deps }).eq('id', id);
    }
  };

  // ─── Cascade date shift ───
  const shiftDateBy = (dateStr: string, days: number): string => {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  };

  const handleDateChange = (taskId: string, newDate: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    const oldDate = task.deadline;
    if (!oldDate) {
      up(taskId, { deadline: newDate });
      setDatePickerId(null);
      return;
    }
    const diffDays = Math.round((new Date(newDate + 'T00:00:00').getTime() - new Date(oldDate + 'T00:00:00').getTime()) / 864e5);
    if (diffDays === 0) { setDatePickerId(null); return; }

    const downstream = getDownstream(taskId, tasks);
    if (downstream.length > 0) {
      setCascadeConfirm({ taskId, newDate, oldDate, downstream, diffDays });
      setDatePickerId(null);
    } else {
      up(taskId, { deadline: newDate });
      setDatePickerId(null);
    }
  };

  const applyCascade = async (cascadeAll: boolean) => {
    if (!cascadeConfirm) return;
    const { taskId, newDate, downstream, diffDays } = cascadeConfirm;
    up(taskId, { deadline: newDate });
    if (cascadeAll) {
      for (const dt of downstream) {
        if (dt.deadline) {
          const shifted = shiftDateBy(dt.deadline, diffDays);
          up(dt.id, { deadline: shifted });
        }
      }
    }
    setCascadeConfirm(null);
  };

  // ─── Status/Owner/Priority cycling ───
  const cycleStatus = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const activeCycle: (typeof STS[number])[] = ['todo', 'doing', 'waiting'];
    const idx = activeCycle.indexOf(task.status as typeof STS[number]);
    const next = idx >= 0 ? activeCycle[(idx + 1) % activeCycle.length] : 'todo';
    upWithUndo(id, { status: next as AppTask['status'] }, `"${task.title}" ${SL[task.status]} → ${SL[next]}`);
    showToast(`${SL[next]}으로 변경: ${task.title}`);
  };

  const markDone = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    upWithUndo(id, { status: 'done' as AppTask['status'] }, `"${task.title}" 완료 처리`);
    showToast(`✓ 완료: ${task.title}`, () => {
      undo();
    });
  };

  const cycleOwner = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const idx = OWNERS.indexOf(task.owner);
    const next = OWNERS[(idx + 1) % OWNERS.length];
    upWithUndo(id, { owner: next }, `"${task.title}" 담당 ${task.owner} → ${next}`);
  };

  const cyclePriority = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const order: AppTask['priority'][] = ['medium', 'high', 'low'];
    const idx = order.indexOf(task.priority as AppTask['priority']);
    const next = order[(idx + 1) % order.length];
    upWithUndo(id, { priority: next }, `"${task.title}" 우선순위 변경`);
  };

  // ─── Batch operations ───
  const batchShift = (days: number) => {
    selectedIds.forEach((id) => {
      const t = tasks.find((x) => x.id === id);
      if (t?.deadline) {
        up(id, { deadline: shiftDateBy(t.deadline, days) });
      } else {
        const d = new Date();
        d.setDate(d.getDate() + days);
        up(id, { deadline: d.toISOString().slice(0, 10) });
      }
    });
  };

  const batchStatus = (status: string) => {
    selectedIds.forEach((id) => {
      up(id, { status: status as AppTask['status'] });
    });
    setSelectedIds(new Set());
    setSelectMode(false);
  };

  const batchDelete = () => {
    if (!confirm(`${selectedIds.size}개 삭제할까요?`)) return;
    selectedIds.forEach((id) => del(id));
    setSelectedIds(new Set());
    setSelectMode(false);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  // ─── Derived data ───
  const filtered = tasks.filter((t) => {
    if (fCat !== 'all' && t.category !== fCat) return false;
    if (fOwn !== 'all' && t.owner !== fOwn) return false;
    return true;
  });

  const { enriched } = calcCriticalPath(tasks);

  const todayDate = todayStr();


  // ─── Projects listing ───
  const projects = useMemo(() => {
    const map: Record<string, { tasks: AppTask[]; category: string }> = {};
    tasks.forEach(t => {
      const proj = t.project || '기타';
      if (!map[proj]) map[proj] = { tasks: [], category: t.category };
      map[proj].tasks.push(t);
    });
    return Object.entries(map)
      .map(([name, { tasks: items, category }]) => {
        const doneCount = items.filter(t => t.status === 'done').length;
        const total = items.length;
        const activeCount = total - doneCount;
        const owners = items.map(t => t.owner);
        const primaryOwner = owners.sort((a, b) =>
          owners.filter(v => v === b).length - owners.filter(v => v === a).length
        )[0] || '공동';
        const isNew = items.every(t => t.status === 'todo');
        return { name, category, items, done: doneCount, total, active: activeCount, primaryOwner, isNew };
      })
      .sort((a, b) => b.active - a.active);
  }, [tasks]);

  const toggleProjectExpand = (name: string) => {
    setExpandedProjects(prev => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  // ─── Loading state ───
  if (!loaded) {
    return (
      <div style={{ ...S.root, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 24, marginBottom: 8 }}>PEACER</div>
          <div style={{ fontSize: 13, color: '#8A7D72' }}>...</div>
        </div>
      </div>
    );
  }

  // Suppress unused warnings for preserved functions
  void addBatch;
  void applyDeps;

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* ─── HEADER (sticky) ─── */}
      <header style={S.header}>
        <div style={S.hL}>
          <div style={S.brand}>
            <span style={S.dot} />
            <span style={S.bTxt}>PEACER</span>
            <span
              style={{
                width: 8, height: 8, borderRadius: '50%',
                background: realtimeStatus === 'connected' ? '#A8C496' : realtimeStatus === 'error' ? '#B84848' : '#DDD3C2',
                display: 'inline-block', marginLeft: 4,
              }}
              title={realtimeStatus === 'connected' ? '실시간 연결됨' : realtimeStatus === 'error' ? '연결 오류' : '연결 중...'}
            />
          </div>
        </div>
        <div style={S.hR}>
          {MST.map((m, i) => {
            const d = dU(m.date);
            return (
              <div key={i} style={{ ...S.ms, borderColor: d <= 2 ? '#B84848' : d <= 7 ? m.color : '#D5CCC0' }}>
                <div style={S.msL}>{m.label}</div>
                <div style={{ ...S.msD, color: d <= 0 ? '#B84848' : d <= 5 ? '#8B5A3C' : m.color }}>
                  {d <= 0 ? (d === 0 ? 'D-DAY' : `D+${Math.abs(d)}`) : `D-${d}`}
                </div>
                <div style={S.msDt}>{m.date.replace(/-/g, '.')}</div>
              </div>
            );
          })}
        </div>
      </header>

      {/* ─── QUICK ADD BAR (sticky) ─── */}
      <div style={S.cmdBar}>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', width: '100%', flexWrap: 'wrap' }}>
          <input
            ref={cmdRef as React.RefObject<HTMLInputElement>}
            value={cmdText}
            onChange={(e) => setCmdText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (!cmdText.trim()) return;
                const parsed = parseQuickInput(cmdText.trim());
                if (parsed.title) { add(parsed); setCmdText(''); showToast(`추가됨: ${parsed.title}`); }
              }
            }}
            placeholder="할 일 추가 (예: 몰드 업체 구하기, 오늘, 풍성, 긴급)"
            style={S.cmdInput}
          />
          <button
            onClick={() => {
              if (!cmdText.trim()) return;
              const parsed = parseQuickInput(cmdText.trim());
              if (parsed.title) { add(parsed); setCmdText(''); showToast(`추가됨: ${parsed.title}`); }
            }}
            disabled={!cmdText.trim()}
            style={{ ...S.cmdAddBtn, opacity: !cmdText.trim() ? 0.5 : 1 }}
          >
            추가
          </button>
        </div>
        <div style={{ fontSize: 9, color: '#AAA49C', marginTop: 4 }}>
          콤마로 구분: 제목, 날짜(오늘/내일/이번주/다음주), 담당(풍성/은채), 긴급 · Cmd+K 포커스
        </div>
      </div>

      {/* ─── PIPELINE VIEW — the whole picture at a glance ─── */}
      <PipelineView
        tasks={tasks}
        enriched={enriched}
        todayDate={todayDate}
        onEdit={setEditId}
        onCycleStatus={cycleStatus}
        onMarkDone={markDone}
        onDateClick={(id, e) => { setDatePickerId(id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
        onCycleOwner={cycleOwner}
      />

      {/* ─── SECTION 3: 이번 주 ─── */}
      <CollapsibleSection
        title="📅 이번 주"
        sectionKey="weekly"
        collapsed={!!collapsed.weekly}
        onToggle={() => toggleCollapse('weekly')}
      >
        <WeeklyGrid tasks={tasks} onEdit={setEditId} onDateChange={handleDateChange} />
      </CollapsibleSection>

      {/* ─── SECTION 4: 프로젝트 ─── */}
      <CollapsibleSection
        title="📁 프로젝트"
        sectionKey="projects"
        collapsed={!!collapsed.projects}
        onToggle={() => toggleCollapse('projects')}
      >
        <ProjectCards
          projects={projects}
          expandedProjects={expandedProjects}
          onToggleExpand={toggleProjectExpand}
          onEdit={setEditId}
          onCycleStatus={cycleStatus}
          onMarkDone={markDone}
          onDateClick={(id, e) => { setDatePickerId(id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
        />
      </CollapsibleSection>

      {/* ─── SECTION 5: 전체 보기 (칸반) ─── */}
      <CollapsibleSection
        title="📋 전체 보기 (칸반)"
        sectionKey="kanban"
        collapsed={!!collapsed.kanban}
        onToggle={() => toggleCollapse('kanban')}
      >
        <div style={{ ...S.filterBar, padding: '0 0 8px', margin: 0 }}>
          <div style={S.filters}>
            <select value={fCat} onChange={(e) => setFCat(e.target.value)} style={S.sel}>
              <option value="all">전체 카테고리</option>
              {CATS.map((c) => <option key={c}>{c}</option>)}
            </select>
            <select value={fOwn} onChange={(e) => setFOwn(e.target.value)} style={S.sel}>
              <option value="all">전체 담당</option>
              {OWNERS.map((o) => <option key={o}>{o}</option>)}
            </select>
          </div>
          <button
            onClick={() => { setSelectMode(!selectMode); if (selectMode) setSelectedIds(new Set()); }}
            style={{ ...S.toolBtn, background: selectMode ? '#5F4B82' : '#FAF6EF', color: selectMode ? '#fff' : '#5F4B82' }}
          >
            {selectMode ? '선택 해제' : '선택'}
          </button>
        </div>
        <BoardView
          tasks={filtered}
          selectMode={selectMode} selectedIds={selectedIds}
          onSelect={toggleSelect}
          onEdit={setEditId}
          onCycleStatus={cycleStatus}
          onCycleOwner={cycleOwner}
          onCyclePriority={cyclePriority}
          onMarkDone={markDone}
          onDateClick={(id, e) => { setDatePickerId(id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
          dragId={dragId}
          dragCol={dragCol}
          onDS={(id) => setDragId(id)}
          onDO={(s) => (e: React.DragEvent) => { e.preventDefault(); setDragCol(s); }}
          onDD={(s) => () => { if (dragId) up(dragId, { status: s as AppTask['status'] }); setDragId(null); setDragCol(null); }}
          onDE={() => { setDragId(null); setDragCol(null); }}
        />
      </CollapsibleSection>

      {/* ─── BATCH ACTION BAR ─── */}
      {selectMode && selectedIds.size > 0 && (
        <div style={S.batchBar}>
          <span style={S.batchLabel}>{selectedIds.size}개 선택</span>
          <button onClick={() => batchShift(1)} style={S.batchBtn}>+1일</button>
          <button onClick={() => batchShift(3)} style={S.batchBtn}>+3일</button>
          <button onClick={() => batchShift(7)} style={S.batchBtn}>+7일</button>
          <select onChange={(e) => { if (e.target.value) batchStatus(e.target.value); e.target.value = ''; }} style={S.batchSel}>
            <option value="">상태변경</option>
            {STS.map((s) => <option key={s} value={s}>{SL[s]}</option>)}
          </select>
          <button onClick={batchDelete} style={{ ...S.batchBtn, background: '#B84848', color: '#fff' }}>삭제</button>
        </div>
      )}

      {/* ─── DATE PICKER POPUP ─── */}
      {datePickerId && (
        <DatePicker
          task={tasks.find((t) => t.id === datePickerId)!}
          pos={datePickerPos}
          onClose={() => setDatePickerId(null)}
          onDateChange={(date) => handleDateChange(datePickerId, date)}
        />
      )}

      {/* ─── CASCADE CONFIRM ─── */}
      {cascadeConfirm && (
        <div style={S.backdrop} onClick={() => setCascadeConfirm(null)}>
          <div style={{ ...S.modal, maxWidth: 400 }} onClick={(e) => e.stopPropagation()}>
            <div style={S.mHead}>
              <h2 style={S.mTitle}>연결된 태스크 이동</h2>
              <button onClick={() => setCascadeConfirm(null)} style={S.mClose}>x</button>
            </div>
            <div style={S.mBody}>
              <div style={{ fontSize: 13, marginBottom: 8 }}>
                연결된 {cascadeConfirm.downstream.length}개 태스크도 같이 {cascadeConfirm.diffDays > 0 ? `+${cascadeConfirm.diffDays}` : cascadeConfirm.diffDays}일 밀까요?
              </div>
              <div style={{ maxHeight: 200, overflowY: 'auto', marginBottom: 10 }}>
                {cascadeConfirm.downstream.map((dt) => (
                  <div key={dt.id} style={{ fontSize: 11, padding: '4px 8px', borderLeft: `2px solid ${(CC[dt.category] || CC['기타']).bd}`, marginBottom: 3, display: 'flex', justifyContent: 'space-between' }}>
                    <span>{dt.title}</span>
                    {dt.deadline && (
                      <span style={{ color: '#8A7D72', fontStyle: 'italic' }}>
                        {fD(dt.deadline)} {' -> '} {fD(shiftDateBy(dt.deadline, cascadeConfirm.diffDays))}
                      </span>
                    )}
                  </div>
                ))}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button onClick={() => applyCascade(true)} style={S.confirmBtn}>같이 밀기</button>
                <button onClick={() => applyCascade(false)} style={{ ...S.canBtn, flex: 1, padding: '10px 14px' }}>이것만 변경</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── EDITOR MODAL ─── */}
      {editId && (
        <Editor
          task={tasks.find((t) => t.id === editId)}
          onClose={() => setEditId(null)}
          onSave={(t) => { up(editId, t); setEditId(null); }}
          onDelete={() => { del(editId); setEditId(null); }}
          allTasks={tasks}
        />
      )}

      {/* ─── TOAST ─── */}
      {toast && (
        <div style={{
          position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
          background: '#1A1613', color: '#FAF6EF', padding: '10px 18px',
          borderRadius: 2, fontSize: 12, fontWeight: 400, zIndex: 2000,
          display: 'flex', alignItems: 'center', gap: 12, boxShadow: '0 4px 20px rgba(0,0,0,.25)',
          animation: 'fadeUp .2s ease-out',
        }}>
          <span>{toast.message}</span>
          {toast.undoAction && (
            <button onClick={() => { toast.undoAction!(); setToast(null); }} style={{
              background: 'transparent', border: '1px solid #FAF6EF55', color: '#FAF6EF',
              padding: '3px 10px', borderRadius: 2, fontSize: 11, cursor: 'pointer', fontWeight: 500,
            }}>
              되돌리기
            </button>
          )}
          {!toast.undoAction && undoStack.length > 0 && (
            <button onClick={() => { undo(); setToast(null); }} style={{
              background: 'transparent', border: '1px solid #FAF6EF55', color: '#FAF6EF',
              padding: '3px 10px', borderRadius: 2, fontSize: 11, cursor: 'pointer', fontWeight: 500,
            }}>
              Cmd+Z 되돌리기
            </button>
          )}
        </div>
      )}

      <footer style={S.footer}>
        <span>PEACER</span>
        <button onClick={() => { if (confirm('새로고침?')) fetchTasks(); }} style={S.fLink}>새로고침</button>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>v9.0</span>
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// PIPELINE VIEW — "우리 지금 어디야?" in 3 seconds
// ═══════════════════════════════════════════════════
function PipelineView({
  tasks, enriched, todayDate,
  onEdit, onCycleStatus, onMarkDone, onDateClick, onCycleOwner,
}: {
  tasks: AppTask[];
  enriched: AppTask[];
  todayDate: string;
  onEdit: (id: string) => void;
  onCycleStatus: (id: string) => void;
  onMarkDone: (id: string) => void;
  onDateClick: (id: string, e: React.MouseEvent) => void;
  onCycleOwner: (id: string) => void;
}) {
  const [expandedPipe, setExpandedPipe] = useState<Set<string>>(new Set());

  type StepData = {
    name: string; emoji: string; goal: string;
    done: number; total: number; status: 'done' | 'active' | 'overdue' | 'blocked' | 'todo';
    nextAction: AppTask | null; restActions: AppTask[];
  };
  type PipeData = {
    name: string; emoji: string; steps: StepData[];
    done: number; total: number;
    topActions: AppTask[];
  };

  const data = useMemo(() => {
    // Index enriched tasks by project
    const byProjectAll: Record<string, AppTask[]> = {};
    const byProjectActive: Record<string, AppTask[]> = {};
    tasks.forEach(t => {
      const p = t.project || '기타';
      if (!byProjectAll[p]) byProjectAll[p] = [];
      byProjectAll[p].push(t);
    });
    enriched.forEach(t => {
      const p = t.project || '기타';
      if (!byProjectActive[p]) byProjectActive[p] = [];
      byProjectActive[p].push(t);
    });

    const buildStep = (projName: string): StepData => {
      const all = byProjectAll[projName] || [];
      const active = byProjectActive[projName] || [];
      const meta = PROJECT_META[projName] || { goal: '', emoji: '📌' };
      const doneCount = all.filter(t => t.status === 'done').length;
      const total = all.length;

      const unblocked = active.filter(t => t.isUnblocked).sort((a, b) => {
        if ((b.blocksCount || 0) !== (a.blocksCount || 0)) return (b.blocksCount || 0) - (a.blocksCount || 0);
        return dU(a.deadline) - dU(b.deadline);
      });
      const hasOverdue = all.some(t => t.deadline && t.status !== 'done' && dU(t.deadline) < 0);
      const allDone = total > 0 && doneCount === total;
      const hasActive = active.length > 0;
      const hasUnblocked = unblocked.length > 0;

      let status: StepData['status'] = 'todo';
      if (allDone) status = 'done';
      else if (hasOverdue) status = 'overdue';
      else if (hasUnblocked) status = 'active';
      else if (hasActive) status = 'blocked';

      return {
        name: projName, emoji: meta.emoji, goal: meta.goal,
        done: doneCount, total,
        status,
        nextAction: unblocked[0] || null,
        restActions: unblocked.slice(1),
      };
    };

    const pipes: PipeData[] = PIPELINES.map(pipe => {
      const steps = pipe.steps.map(buildStep);
      const done = steps.reduce((s, st) => s + st.done, 0);
      const total = steps.reduce((s, st) => s + st.total, 0);
      // Collect all "next actions" across steps for this pipeline, sorted by urgency
      const topActions = steps
        .flatMap(st => st.nextAction ? [st.nextAction] : [])
        .sort((a, b) => {
          const aOd = a.deadline && a.deadline < todayDate ? -1 : 0;
          const bOd = b.deadline && b.deadline < todayDate ? -1 : 0;
          if (aOd !== bOd) return aOd - bOd;
          if ((b.blocksCount || 0) !== (a.blocksCount || 0)) return (b.blocksCount || 0) - (a.blocksCount || 0);
          return dU(a.deadline) - dU(b.deadline);
        });
      return { name: pipe.name, emoji: pipe.emoji, steps, done, total, topActions };
    });

    const totalDone = pipes.reduce((s, p) => s + p.done, 0);
    const totalAll = pipes.reduce((s, p) => s + p.total, 0);

    // Per-person "지금 이거" — top 1 action per person across all pipelines
    const allActions = pipes.flatMap(p => p.topActions);
    const personFocus: Record<string, AppTask | null> = {};
    for (const owner of OWNERS.filter(o => o !== '공동')) {
      const mine = allActions.filter(t => t.owner === owner);
      const shared = allActions.filter(t => t.owner === '공동');
      personFocus[owner] = mine[0] || shared[0] || null;
    }

    return { pipes, totalDone, totalAll, personFocus };
  }, [tasks, enriched, todayDate]);

  const togglePipe = (name: string) => {
    setExpandedPipe(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  const stepColors: Record<StepData['status'], { bg: string; bd: string; tx: string }> = {
    done: { bg: '#A8C496', bd: '#A8C496', tx: '#fff' },
    active: { bg: '#5F4B82', bd: '#5F4B82', tx: '#fff' },
    overdue: { bg: '#B84848', bd: '#B84848', tx: '#fff' },
    blocked: { bg: '#F5F1EA', bd: '#DDD3C2', tx: '#8A7D72' },
    todo: { bg: '#F5F1EA', bd: '#DDD3C2', tx: '#AAA49C' },
  };

  const renderActionCard = (t: AppTask, compact?: boolean) => {
    const isOverdue = t.deadline != null && t.deadline < todayDate;
    const oc = ownerColors[t.owner] || ownerColors['공동'];
    return (
      <div
        key={t.id}
        onClick={() => onEdit(t.id)}
        style={{
          padding: compact ? '5px 8px' : '7px 10px',
          background: '#FAF6EF',
          borderRadius: 2, cursor: 'pointer',
          borderLeft: `3px solid ${isOverdue ? '#B84848' : (t.blocksCount || 0) > 0 ? '#5F4B82' : '#A896C4'}`,
          transition: 'all .15s',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <span style={{ fontSize: compact ? 11 : 12, fontWeight: 400, flex: 1, lineHeight: 1.4, minWidth: 0 }}>
            {t.title}
          </span>
          <span
            onClick={(e) => { e.stopPropagation(); onCycleOwner(t.id); }}
            style={{ ...S.ownB, cursor: 'pointer', background: oc.bg, color: oc.accent }}
          >
            {t.owner}
          </span>
          {t.deadline && (
            <span
              onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
              style={{
                fontSize: 10, fontFamily: "'DM Serif Display',serif", fontStyle: 'italic',
                color: isOverdue ? '#B84848' : '#8A7D72', cursor: 'pointer',
                background: isOverdue ? '#FBEDEA' : 'transparent',
                padding: '1px 6px', borderRadius: 100,
                border: isOverdue ? '1px solid #D4A4A4' : '1px solid #E8DFCE',
              }}
            >
              {fD(t.deadline)}
              <span style={{ fontSize: 8, marginLeft: 3 }}>
                {dU(t.deadline) < 0 ? `D+${Math.abs(dU(t.deadline))}` : dU(t.deadline) === 0 ? 'TODAY' : `D-${dU(t.deadline)}`}
              </span>
            </span>
          )}
          <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
            <span
              onClick={(e) => { e.stopPropagation(); onCycleStatus(t.id); }}
              style={{ ...S.stBadge, background: SC[t.status]?.bg, color: SC[t.status]?.tx, border: `1px solid ${SC[t.status]?.bd}`, cursor: 'pointer' }}
            >
              {SL[t.status]}
            </span>
            <span
              onClick={(e) => { e.stopPropagation(); onMarkDone(t.id); }}
              style={{ width: 18, height: 18, borderRadius: 2, border: '1.5px solid #A8C496', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 10, color: '#A8C496' }}
            >✓</span>
          </div>
        </div>
        {!compact && ((t.blocksCount || 0) > 0 || isOverdue) && (
          <div style={{ display: 'flex', gap: 8, marginTop: 2 }}>
            {(t.blocksCount || 0) > 0 && <span style={{ fontSize: 10, color: '#5F4B82', fontWeight: 500 }}>이거 끝나야 {t.blocksCount}개 진행</span>}
            {isOverdue && <span style={{ fontSize: 10, color: '#B84848', fontWeight: 500 }}>D+{Math.abs(dU(t.deadline))} 지연</span>}
          </div>
        )}
      </div>
    );
  };

  const overallPct = data.totalAll > 0 ? Math.round((data.totalDone / data.totalAll) * 100) : 0;
  const shipDate = MST.find(m => m.label === '출하 목표');
  const daysLeft = shipDate ? dU(shipDate.date) : null;

  return (
    <div style={{ margin: '0 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ─── OVERALL PROGRESS ─── */}
      <div style={{ background: '#FAF6EF', border: '1px solid #DDD3C2', borderRadius: 2, padding: '12px 16px' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginBottom: 6 }}>
          <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 11, letterSpacing: '.2em', color: '#5F4B82' }}>OUR GOAL</span>
          {daysLeft != null && (
            <span style={{ marginLeft: 'auto', fontFamily: "'DM Serif Display',serif", fontSize: 14, color: daysLeft <= 7 ? '#B84848' : '#5F4B82' }}>
              {daysLeft <= 0 ? `D+${Math.abs(daysLeft)}` : `D-${daysLeft}`}
            </span>
          )}
        </div>
        <div style={{ fontSize: 14, fontWeight: 400, color: '#1A1613', marginBottom: 8 }}>{OKR.objective}</div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1, height: 6, background: '#E8DFCE', borderRadius: 100, overflow: 'hidden' }}>
            <div style={{ width: `${overallPct}%`, height: '100%', background: overallPct === 100 ? '#A8C496' : '#5F4B82', borderRadius: 100, transition: 'width .5s' }} />
          </div>
          <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 14, color: '#5F4B82', minWidth: 40, textAlign: 'right' }}>{overallPct}%</span>
          <span style={{ fontSize: 10, color: '#8A7D72' }}>{data.totalDone}/{data.totalAll}</span>
        </div>
      </div>

      {/* ─── PIPELINES ─── */}
      {data.pipes.map(pipe => {
        const isExpanded = expandedPipe.has(pipe.name);
        const pipePct = pipe.total > 0 ? Math.round((pipe.done / pipe.total) * 100) : 0;
        return (
          <div key={pipe.name} style={{ background: '#FAF6EF', border: '1px solid #DDD3C2', borderRadius: 2, overflow: 'hidden' }}>
            {/* Pipeline header */}
            <div style={{ padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 8 }}>
              <span style={{ fontSize: 16 }}>{pipe.emoji}</span>
              <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 13, color: '#1A1613' }}>{pipe.name}</span>
              <span style={{ fontSize: 10, color: '#8A7D72', fontStyle: 'italic', marginLeft: 'auto' }}>{pipePct}%</span>
            </div>

            {/* Step dots */}
            <div style={{ padding: '0 14px 8px', display: 'flex', alignItems: 'center', gap: 0 }}>
              {pipe.steps.map((step, i) => {
                const sc = stepColors[step.status];
                const prevDone = i === 0 || pipe.steps[i - 1].status === 'done';
                return (
                  <React.Fragment key={step.name}>
                    {i > 0 && (
                      <div style={{ flex: 1, height: 2, background: prevDone ? '#A8C496' : '#E8DFCE', minWidth: 8 }} />
                    )}
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 3, flexShrink: 0 }}>
                      <div style={{
                        width: 24, height: 24, borderRadius: '50%',
                        background: sc.bg, border: `2px solid ${sc.bd}`,
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        fontSize: 10, color: sc.tx, fontWeight: 600,
                        position: 'relative',
                      }}>
                        {step.status === 'done' ? '✓' : step.status === 'active' || step.status === 'overdue' ? '→' : ''}
                      </div>
                      <span style={{
                        fontSize: 9, color: step.status === 'done' ? '#A8C496' : step.status === 'active' ? '#5F4B82' : step.status === 'overdue' ? '#B84848' : '#AAA49C',
                        fontWeight: step.status === 'active' || step.status === 'overdue' ? 500 : 300,
                        whiteSpace: 'nowrap', maxWidth: 60, overflow: 'hidden', textOverflow: 'ellipsis',
                        textAlign: 'center',
                      }}>
                        {step.name}
                      </span>
                    </div>
                  </React.Fragment>
                );
              })}
            </div>

            {/* Top action for this pipeline */}
            {pipe.topActions.length > 0 && (
              <div style={{ padding: '0 10px 10px' }}>
                <div style={{ fontSize: 10, color: '#5F4B82', fontWeight: 500, marginBottom: 3, paddingLeft: 4 }}>→ 지금:</div>
                {renderActionCard(pipe.topActions[0])}
                {pipe.topActions.length > 1 && (
                  <button
                    onClick={() => togglePipe(pipe.name)}
                    style={{ background: 'transparent', border: 'none', padding: '4px 4px 0', fontSize: 10, color: '#5F4B82', cursor: 'pointer' }}
                  >
                    + {pipe.topActions.length - 1}개 더 {isExpanded ? '−' : '+'}
                  </button>
                )}
                {isExpanded && pipe.topActions.slice(1).map(t => (
                  <div key={t.id} style={{ marginTop: 2 }}>{renderActionCard(t, true)}</div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {/* ─── PERSON FOCUS — "지금 이거" per person ─── */}
      <div style={{ display: 'flex', gap: 6 }}>
        {OWNERS.filter(o => o !== '공동').map(owner => {
          const task = data.personFocus[owner];
          const oc = ownerColors[owner] || ownerColors['공동'];
          const myTotal = enriched.filter(t => t.owner === owner).length;
          const myOverdue = enriched.filter(t => t.owner === owner && t.deadline != null && t.deadline < todayDate).length;
          return (
            <div key={owner} style={{
              flex: 1, background: '#FAF6EF', borderRadius: 2, overflow: 'hidden',
              borderLeft: `3px solid ${oc.accent}`, border: '1px solid #E8DFCE',
            }}>
              <div style={{ padding: '6px 10px', display: 'flex', alignItems: 'center', gap: 6, borderBottom: task ? `1px solid #E8DFCE` : 'none' }}>
                <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 12, color: oc.accent }}>{owner}</span>
                <span style={{ fontSize: 10, color: '#8A7D72' }}>{myTotal}개</span>
                {myOverdue > 0 && <span style={{ fontSize: 10, color: '#B84848' }}>지연 {myOverdue}</span>}
              </div>
              {task ? (
                <div style={{ padding: '6px 8px' }}>
                  <div style={{ fontSize: 9, color: '#8A7D72', marginBottom: 2 }}>지금 이거:</div>
                  <div
                    onClick={() => onEdit(task.id)}
                    style={{ fontSize: 11, color: '#1A1613', cursor: 'pointer', lineHeight: 1.4 }}
                  >
                    {task.title}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 4 }}>
                    {task.deadline && (
                      <span
                        onClick={(e) => { e.stopPropagation(); onDateClick(task.id, e); }}
                        style={{
                          fontSize: 9, fontStyle: 'italic', cursor: 'pointer',
                          color: task.deadline < todayDate ? '#B84848' : '#8A7D72',
                        }}
                      >
                        {fD(task.deadline)}
                      </span>
                    )}
                    <span
                      onClick={(e) => { e.stopPropagation(); onCycleStatus(task.id); }}
                      style={{ ...S.stBadge, background: SC[task.status]?.bg, color: SC[task.status]?.tx, border: `1px solid ${SC[task.status]?.bd}`, cursor: 'pointer', fontSize: 8, padding: '1px 5px' }}
                    >
                      {SL[task.status]}
                    </span>
                    <span
                      onClick={(e) => { e.stopPropagation(); onMarkDone(task.id); }}
                      style={{ width: 16, height: 16, borderRadius: 2, border: '1.5px solid #A8C496', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 9, color: '#A8C496', marginLeft: 'auto' }}
                    >✓</span>
                  </div>
                </div>
              ) : (
                <div style={{ padding: '6px 10px', fontSize: 10, color: '#AAA49C', fontStyle: 'italic' }}>모두 완료</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// COLLAPSIBLE SECTION
// ═══════════════════════════════════════════════════
function CollapsibleSection({
  title, sectionKey, collapsed, onToggle, children,
}: {
  title: string;
  sectionKey: string;
  collapsed: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div style={{ ...S.section, marginBottom: 8 }}>
      <button onClick={onToggle} style={S.sectionHead}>
        <span style={S.sectionTitle}>{title}</span>
        <span style={S.sectionToggle}>{collapsed ? '펼치기 +' : '접기 -'}</span>
      </button>
      {!collapsed && <div style={S.sectionBody}>{children}</div>}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// WEEKLY GRID — simple week view Mon-Sun
// ═══════════════════════════════════════════════════
function WeeklyGrid({
  tasks, onEdit, onDateChange,
}: {
  tasks: AppTask[];
  onEdit: (id: string) => void;
  onDateChange: (taskId: string, newDate: string) => void;
}) {
  const weekDays = useMemo(() => getWeekDays(), []);
  const activeTasks = tasks.filter((t) => t.status !== 'done');
  const [dragOver, setDragOver] = useState<string | null>(null);
  const todayS = todayStr();

  // Group tasks by day
  const tasksByDay: Record<string, AppTask[]> = {};
  weekDays.forEach(d => { tasksByDay[d.str] = []; });
  activeTasks.forEach(t => {
    if (t.deadline) {
      const matchDay = weekDays.find(d => d.str === t.deadline);
      if (matchDay) {
        tasksByDay[matchDay.str].push(t);
      }
    }
  });

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', minWidth: 500, gap: 0 }}>
        {/* Header row */}
        {weekDays.map((d) => (
          <div
            key={d.str}
            style={{
              padding: '6px 4px',
              textAlign: 'center' as const,
              background: d.str === todayS ? '#EFEBFA' : '#FAF6EF',
              fontWeight: d.str === todayS ? 600 : 400,
              color: d.str === todayS ? '#5F4B82' : '#8A7D72',
              borderRight: '1px solid #E8DFCE',
              borderBottom: '1px solid #E8DFCE',
            }}
          >
            <div style={{ fontSize: 10 }}>{d.label}</div>
            <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 15 }}>{d.date.getDate()}</div>
          </div>
        ))}

        {/* Day columns content */}
        {weekDays.map((d) => {
          const dayTasks = tasksByDay[d.str] || [];
          const isOver = dragOver === d.str;
          return (
            <div
              key={`body-${d.str}`}
              style={{
                padding: '4px 3px',
                borderRight: '1px solid #E8DFCE',
                background: isOver ? '#EFEBFA' : d.str === todayS ? '#FDFBF7' : '#fff',
                minHeight: 60,
                display: 'flex', flexDirection: 'column', gap: 2,
              }}
              onDragOver={(e) => { e.preventDefault(); setDragOver(d.str); }}
              onDragLeave={() => setDragOver(null)}
              onDrop={(e) => {
                e.preventDefault();
                setDragOver(null);
                const taskId = e.dataTransfer.getData('text/plain');
                if (taskId) onDateChange(taskId, d.str);
              }}
            >
              {dayTasks.map((t) => {
                const oc = ownerColors[t.owner] || ownerColors['공동'];
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); }}
                    onClick={() => onEdit(t.id)}
                    style={{
                      fontSize: 10, padding: '3px 5px',
                      background: t.owner === '풍성' ? '#F3EEFA' : t.owner === '은채' ? '#FDF5ED' : '#F5F1EA',
                      borderLeft: `2px solid ${oc.accent}`,
                      borderRadius: 2, cursor: 'grab',
                      whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
                      color: '#1A1613',
                      lineHeight: 1.4,
                    }}
                    title={`${t.owner}: ${t.title}`}
                  >
                    <span style={{ fontSize: 8, color: oc.accent, fontWeight: 600, marginRight: 2 }}>
                      {t.owner === '풍성' ? '풍' : t.owner === '은채' ? '은' : '공'}
                    </span>
                    {t.priority === 'high' && <span style={{ color: '#B84848' }}>! </span>}
                    {t.title}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// PROJECT CARDS — sorted by most active
// ═══════════════════════════════════════════════════
function ProjectCards({
  projects, expandedProjects, onToggleExpand, onEdit, onCycleStatus, onMarkDone, onDateClick,
}: {
  projects: { name: string; category: string; items: AppTask[]; done: number; total: number; active: number; primaryOwner: string; isNew: boolean }[];
  expandedProjects: Set<string>;
  onToggleExpand: (name: string) => void;
  onEdit: (id: string) => void;
  onCycleStatus: (id: string) => void;
  onMarkDone: (id: string) => void;
  onDateClick: (id: string, e: React.MouseEvent) => void;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
      {projects.map((proj) => {
        const emoji = PROJECT_META[proj.name]?.emoji || catEmoji[proj.category] || '📌';
        const pct = proj.total > 0 ? Math.round((proj.done / proj.total) * 100) : 0;
        const oc = ownerColors[proj.primaryOwner] || ownerColors['공동'];
        const isExpanded = expandedProjects.has(proj.name);
        const c = CC[proj.category] || CC['기타'];

        return (
          <div key={proj.name} style={{ border: '1px solid #E8DFCE', borderRadius: 2, overflow: 'hidden' }}>
            {/* Compact project card */}
            <div
              onClick={() => onToggleExpand(proj.name)}
              style={{
                padding: '8px 12px',
                display: 'flex', alignItems: 'center', gap: 8,
                cursor: 'pointer',
                background: isExpanded ? '#FAF6EF' : '#fff',
                transition: 'background .15s',
              }}
            >
              <span style={{ fontSize: 14 }}>{emoji}</span>
              <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 13, flex: 1 }}>
                {proj.name}
                {PROJECT_META[proj.name]?.goal && (
                  <div style={{ fontSize: 10, color: '#8A7D72', fontStyle: 'italic', marginTop: 1 }}>
                    🎯 {PROJECT_META[proj.name].goal}
                  </div>
                )}
              </span>
              {proj.isNew && (
                <span style={{
                  fontSize: 8, padding: '1px 5px', borderRadius: 100,
                  background: '#EFEBFA', color: '#5F4B82', fontWeight: 600,
                  letterSpacing: '.05em',
                }}>
                  NEW
                </span>
              )}
              {/* Progress bar */}
              <div style={{ width: 60, height: 4, background: '#E8DFCE', borderRadius: 100, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: c.bd, borderRadius: 100, transition: 'width .5s ease' }} />
              </div>
              <span style={{ fontSize: 10, color: '#8A7D72', fontStyle: 'italic', minWidth: 28 }}>
                {proj.done}/{proj.total}
              </span>
              <span style={{
                fontSize: 9, padding: '1px 5px', borderRadius: 100,
                background: oc.bg, color: oc.accent, fontWeight: 500,
              }}>
                {proj.primaryOwner}
              </span>
              <span style={{ fontSize: 10, color: '#8A7D72', transform: isExpanded ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .15s' }}>
                →
              </span>
            </div>

            {/* Expanded task list */}
            {isExpanded && (
              <div style={{ padding: '4px 8px 8px', borderTop: '1px solid #E8DFCE', background: '#FDFBF7' }}>
                {proj.items
                  .sort((a, b) => {
                    // Active tasks first, then by deadline
                    if (a.status === 'done' && b.status !== 'done') return 1;
                    if (a.status !== 'done' && b.status === 'done') return -1;
                    return dU(a.deadline) - dU(b.deadline);
                  })
                  .map((t) => {
                    const isDone = t.status === 'done';
                    const tOc = ownerColors[t.owner] || ownerColors['공동'];
                    return (
                      <div
                        key={t.id}
                        style={{
                          display: 'flex', alignItems: 'center', gap: 6,
                          padding: '5px 8px', marginBottom: 2,
                          borderLeft: `2px solid ${isDone ? '#A8C49655' : c.bd}`,
                          borderRadius: 2, cursor: 'pointer',
                          opacity: isDone ? 0.5 : 1,
                          transition: 'all .1s',
                        }}
                        onClick={() => onEdit(t.id)}
                      >
                        {/* Status circle */}
                        <span
                          onClick={(e) => { e.stopPropagation(); onCycleStatus(t.id); }}
                          style={{
                            width: 12, height: 12, borderRadius: '50%',
                            border: `1.5px solid ${isDone ? '#A8C496' : SC[t.status]?.bd || '#DDD3C2'}`,
                            background: isDone ? '#A8C496' : 'transparent',
                            display: 'flex', alignItems: 'center', justifyContent: 'center',
                            cursor: 'pointer', fontSize: 7, color: '#fff', flexShrink: 0,
                          }}
                        >
                          {isDone ? '✓' : ''}
                        </span>
                        <span style={{
                          flex: 1, fontSize: 12,
                          textDecoration: isDone ? 'line-through' : 'none',
                          color: isDone ? '#8A7D72' : '#1A1613',
                        }}>
                          {t.title}
                        </span>
                        {t.deadline && (
                          <span
                            onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
                            style={{
                              fontSize: 10, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72',
                              fontStyle: 'italic', cursor: 'pointer',
                            }}
                          >
                            {fD(t.deadline)}
                          </span>
                        )}
                        <span style={{
                          fontSize: 9, padding: '1px 5px', borderRadius: 100,
                          background: tOc.bg, color: tOc.accent,
                        }}>
                          {t.owner}
                        </span>
                        {!isDone && (
                          <span
                            onClick={(e) => { e.stopPropagation(); onMarkDone(t.id); }}
                            style={{
                              width: 16, height: 16, borderRadius: 2,
                              border: '1.5px solid #A8C496', display: 'flex',
                              alignItems: 'center', justifyContent: 'center',
                              cursor: 'pointer', fontSize: 9, color: '#A8C496',
                              flexShrink: 0,
                            }}
                            title="완료"
                          >
                            ✓
                          </span>
                        )}
                      </div>
                    );
                  })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// INLINE DATE PICKER
// ═══════════════════════════════════════════════════
function DatePicker({
  task, pos, onClose, onDateChange,
}: {
  task: AppTask;
  pos: { top: number; left: number };
  onClose: () => void;
  onDateChange: (date: string) => void;
}) {
  const [month, setMonth] = useState(() => {
    const d = task.deadline ? new Date(task.deadline + 'T00:00:00') : new Date();
    return { year: d.getFullYear(), month: d.getMonth() };
  });

  const firstDay = new Date(month.year, month.month, 1);
  const startDay = firstDay.getDay();
  const daysInMonth = new Date(month.year, month.month + 1, 0).getDate();
  const todayS = todayStr();

  const cells: (string | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${month.year}-${String(month.month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    cells.push(dateStr);
  }

  const quickButtons = [
    { label: '+1일', fn: () => { if (task.deadline) { const d = new Date(task.deadline + 'T00:00:00'); d.setDate(d.getDate() + 1); onDateChange(d.toISOString().slice(0, 10)); } } },
    { label: '+3일', fn: () => { if (task.deadline) { const d = new Date(task.deadline + 'T00:00:00'); d.setDate(d.getDate() + 3); onDateChange(d.toISOString().slice(0, 10)); } } },
    { label: '+7일', fn: () => { if (task.deadline) { const d = new Date(task.deadline + 'T00:00:00'); d.setDate(d.getDate() + 7); onDateChange(d.toISOString().slice(0, 10)); } } },
    { label: '내일', fn: () => { const d = new Date(); d.setDate(d.getDate() + 1); onDateChange(d.toISOString().slice(0, 10)); } },
    { label: '이번주말', fn: () => {
      const d = new Date();
      const day = d.getDay();
      const diff = day === 0 ? 6 : 6 - day;
      d.setDate(d.getDate() + diff);
      onDateChange(d.toISOString().slice(0, 10));
    }},
  ];

  const popupTop = pos.top > window.innerHeight / 2 ? Math.max(10, pos.top - 320) : pos.top + 10;
  const popupLeft = Math.min(pos.left, window.innerWidth - 260);

  return (
    <div style={S.backdrop} onClick={onClose}>
      <div
        style={{
          position: 'fixed',
          top: popupTop,
          left: popupLeft,
          background: '#FAF6EF',
          border: '1px solid #DDD3C2',
          borderRadius: 2,
          padding: 12,
          width: 250,
          boxShadow: '0 8px 24px rgba(26,22,19,.15)',
          zIndex: 1010,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Quick buttons */}
        <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginBottom: 10 }}>
          {quickButtons.map((b) => (
            <button key={b.label} onClick={b.fn} style={S.dpQuick}>{b.label}</button>
          ))}
        </div>

        {/* Month nav */}
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
          <button onClick={() => setMonth((p) => p.month === 0 ? { year: p.year - 1, month: 11 } : { ...p, month: p.month - 1 })} style={S.dpNav}>&lt;</button>
          <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 13 }}>
            {month.year}.{month.month + 1}
          </span>
          <button onClick={() => setMonth((p) => p.month === 11 ? { year: p.year + 1, month: 0 } : { ...p, month: p.month + 1 })} style={S.dpNav}>&gt;</button>
        </div>

        {/* Day headers */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1, marginBottom: 4 }}>
          {['일', '월', '화', '수', '목', '금', '토'].map((d) => (
            <div key={d} style={{ textAlign: 'center', fontSize: 9, color: '#8A7D72', padding: 2 }}>{d}</div>
          ))}
        </div>

        {/* Days grid */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 1 }}>
          {cells.map((dateStr, i) => {
            if (!dateStr) return <div key={i} />;
            const dayNum = parseInt(dateStr.split('-')[2]);
            const isToday = dateStr === todayS;
            const isSelected = dateStr === task.deadline;
            return (
              <button
                key={dateStr}
                onClick={() => onDateChange(dateStr)}
                style={{
                  border: 'none',
                  background: isSelected ? '#5F4B82' : isToday ? '#EFEBFA' : 'transparent',
                  color: isSelected ? '#fff' : isToday ? '#5F4B82' : '#1A1613',
                  padding: '4px 0',
                  borderRadius: 2,
                  fontSize: 11,
                  cursor: 'pointer',
                  fontWeight: isToday ? 600 : 300,
                }}
              >
                {dayNum}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// BOARD VIEW (Kanban)
// ═══════════════════════════════════════════════════
function BoardView({
  tasks, selectMode, selectedIds, onSelect, onEdit, onCycleStatus, onCycleOwner, onCyclePriority, onMarkDone, onDateClick, dragId, dragCol, onDS, onDO, onDD, onDE,
}: {
  tasks: AppTask[];
  selectMode: boolean;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onCycleStatus: (id: string) => void;
  onCycleOwner: (id: string) => void;
  onCyclePriority: (id: string) => void;
  onMarkDone: (id: string) => void;
  onDateClick: (id: string, e: React.MouseEvent) => void;
  dragId: string | null;
  dragCol: string | null;
  onDS: (id: string) => void;
  onDO: (s: string) => (e: React.DragEvent) => void;
  onDD: (s: string) => () => void;
  onDE: () => void;
}) {
  const grouped: Record<string, AppTask[]> = {};
  STS.forEach((s) => { grouped[s] = []; });
  tasks.forEach((t) => { (grouped[t.status] || grouped.todo).push(t); });
  Object.values(grouped).forEach((a) =>
    a.sort((x, y) => {
      const pa = x.priority === 'high' ? 0 : 1;
      const pb = y.priority === 'high' ? 0 : 1;
      if (pa !== pb) return pa - pb;
      return dU(x.deadline) - dU(y.deadline);
    })
  );

  return (
    <div style={S.board}>
      {STS.map((st) => {
        const sc = SC[st];
        const items = grouped[st];
        const isO = dragCol === st;
        return (
          <div key={st} onDragOver={onDO(st)} onDrop={onDD(st)} style={{ ...S.col, background: isO ? sc.bg : '#fff', borderColor: isO ? sc.bd : '#E8DFCE' }}>
            <div style={{ ...S.colH, background: sc.bg, borderBottomColor: sc.bd + '55' }}>
              <span style={{ color: sc.tx, fontFamily: "'DM Serif Display',serif", fontSize: 13 }}>{SL[st]}</span>
              <span style={{ color: sc.tx, fontFamily: "'DM Serif Display',serif", fontSize: 18 }}>{items.length}</span>
            </div>
            <div style={S.colB}>
              {items.map((t) => {
                const c = CC[t.category] || CC['기타'];
                return (
                  <div
                    key={t.id}
                    draggable
                    onDragStart={() => onDS(t.id)}
                    onDragEnd={onDE}
                    onClick={() => selectMode ? onSelect(t.id) : onEdit(t.id)}
                    style={{
                      ...S.card,
                      borderLeftColor: c.bd,
                      opacity: dragId === t.id ? 0.35 : t.status === 'done' ? 0.5 : 1,
                      cursor: 'grab',
                      outline: selectedIds.has(t.id) ? '2px solid #5F4B82' : 'none',
                    }}
                  >
                    <div style={S.cTop}>
                      {selectMode && (
                        <span style={{ ...S.pChk, width: 14, height: 14, background: selectedIds.has(t.id) ? '#5F4B82' : 'transparent', borderColor: selectedIds.has(t.id) ? '#5F4B82' : '#DDD3C2', color: '#fff', fontSize: 8 }}>
                          {selectedIds.has(t.id) ? '✓' : ''}
                        </span>
                      )}
                      <span style={{ ...S.catB, background: c.bg, color: c.tx }}>{t.category}</span>
                      <span
                        onClick={(e) => { e.stopPropagation(); onCyclePriority(t.id); }}
                        style={{ fontSize: 9, cursor: 'pointer' }}
                      >
                        {t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🔵' : '⚪'}
                      </span>
                      <span
                        onClick={(e) => { e.stopPropagation(); onCycleOwner(t.id); }}
                        style={{
                          ...S.ownB, marginLeft: 'auto', cursor: 'pointer',
                          background: ownerColors[t.owner]?.bg || ownerColors['공동'].bg,
                          color: ownerColors[t.owner]?.accent || ownerColors['공동'].accent,
                        }}
                      >
                        {t.owner}
                      </span>
                    </div>
                    <div style={{ ...S.cTitle, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</div>
                    <div style={S.cBot}>
                      {t.deadline ? (
                        <span
                          onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
                          style={{ ...S.cDate, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72', cursor: 'pointer' }}
                        >
                          {fD(t.deadline)}
                        </span>
                      ) : (
                        <span
                          onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
                          style={{ fontSize: 10, color: '#CCBFA8', cursor: 'pointer' }}
                        >
                          +날짜
                        </span>
                      )}
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 'auto' }}>
                        <span
                          onClick={(e) => { e.stopPropagation(); onCycleStatus(t.id); }}
                          style={{ ...S.stBadge, background: SC[t.status]?.bg, color: SC[t.status]?.tx, border: `1px solid ${SC[t.status]?.bd}`, cursor: 'pointer' }}
                        >
                          {SL[t.status]}
                        </span>
                        {t.status !== 'done' && (
                          <span
                            onClick={(e) => { e.stopPropagation(); onMarkDone(t.id); }}
                            style={{ width: 16, height: 16, borderRadius: 2, border: '1.5px solid #A8C496', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 9, color: '#A8C496' }}
                            title="완료"
                          >✓</span>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {!items.length && <div style={S.empty}>--</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// EDITOR MODAL
// ═══════════════════════════════════════════════════
function Editor({
  task, onClose, onSave, onDelete, allTasks,
}: {
  task?: AppTask;
  onClose: () => void;
  onSave: (t: Partial<AppTask>) => void;
  onDelete?: () => void;
  allTasks: AppTask[];
}) {
  const projectsList = [...new Set(allTasks.map((t) => t.project).filter(Boolean))];
  const [f, setF] = useState({
    title: task?.title || '',
    category: task?.category || '기타',
    project: task?.project || '',
    owner: task?.owner || '공동',
    deadline: task?.deadline || '',
    status: task?.status || 'todo',
    note: task?.note || '',
    priority: task?.priority || 'medium',
  });
  const s = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));
  const save = () => {
    if (!f.title.trim()) return;
    onSave({ ...f, title: f.title.trim(), deadline: f.deadline || null });
  };

  return (
    <div style={S.backdrop} onClick={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.mHead}>
          <h2 style={S.mTitle}>{task ? '수정' : '새 할 일'}</h2>
          <button onClick={onClose} style={S.mClose}>x</button>
        </div>
        <div style={S.mBody}>
          <label style={S.label}>제목</label>
          <input value={f.title} onChange={(e) => s('title', e.target.value)} style={S.input} autoFocus />
          <div style={S.r2}>
            <div style={S.field}>
              <label style={S.label}>카테고리</label>
              <select value={f.category} onChange={(e) => s('category', e.target.value)} style={S.input}>
                {CATS.map((c) => <option key={c}>{c}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>프로젝트</label>
              <input list="proj-list" value={f.project} onChange={(e) => s('project', e.target.value)} style={S.input} placeholder="예: 샘플링" />
              <datalist id="proj-list">{projectsList.map((p) => <option key={p!} value={p!} />)}</datalist>
            </div>
          </div>
          <div style={S.r2}>
            <div style={S.field}>
              <label style={S.label}>담당</label>
              <select value={f.owner} onChange={(e) => s('owner', e.target.value)} style={S.input}>
                {OWNERS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>마감일</label>
              <input type="date" value={f.deadline} onChange={(e) => s('deadline', e.target.value)} style={S.input} />
            </div>
          </div>
          <div style={S.r2}>
            <div style={S.field}>
              <label style={S.label}>우선순위</label>
              <select value={f.priority} onChange={(e) => s('priority', e.target.value)} style={S.input}>
                <option value="high">높음</option>
                <option value="medium">중간</option>
                <option value="low">낮음</option>
              </select>
            </div>
            <div style={S.field}>
              <label style={S.label}>상태</label>
              <select value={f.status} onChange={(e) => s('status', e.target.value)} style={S.input}>
                {STS.map((st) => <option key={st} value={st}>{SL[st]}</option>)}
              </select>
            </div>
          </div>
          <label style={S.label}>메모</label>
          <textarea value={f.note} onChange={(e) => s('note', e.target.value)} style={{ ...S.input, minHeight: 50, resize: 'vertical' }} />
        </div>
        <div style={S.mFoot}>
          {onDelete && <button onClick={onDelete} style={S.delBtn}>삭제</button>}
          <div style={{ flex: 1 }} />
          <button onClick={onClose} style={S.canBtn}>취소</button>
          <button onClick={save} style={S.savBtn}>저장</button>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// STYLES
// ═══════════════════════════════════════════════════
const CSS = `
@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans+KR:wght@300;400;500;600&display=swap');
*{box-sizing:border-box;margin:0}
button,select{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
@keyframes flashGreen{0%{background:#EBF3E6}50%{background:#A8C496}100%{background:#EBF3E6}}
@media(max-width:767px){
  .board-grid{grid-template-columns:1fr !important}
}
`;

const S: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh', background: '#F5F1EA', fontFamily: "'IBM Plex Sans KR',sans-serif",
    fontWeight: 300, color: '#1A1613', maxWidth: 800, margin: '0 auto',
    display: 'flex', flexDirection: 'column', gap: 8,
    paddingBottom: 80,
  },
  // Header
  header: {
    position: 'sticky', top: 0, zIndex: 100,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8,
    padding: '10px 14px',
    background: '#F5F1EA', borderBottom: '1px solid #DDD3C2',
  },
  hL: { display: 'flex', alignItems: 'center', gap: 8 },
  hR: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  brand: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 5, height: 5, borderRadius: '50%', background: '#5F4B82', display: 'inline-block' },
  bTxt: { fontFamily: "'DM Serif Display',serif", fontSize: 11, letterSpacing: '.3em', color: '#4A3F38' },
  ms: { background: '#FAF6EF', border: '1px solid', padding: '4px 10px', borderRadius: 2, textAlign: 'right' as const, minWidth: 76 },
  msL: { fontFamily: "'DM Serif Display',serif", fontSize: 8, letterSpacing: '.1em', color: '#8A7D72', textTransform: 'uppercase' as const },
  msD: { fontFamily: "'DM Serif Display',serif", fontSize: 15, fontWeight: 400, lineHeight: 1.2 },
  msDt: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 9, color: '#8A7D72' },
  // Command bar
  cmdBar: {
    position: 'sticky', top: 47, zIndex: 99,
    display: 'flex', gap: 6, alignItems: 'flex-start',
    padding: '8px 14px',
    background: '#F5F1EA', borderBottom: '1px solid #E8DFCE',
    flexDirection: 'column',
  },
  cmdInput: {
    flex: 1, padding: '8px 12px', background: '#fff', border: '1px solid #DDD3C2', borderRadius: 2,
    fontSize: 13, color: '#1A1613', outline: 'none', fontWeight: 300, fontFamily: "'IBM Plex Sans KR',sans-serif",
    minWidth: 200,
  },
  cmdAddBtn: {
    padding: '8px 14px', background: '#1A1613', color: '#FAF6EF',
    border: 'none', borderRadius: 2, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
  },
  // Filters
  filterBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    padding: '0 14px',
  },
  filters: { display: 'flex', gap: 4 },
  sel: { padding: '4px 6px', border: '1px solid #DDD3C2', borderRadius: 2, background: '#FAF6EF', fontSize: 10, color: '#4A3F38' },
  toolBtn: {
    padding: '4px 10px', background: '#FAF6EF', border: '1px solid #A896C4', borderRadius: 2,
    color: '#5F4B82', fontSize: 10, fontWeight: 500, whiteSpace: 'nowrap',
  },
  // Stats
  stats: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, padding: '0 14px' },
  st: { background: '#FAF6EF', padding: '6px 10px', borderRadius: 2, borderLeft: '3px solid', display: 'flex', alignItems: 'baseline', gap: 4 },
  stN: { fontFamily: "'DM Serif Display',serif", fontSize: 'clamp(16px,3vw,22px)', lineHeight: 1 },
  stL: { fontSize: 9, color: '#8A7D72' },
  // Collapsible sections
  section: { border: '1px solid #E8DFCE', borderRadius: 2, overflow: 'hidden', margin: '0 14px' },
  sectionHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
    padding: '8px 14px', background: '#FAF6EF', border: 'none', borderBottom: '1px solid #E8DFCE',
    cursor: 'pointer', fontFamily: "'IBM Plex Sans KR',sans-serif",
  },
  sectionTitle: { fontFamily: "'DM Serif Display',serif", fontSize: 13, color: '#1A1613' },
  sectionToggle: { fontSize: 10, color: '#8A7D72' },
  sectionBody: { padding: 8 },
  // Cards
  card: {
    padding: '8px 10px', background: '#FAF6EF', borderLeft: '3px solid #DDD3C2', borderRadius: 2,
    cursor: 'pointer', transition: 'all .15s', animation: 'fadeUp .3s ease-out', userSelect: 'none',
  },
  cTop: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, flexWrap: 'wrap' },
  catB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, letterSpacing: '.03em', whiteSpace: 'nowrap' },
  ownB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, whiteSpace: 'nowrap' },
  cTitle: { fontSize: 12, fontWeight: 400, lineHeight: 1.4, marginBottom: 2 },
  cBot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 },
  cDate: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 10 },
  stBadge: { fontSize: 9, padding: '2px 7px', borderRadius: 100, fontWeight: 500 },
  // Board
  board: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 6 },
  col: { border: '1px solid', borderRadius: 2, minHeight: 120, display: 'flex', flexDirection: 'column', transition: 'all .2s' },
  colH: { padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid' },
  colB: { padding: 5, display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minHeight: 40 },
  empty: { textAlign: 'center' as const, padding: '12px 0', color: '#CCBFA8', fontStyle: 'italic', fontSize: 11 },
  // Batch bar
  batchBar: {
    position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 200,
    display: 'flex', alignItems: 'center', gap: 6, padding: '10px 14px',
    background: '#1A1613', color: '#FAF6EF',
    justifyContent: 'center', flexWrap: 'wrap',
  },
  batchLabel: { fontSize: 12, fontWeight: 500, marginRight: 4 },
  batchBtn: { padding: '5px 10px', background: '#FAF6EF', color: '#1A1613', border: 'none', borderRadius: 2, fontSize: 11, fontWeight: 500 },
  batchSel: { padding: '5px 8px', background: '#FAF6EF', color: '#1A1613', border: 'none', borderRadius: 2, fontSize: 11 },
  // Date picker
  dpQuick: { padding: '3px 8px', background: '#EFEBFA', color: '#5F4B82', border: '1px solid #A896C4', borderRadius: 2, fontSize: 10, fontWeight: 500 },
  dpNav: { background: 'transparent', border: '1px solid #DDD3C2', borderRadius: 2, padding: '2px 8px', color: '#4A3F38', fontSize: 13 },
  // Modal
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(26,22,19,.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 14 },
  modal: { background: '#FAF6EF', borderRadius: 2, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto', border: '1px solid #DDD3C2', boxShadow: '0 20px 60px rgba(26,22,19,.2)' },
  mHead: { padding: '12px 16px 8px', borderBottom: '1px solid #EFE7D6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  mTitle: { fontFamily: "'DM Serif Display',serif", fontWeight: 400, fontSize: 17, margin: 0 },
  mClose: { background: 'transparent', border: 'none', fontSize: 20, color: '#8A7D72', padding: 0 },
  mBody: { padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#8A7D72' },
  input: { padding: '7px 10px', background: '#fff', border: '1px solid #DDD3C2', borderRadius: 2, fontSize: 13, color: '#1A1613', outline: 'none', fontWeight: 300, width: '100%' },
  r2: { display: 'flex', gap: 8 },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  mFoot: { padding: '8px 16px 12px', borderTop: '1px solid #EFE7D6', display: 'flex', gap: 8, alignItems: 'center' },
  delBtn: { padding: '6px 12px', background: 'transparent', border: '1px solid #D4A4A4', color: '#B84848', borderRadius: 2, fontSize: 11 },
  canBtn: { padding: '6px 14px', background: 'transparent', border: '1px solid #DDD3C2', color: '#8A7D72', borderRadius: 2, fontSize: 11 },
  savBtn: { padding: '6px 18px', background: '#1A1613', border: 'none', color: '#FAF6EF', borderRadius: 2, fontSize: 12, fontWeight: 500 },
  confirmBtn: { padding: '10px 20px', background: '#5F4B82', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 13, fontWeight: 500, width: '100%', marginTop: 8 },
  pChk: { width: 16, height: 16, borderRadius: 2, border: '1.5px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0, marginTop: 1 },
  footer: { padding: '12px 14px', borderTop: '1px solid #DDD3C2', display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#8A7D72', marginTop: 'auto' },
  fLink: { background: 'transparent', border: 'none', fontSize: 10, color: '#B84848', textDecoration: 'underline', padding: 0, fontFamily: 'inherit', fontStyle: 'italic' },
};
