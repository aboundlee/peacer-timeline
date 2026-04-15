'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, dbToApp, appToDb } from '@/lib/supabase';
import { CATS, CC, STS, SL, SC, OWNERS, MST, OKR, PROJECT_META, TRACKS, CUSTOMER_GOAL, dU, fD, uid, type Phase } from '@/lib/constants';
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
  const [ownerPickerId, setOwnerPickerId] = useState<string | null>(null);
  const [ownerPickerPos, setOwnerPickerPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [addingNew, setAddingNew] = useState<Partial<AppTask> | null>(null);
  const [customerCount, setCustomerCount] = useState(0);
  const [cascadeConfirm, setCascadeConfirm] = useState<{ taskId: string; newDate: string; oldDate: string; downstream: AppTask[]; diffDays: number } | null>(null);
  const [undoStack, setUndoStack] = useState<{ id: string; prev: Partial<AppTask>; label: string; at: number }[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; undoAction?: () => void } | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cmdRef = useRef<HTMLInputElement>(null);
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(new Set());
  const [unlocked, setUnlocked] = useState<boolean | null>(null);
  const [passInput, setPassInput] = useState('');
  const [passError, setPassError] = useState(false);

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
    setUndoStack((stack) => [...stack.slice(-49), { id, prev, label, at: Date.now() }]);
    up(id, updates);
  };

  // Restore to a specific history point (by index). Applies that entry's prev snapshot
  // and removes it + everything after from the stack.
  const restoreFromHistory = useCallback((idx: number) => {
    const entry = undoStack[idx];
    if (!entry) return;
    setUndoStack((stack) => stack.slice(0, idx));
    up(entry.id, entry.prev);
    showToast(`되돌림: ${entry.label}`);
  }, [undoStack, showToast]);

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

  // Passcode gate — first-entry only
  useEffect(() => {
    try {
      setUnlocked(localStorage.getItem('peacer-unlocked') === '1');
    } catch {
      setUnlocked(true);
    }
  }, []);

  // Customer count (persisted locally — no DB schema yet)
  useEffect(() => {
    try {
      const v = localStorage.getItem('peacer-customer-count');
      if (v) setCustomerCount(parseInt(v) || 0);
    } catch { /* ignore */ }
  }, []);
  const updateCustomerCount = (n: number) => {
    setCustomerCount(n);
    try { localStorage.setItem('peacer-customer-count', String(n)); } catch { /* ignore */ }
  };

  const tryUnlock = () => {
    if (passInput === '5317') {
      try { localStorage.setItem('peacer-unlocked', '1'); } catch { /* ignore */ }
      setUnlocked(true);
      setPassError(false);
    } else {
      setPassError(true);
    }
  };

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

  // ─── Status change ───
  const changeStatus = (id: string, newStatus: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.status === newStatus) return;
    upWithUndo(id, { status: newStatus as AppTask['status'] }, `"${task.title}" ${SL[task.status]} → ${SL[newStatus]}`);
    showToast(`${SL[newStatus]}으로 변경: ${task.title}`);
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

  const setOwner = (id: string, owner: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task || task.owner === owner) return;
    upWithUndo(id, { owner }, `"${task.title}" 담당 ${task.owner} → ${owner}`);
  };

  const openOwnerPicker = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setOwnerPickerId(id);
    setOwnerPickerPos({ top: e.clientY, left: e.clientX });
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

  // ─── Passcode gate (first entry only) ───
  if (unlocked === null) return null;
  if (!unlocked) {
    return (
      <div style={{
        minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: '#FAFAF8', padding: 20,
      }}>
        <div style={{
          background: '#FFFFFF', border: '1px solid #E5E8EB', borderRadius: 12,
          padding: '28px 24px', width: '100%', maxWidth: 320,
          boxShadow: '0 1px 3px rgba(0,0,0,0.04)',
        }}>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#191F28', marginBottom: 4, letterSpacing: '-0.01em' }}>
            PEACER
          </div>
          <div style={{ fontSize: 12, color: '#8B95A1', marginBottom: 18 }}>
            보안을 위해 코드를 입력해주세요
          </div>
          <input
            type="password"
            inputMode="numeric"
            autoFocus
            value={passInput}
            onChange={(e) => { setPassInput(e.target.value); setPassError(false); }}
            onKeyDown={(e) => { if (e.key === 'Enter') tryUnlock(); }}
            placeholder="코드"
            style={{
              width: '100%', fontSize: 14, padding: '10px 12px',
              background: '#FFFFFF',
              border: `1px solid ${passError ? '#F04452' : '#E5E8EB'}`,
              borderRadius: 8, outline: 'none', color: '#191F28',
              fontFamily: 'inherit', letterSpacing: '0.1em',
              boxSizing: 'border-box',
            }}
          />
          {passError && (
            <div style={{ fontSize: 11, color: '#F04452', marginTop: 6 }}>
              코드가 일치하지 않아요
            </div>
          )}
          <button
            onClick={tryUnlock}
            disabled={!passInput.trim()}
            style={{
              width: '100%', fontSize: 13, fontWeight: 600, padding: '10px 0', marginTop: 12,
              background: passInput.trim() ? '#3182F6' : '#E5E8EB',
              color: passInput.trim() ? '#FFFFFF' : '#8B95A1',
              border: 'none', borderRadius: 8,
              cursor: passInput.trim() ? 'pointer' : 'not-allowed',
            }}
          >열기</button>
        </div>
      </div>
    );
  }

  // ─── Loading state ───
  if (!loaded) {
    return (
      <div style={{ ...S.root, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontSize: 24, marginBottom: 8 }}>PEACER</div>
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
          <button
            onClick={() => setHistoryOpen(true)}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 12px', borderRadius: 100,
              background: '#F2F4F6', border: 'none', cursor: 'pointer',
              fontSize: 12, fontWeight: 500, color: '#4E5968',
            }}
            title="수정 내역"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
              <path d="M7 3.5v3.5l2 1.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
              <path d="M2 7a5 5 0 1 0 1.5-3.5M2 3v2h2" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
            내역
          </button>
        </div>
      </header>

      {/* ─── MAIN DASHBOARD ─── */}
      <DashboardView
        tasks={tasks}
        enriched={enriched}
        todayDate={todayDate}
        onEdit={setEditId}
        onChangeStatus={changeStatus}
        onMarkDone={markDone}
        onDateClick={(id, e) => { setDatePickerId(id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
        onCycleOwner={cycleOwner}
        onOwnerPick={openOwnerPicker}
        onAddNew={(preset) => setAddingNew(preset || {})}
        customerCount={customerCount}
        onUpdateCustomerCount={updateCustomerCount}
      />

      {/* ─── SECTION: 이번 주 ─── */}
      <CollapsibleSection
        title="이번 주"
        sectionKey="weekly"
        collapsed={!!collapsed.weekly}
        onToggle={() => toggleCollapse('weekly')}
      >
        <WeeklyGrid tasks={tasks} onEdit={setEditId} onDateChange={handleDateChange} />
      </CollapsibleSection>

      {/* ─── SECTION: 전체 보기 (칸반) — done tasks hidden ─── */}
      <CollapsibleSection
        title="전체 보기"
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
          tasks={filtered.filter(t => t.status !== 'done')}
          selectMode={selectMode} selectedIds={selectedIds}
          onSelect={toggleSelect}
          onEdit={setEditId}
          onChangeStatus={changeStatus}
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

      {/* ─── OWNER PICKER POPUP ─── */}
      {ownerPickerId && (
        <OwnerPicker
          currentOwner={tasks.find((t) => t.id === ownerPickerId)?.owner || ''}
          pos={ownerPickerPos}
          onClose={() => setOwnerPickerId(null)}
          onPick={(owner) => { setOwner(ownerPickerId, owner); setOwnerPickerId(null); }}
        />
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

      {/* ─── ADD-NEW MODAL ─── */}
      {addingNew && (
        <Editor
          initialValues={addingNew}
          onClose={() => setAddingNew(null)}
          onSave={(t) => { add(t); setAddingNew(null); }}
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

      {/* ═══ HISTORY DRAWER ═══ */}
      {historyOpen && (
        <>
          <div
            onClick={() => setHistoryOpen(false)}
            style={{
              position: 'fixed', inset: 0, background: 'rgba(0,0,0,.24)', zIndex: 2500,
              animation: 'fadeUp .15s ease-out',
            }}
          />
          <div style={{
            position: 'fixed', top: 0, right: 0, bottom: 0, width: 360, maxWidth: '92vw',
            background: '#FFFFFF', zIndex: 2600,
            display: 'flex', flexDirection: 'column',
            boxShadow: '-4px 0 24px rgba(0,0,0,.08)',
          }}>
            <div style={{
              padding: '20px 20px 14px', borderBottom: '1px solid #F2F4F6',
              display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            }}>
              <div>
                <div style={{ fontSize: 17, fontWeight: 700, color: '#191F28', letterSpacing: '-0.01em' }}>수정 내역</div>
                <div style={{ fontSize: 12, color: '#8B95A1', marginTop: 2 }}>
                  {undoStack.length === 0 ? '기록 없음' : `최근 ${undoStack.length}건`}
                </div>
              </div>
              <button
                onClick={() => setHistoryOpen(false)}
                style={{
                  width: 32, height: 32, borderRadius: '50%', border: 'none',
                  background: '#F2F4F6', cursor: 'pointer', display: 'flex',
                  alignItems: 'center', justifyContent: 'center',
                  fontSize: 16, color: '#4E5968',
                }}
              >✕</button>
            </div>
            <div style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
              {undoStack.length === 0 ? (
                <div style={{ padding: 40, textAlign: 'center', color: '#8B95A1', fontSize: 13 }}>
                  아직 수정한 내역이 없어요
                </div>
              ) : (
                undoStack.slice().reverse().map((entry, revIdx) => {
                  const idx = undoStack.length - 1 - revIdx;
                  const task = tasks.find(t => t.id === entry.id);
                  const elapsed = Math.floor((Date.now() - entry.at) / 1000);
                  const timeLabel = elapsed < 60 ? '방금' : elapsed < 3600 ? `${Math.floor(elapsed / 60)}분 전` : elapsed < 86400 ? `${Math.floor(elapsed / 3600)}시간 전` : `${Math.floor(elapsed / 86400)}일 전`;
                  return (
                    <div key={idx} style={{
                      padding: '12px 20px',
                      display: 'flex', alignItems: 'flex-start', gap: 10,
                      borderBottom: '1px solid #F8F9FA',
                    }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, color: '#191F28', fontWeight: 500, lineHeight: 1.4 }}>
                          {entry.label}
                        </div>
                        <div style={{ fontSize: 11, color: '#8B95A1', marginTop: 3 }}>
                          {timeLabel}{task ? '' : ' · 삭제된 항목'}
                        </div>
                      </div>
                      {task && (
                        <button
                          onClick={() => restoreFromHistory(idx)}
                          style={{
                            padding: '5px 10px', borderRadius: 6,
                            background: '#F2F4F6', border: 'none', cursor: 'pointer',
                            fontSize: 11, fontWeight: 600, color: '#3182F6',
                            whiteSpace: 'nowrap',
                          }}
                        >
                          되돌리기
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </div>
        </>
      )}

      <footer style={S.footer}>
        <span>PEACER</span>
        <button onClick={() => { if (confirm('새로고침?')) fetchTasks(); }} style={S.fLink}>새로고침</button>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>v10</span>
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// DASHBOARD VIEW — Goal + Blocker + Checklist + Today
// "3초에 모든 걸 파악하는" 대시보드
// ═══════════════════════════════════════════════════
function DashboardView({
  tasks, enriched, todayDate,
  onEdit, onChangeStatus, onMarkDone, onDateClick, onCycleOwner, onOwnerPick, onAddNew,
  customerCount, onUpdateCustomerCount,
}: {
  tasks: AppTask[];
  enriched: AppTask[];
  todayDate: string;
  onEdit: (id: string) => void;
  onChangeStatus: (id: string, newStatus: string) => void;
  onMarkDone: (id: string) => void;
  onDateClick: (id: string, e: React.MouseEvent) => void;
  onCycleOwner: (id: string) => void;
  onOwnerPick: (id: string, e: React.MouseEvent) => void;
  onAddNew: (preset?: Partial<AppTask>) => void;
  customerCount: number;
  onUpdateCustomerCount: (n: number) => void;
}) {
  void onCycleOwner;
  const [openTracks, setOpenTracks] = useState<Set<string>>(() => new Set(['제품', '운영', '마케팅']));
  const [openPhases, setOpenPhases] = useState<Set<string>>(new Set());
  const [extraPhases, setExtraPhases] = useState<Record<string, Phase[]>>({});

  useEffect(() => {
    try {
      const raw = localStorage.getItem('peacer-extra-phases');
      if (raw) setExtraPhases(JSON.parse(raw));
    } catch {}
  }, []);

  const addExtraPhase = (trackName: string, phaseName: string) => {
    setExtraPhases(prev => {
      const list = prev[trackName] || [];
      if (list.some(p => p.name === phaseName)) return prev;
      const next = { ...prev, [trackName]: [...list, { name: phaseName, projects: [phaseName] }] };
      try { localStorage.setItem('peacer-extra-phases', JSON.stringify(next)); } catch {}
      return next;
    });
  };

  const mergedTracks = useMemo(() =>
    TRACKS.map(t => ({ ...t, phases: [...t.phases, ...(extraPhases[t.name] || [])] })),
    [extraPhases]
  );

  const handleEditCustomerCount = () => {
    const v = window.prompt('현재 고객 수', String(customerCount));
    if (v == null) return;
    const n = parseInt(v);
    if (Number.isFinite(n) && n >= 0) onUpdateCustomerCount(n);
  };

  const toggleTrack = (name: string) => {
    setOpenTracks(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };
  const togglePhase = (name: string) => {
    setOpenPhases(prev => { const n = new Set(prev); if (n.has(name)) n.delete(name); else n.add(name); return n; });
  };

  const data = useMemo(() => {
    // Group tasks by project field
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

    // Phase-level status computation
    type PhaseStatus = {
      name: string;
      done: number; total: number;
      status: 'done' | 'active' | 'overdue' | 'blocked' | 'todo';
      statusLabel: string;
      tasks: AppTask[];
      target: string | null;
    };

    const getPhaseStatus = (phase: Phase): PhaseStatus => {
      const all = phase.projects.flatMap(p => byProjectAll[p] || []);
      const doneCount = all.filter(t => t.status === 'done').length;
      const total = all.length;
      const hasOverdue = all.some(t => t.deadline && t.status !== 'done' && dU(t.deadline) < 0);
      const allDone = total > 0 && doneCount === total;
      const hasInProgress = all.some(t => t.status === 'doing' || t.status === 'waiting');

      let status: PhaseStatus['status'] = 'todo';
      let statusLabel = '미시작';
      if (allDone) { status = 'done'; statusLabel = '완료'; }
      else if (hasOverdue) { status = 'overdue'; statusLabel = '지연'; }
      else if (hasInProgress || doneCount > 0) { status = 'active'; statusLabel = '진행중'; }

      // Sort tasks: active first by deadline, then done
      const sorted = all.sort((a, b) => {
        if (a.status === 'done' && b.status !== 'done') return 1;
        if (a.status !== 'done' && b.status === 'done') return -1;
        return dU(a.deadline) - dU(b.deadline);
      });

      return { name: phase.name, done: doneCount, total, status, statusLabel, tasks: sorted, target: phase.target || null };
    };

    // Build track data with phases
    type TrackData = {
      name: string; emoji: string; goal: string; target: string | null;
      done: number; total: number;
      phases: PhaseStatus[];
      hasOverdue: boolean;
      weeklyDone: number;
    };

    const sevenDaysAgo = new Date();
    sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

    const trackData: TrackData[] = mergedTracks.map(track => {
      const phases = track.phases
        .map(getPhaseStatus)
        .filter(p => p.total > 0);
      const done = phases.reduce((s, p) => s + p.done, 0);
      const total = phases.reduce((s, p) => s + p.total, 0);
      const hasOverdue = phases.some(p => p.status === 'overdue');
      // Weekly velocity per track
      const trackProjects = new Set(track.phases.flatMap(p => p.projects));
      const weeklyDone = tasks.filter(t =>
        trackProjects.has(t.project || '') && t.status === 'done' && t.updated_at &&
        new Date(t.updated_at) > sevenDaysAgo
      ).length;
      return { name: track.name, emoji: track.emoji, goal: track.goal, target: track.target || null, done, total, phases, hasOverdue, weeklyDone };
    });

    // Uncategorized tasks (not in any track's phases)
    const trackedProjects = new Set(mergedTracks.flatMap(t => t.phases.flatMap(p => p.projects)));
    const uncatTasks = tasks.filter(t => {
      const p = t.project || '기타';
      return !trackedProjects.has(p);
    });
    const uncatDone = uncatTasks.filter(t => t.status === 'done').length;

    // Overall stats
    const totalDone = tasks.filter(t => t.status === 'done').length;
    const totalAll = tasks.length;

    // Pace prediction
    const recentDone = tasks.filter(t =>
      t.status === 'done' && t.updated_at &&
      new Date(t.updated_at) > sevenDaysAgo
    ).length;

    // Yesterday completed (by owner)
    const now = new Date();
    const yesterdayStart = new Date(now);
    yesterdayStart.setDate(now.getDate() - 1);
    yesterdayStart.setHours(0, 0, 0, 0);
    const todayStart = new Date(now);
    todayStart.setHours(0, 0, 0, 0);
    const yesterdayDoneTasks = tasks.filter(t => {
      if (t.status !== 'done' || !t.updated_at) return false;
      const u = new Date(t.updated_at);
      return u >= yesterdayStart && u < todayStart;
    });
    const yesterdayDone = yesterdayDoneTasks.length;
    const yesterdayByOwner: Record<string, number> = {};
    yesterdayDoneTasks.forEach(t => {
      yesterdayByOwner[t.owner] = (yesterdayByOwner[t.owner] || 0) + 1;
    });

    // This week (Mon-Sun) vs last week
    const day = now.getDay();
    const mondayOffset = day === 0 ? 6 : day - 1;
    const weekStart = new Date(now);
    weekStart.setDate(now.getDate() - mondayOffset);
    weekStart.setHours(0, 0, 0, 0);
    const lastWeekStart = new Date(weekStart);
    lastWeekStart.setDate(weekStart.getDate() - 7);
    const thisWeekDone = tasks.filter(t => {
      if (t.status !== 'done' || !t.updated_at) return false;
      return new Date(t.updated_at) >= weekStart;
    }).length;
    const lastWeekDone = tasks.filter(t => {
      if (t.status !== 'done' || !t.updated_at) return false;
      const u = new Date(t.updated_at);
      return u >= lastWeekStart && u < weekStart;
    }).length;
    const weekDelta = thisWeekDone - lastWeekDone;
    const remaining = totalAll - totalDone;
    let projectedDate: string | null = null;
    let projectedDaysOver: number | null = null;
    const shipMilestone = MST.find(m => m.label === '출하 목표');
    if (recentDone > 0 && remaining > 0) {
      const daysPerTask = 7 / recentDone;
      const projDays = Math.ceil(remaining * daysPerTask);
      const proj = new Date();
      proj.setDate(proj.getDate() + projDays);
      projectedDate = `${proj.getMonth() + 1}/${proj.getDate()}`;
      if (shipMilestone) {
        const ship = new Date(shipMilestone.date + 'T00:00:00');
        const diff = Math.ceil((proj.getTime() - ship.getTime()) / 864e5);
        projectedDaysOver = diff;
      }
    }

    // #1 Blocker
    const blocker = enriched
      .filter(t => t.isUnblocked && (t.blocksCount || 0) > 0)
      .sort((a, b) => {
        const aOd = a.deadline && a.deadline < todayDate ? 1 : 0;
        const bOd = b.deadline && b.deadline < todayDate ? 1 : 0;
        if (bOd !== aOd) return bOd - aOd;
        return (b.blocksCount || 0) - (a.blocksCount || 0);
      })[0] || null;

    let blockerChain: string[] = [];
    let blockerDays: number | null = null;
    if (blocker?.created_at) {
      const c = new Date(blocker.created_at);
      c.setHours(0, 0, 0, 0);
      const t0 = new Date();
      t0.setHours(0, 0, 0, 0);
      blockerDays = Math.max(1, Math.floor((t0.getTime() - c.getTime()) / 864e5) + 1);
    }
    if (blocker) {
      const getChain = (id: string, depth: number): string[] => {
        if (depth > 4) return [];
        const downstream = tasks.filter(t => (t.dependsOn || []).includes(id) && t.status !== 'done');
        if (downstream.length === 0) return [];
        return downstream.flatMap(t => [t.title, ...getChain(t.id, depth + 1)]);
      };
      blockerChain = getChain(blocker.id, 0);
    }

    // Per-person today tasks
    const personTasks: Record<string, AppTask[]> = {};
    for (const owner of OWNERS.filter(o => o !== '공동')) {
      personTasks[owner] = enriched
        .filter(t => t.isUnblocked && (t.owner === owner || t.owner === '공동'))
        .sort((a, b) => dU(a.deadline) - dU(b.deadline))
        .slice(0, 4);
    }

    return { trackData, uncatTasks, uncatDone, totalDone, totalAll, projectedDate, projectedDaysOver, recentDone, blocker, blockerChain, blockerDays, personTasks, yesterdayDone, yesterdayByOwner, thisWeekDone, lastWeekDone, weekDelta };
  }, [tasks, enriched, todayDate, mergedTracks]);

  const overallPct = data.totalAll > 0 ? Math.round((data.totalDone / data.totalAll) * 100) : 0;
  const shipDate = MST.find(m => m.label === '출하 목표');
  const daysLeft = shipDate ? dU(shipDate.date) : null;

  const statusIcon = (s: string) => {
    if (s === 'done') return '🔵';
    if (s === 'overdue') return '🔴';
    if (s === 'active') return '🟢';
    if (s === 'blocked') return '⏸';
    return '⬜';
  };

  // Track accent colors — white cards, color only as 3px left stripe
  const trackAccent: Record<string, { bg: string; border: string; dot: string }> = {
    '제품': { bg: '#FFFFFF', border: '#ECE8E0', dot: '#5F4B82' },
    '운영': { bg: '#FFFFFF', border: '#ECE8E0', dot: '#4A7A9B' },
    '마케팅': { bg: '#FFFFFF', border: '#ECE8E0', dot: '#9B5A4A' },
    '기타': { bg: '#FFFFFF', border: '#ECE8E0', dot: '#8A7D72' },
  };

  const signalColor = (s: string) => {
    if (s === 'done') return '#5F4B82';
    if (s === 'overdue') return '#B84848';
    if (s === 'active') return '#5C8A4E';
    if (s === 'blocked') return '#C4A896';
    return '#DDD3C2';
  };

  // Render inline task row
  const renderTask = (t: AppTask) => {
    const isDone = t.status === 'done';
    const isOverdue = !isDone && t.deadline != null && t.deadline < todayDate;
    return (
      <div
        key={t.id}
        className="dash-row"
        style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '6px 12px', borderRadius: 6,
          borderLeft: `2px solid ${isDone ? '#5F4B8233' : isOverdue ? '#B84848' : '#E8DFCE'}`,
          opacity: isDone ? 0.45 : 1,
          minHeight: 32,
        }}
      >
        <span
          onClick={() => isDone ? onChangeStatus(t.id, 'todo') : onMarkDone(t.id)}
          style={{
            width: 18, height: 18, borderRadius: '50%', flexShrink: 0,
            border: `2px solid ${isDone ? '#5F4B82' : '#D5CCC0'}`,
            background: isDone ? '#5F4B82' : 'transparent',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', fontSize: 10, color: '#fff',
          }}
        >{isDone ? '✓' : ''}</span>
        <span
          onClick={() => onEdit(t.id)}
          style={{
            flex: 1, fontSize: 14, cursor: 'pointer', lineHeight: 1.5,
            textDecoration: isDone ? 'line-through' : 'none',
            color: isDone ? '#AAA49C' : '#1A1613',
          }}
        >{t.title}</span>
        {t.deadline && (
          <span
            onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
            style={{ fontSize: 12, color: isOverdue ? '#B84848' : '#AAA49C', cursor: 'pointer', whiteSpace: 'nowrap' }}
          >{fD(t.deadline)}</span>
        )}
        <span
          onClick={(e) => { e.stopPropagation(); onOwnerPick(t.id, e); }}
          style={{
            fontSize: 10, padding: '2px 8px', borderRadius: 100, cursor: 'pointer',
            background: ownerColors[t.owner]?.bg || ownerColors['공동'].bg,
            color: ownerColors[t.owner]?.accent || ownerColors['공동'].accent,
            fontWeight: 400,
          }}
        >{t.owner}</span>
        {!isDone && (
          <select
            className="status-pill"
            value={t.status}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => onChangeStatus(t.id, e.target.value)}
            style={{
              cursor: 'pointer', fontSize: 10, padding: '2px 6px', borderRadius: 100, fontWeight: 400,
              background: SC[t.status]?.bg, color: SC[t.status]?.tx,
              border: `1px solid ${SC[t.status]?.bd}`,
              appearance: 'none', WebkitAppearance: 'none', outline: 'none',
              textAlign: 'center', minWidth: 48,
            }}
          >
            {STS.map(st => <option key={st} value={st} style={{ background: SC[st]?.bg, color: SC[st]?.tx }}>{SL[st]}</option>)}
          </select>
        )}
      </div>
    );
  };

  return (
    <div style={{ margin: '0 16px', display: 'flex', flexDirection: 'column', gap: 8 }}>

      {/* ═══ Hero — outcome-first (v14) ═══ */}
      <div style={{ background: '#FFFFFF', border: '1px solid #E5E8EB', borderRadius: 10, padding: '14px 16px' }}>
        {/* Primary row — ship status & delay */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 20, flexWrap: 'wrap' }}>
          {daysLeft != null && shipDate && (
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
              <span style={{ fontSize: 22, fontWeight: 700, color: '#191F28', letterSpacing: '-0.02em', lineHeight: 1 }}>
                {daysLeft < 0 ? `D+${Math.abs(daysLeft)}` : daysLeft === 0 ? 'D-DAY' : `D-${daysLeft}`}
              </span>
              <span style={{ fontSize: 13, color: '#4E5968', fontWeight: 600 }}>
                {shipDate.date.replace(/-/g, '.')}
              </span>
              <span style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500 }}>출시</span>
            </div>
          )}
          <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 4 }}>
            <span style={{ fontSize: 12, fontWeight: 500, color: '#8B95A1' }}>진행률</span>
            <span style={{ fontSize: 12, fontWeight: 600, color: '#4E5968' }}>{overallPct}%</span>
          </div>
        </div>
        {/* Progress bar */}
        <div style={{ width: '100%', height: 3, background: '#F2F4F6', borderRadius: 100, overflow: 'hidden', marginTop: 10 }}>
          <div style={{
            width: `${overallPct}%`, height: '100%', borderRadius: 100, transition: 'width .5s ease',
            background: data.projectedDaysOver != null && data.projectedDaysOver > 0 ? '#F04452' : '#3182F6',
          }} />
        </div>
      </div>

      {/* ═══ Customer Goal — 5/30까지 500명 ═══ */}
      {(() => {
        const cgPct = Math.min(100, Math.round((customerCount / CUSTOMER_GOAL.target) * 100));
        const cgDays = dU(CUSTOMER_GOAL.deadline);
        return (
          <div style={{ background: '#FFFFFF', border: '1px solid #E5E8EB', borderRadius: 10, padding: '14px 16px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: '#8B95A1', letterSpacing: '.02em' }}>목표</span>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#191F28' }}>{CUSTOMER_GOAL.deadline.slice(5).replace('-', '/')}까지 고객 {CUSTOMER_GOAL.target}명</span>
              <span
                onClick={handleEditCustomerCount}
                style={{ marginLeft: 'auto', display: 'flex', alignItems: 'baseline', gap: 4, cursor: 'pointer' }}
                title="클릭해서 수정"
              >
                <span style={{ fontSize: 22, fontWeight: 700, color: '#3182F6', letterSpacing: '-0.02em', lineHeight: 1 }}>
                  {customerCount}
                </span>
                <span style={{ fontSize: 12, color: '#8B95A1', fontWeight: 500 }}>/ {CUSTOMER_GOAL.target}</span>
                <span style={{ fontSize: 11, color: cgDays < 0 ? '#F04452' : '#8B95A1', fontWeight: 500, marginLeft: 8 }}>
                  {cgDays < 0 ? `D+${Math.abs(cgDays)}` : cgDays === 0 ? 'D-DAY' : `D-${cgDays}`}
                </span>
              </span>
            </div>
            <div style={{ width: '100%', height: 3, background: '#F2F4F6', borderRadius: 100, overflow: 'hidden', marginTop: 10 }}>
              <div style={{ width: `${cgPct}%`, height: '100%', background: '#3182F6', borderRadius: 100, transition: 'width .5s ease' }} />
            </div>
          </div>
        );
      })()}

      {/* ═══ #1 블로커 ═══ */}
      {data.blocker && (
        <div style={{
          background: '#FFFFFF',
          border: '1px solid #E5E8EB',
          borderRadius: 10, padding: '12px 16px',
          borderLeft: `3px solid ${data.blocker.deadline && data.blocker.deadline < todayDate ? '#F04452' : '#3182F6'}`,
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
            <span style={{ fontSize: 11, fontWeight: 600, color: '#8B95A1', letterSpacing: '.02em' }}>
              BLOCKER
            </span>
            {data.blockerDays != null && (
              <span style={{
                fontSize: 10, fontWeight: 600,
                padding: '2px 6px', borderRadius: 100,
                background: data.blockerDays >= 3 ? '#FFF0F2' : '#F2F4F6',
                color: data.blockerDays >= 3 ? '#F04452' : '#8B95A1',
                letterSpacing: '.02em',
              }}>
                {data.blockerDays}일째 막힘
              </span>
            )}
          </div>
          <div
            onClick={() => onEdit(data.blocker!.id)}
            className="dash-row"
            style={{ cursor: 'pointer', borderRadius: 4, padding: '2px 0', marginBottom: 4 }}
          >
            <div style={{ fontSize: 14, fontWeight: 600, color: '#191F28', lineHeight: 1.4, marginBottom: 4, letterSpacing: '-0.01em' }}>
              {data.blocker.title}
            </div>
            {data.blockerChain.length > 0 && (
              <div style={{ fontSize: 12, color: '#8B95A1', marginBottom: 4, lineHeight: 1.5 }}>
                이거 안 풀리면 → {data.blockerChain.slice(0, 3).join(' → ')}{data.blockerChain.length > 3 ? ` 외 ${data.blockerChain.length - 3}개` : ''} 밀림
              </div>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
            <span
              onClick={(e) => { e.stopPropagation(); onOwnerPick(data.blocker!.id, e); }}
              style={{
                fontSize: 11, padding: '3px 10px', borderRadius: 100, cursor: 'pointer', fontWeight: 400,
                background: ownerColors[data.blocker.owner]?.bg || ownerColors['공동'].bg,
                color: ownerColors[data.blocker.owner]?.accent || ownerColors['공동'].accent,
              }}
            >
              {data.blocker.owner}
            </span>
            {data.blocker.deadline && (
              <span
                onClick={(e) => onDateClick(data.blocker!.id, e)}
                style={{
                  fontSize: 11, fontStyle: 'italic', cursor: 'pointer',
                  color: data.blocker.deadline < todayDate ? '#B84848' : '#AAA49C',
                  padding: '3px 10px', borderRadius: 100,
                  border: `1px solid ${data.blocker.deadline < todayDate ? '#D4A4A4' : '#E8DFCE'}`,
                }}
              >
                {fD(data.blocker.deadline)}
                <span style={{ fontSize: 9, marginLeft: 4 }}>
                  {dU(data.blocker.deadline) < 0 ? `D+${Math.abs(dU(data.blocker.deadline))}` : dU(data.blocker.deadline) === 0 ? 'TODAY' : `D-${dU(data.blocker.deadline)}`}
                </span>
              </span>
            )}
            <div style={{ marginLeft: 'auto', display: 'flex', gap: 6 }}>
              <select
                className="status-pill"
                value={data.blocker.status}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onChangeStatus(data.blocker!.id, e.target.value)}
                style={{ fontSize: 11, padding: '3px 8px', borderRadius: 100, fontWeight: 400, background: SC[data.blocker.status]?.bg, color: SC[data.blocker.status]?.tx, border: `1px solid ${SC[data.blocker.status]?.bd}`, cursor: 'pointer', outline: 'none', minWidth: 52 }}
              >
                {STS.map(st => <option key={st} value={st} style={{ background: SC[st]?.bg, color: SC[st]?.tx }}>{SL[st]}</option>)}
              </select>
              <span
                onClick={() => onMarkDone(data.blocker!.id)}
                style={{ width: 28, height: 28, borderRadius: 6, border: '2px solid #5C8A4E', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', fontSize: 14, color: '#5C8A4E', fontWeight: 600 }}
              >✓</span>
            </div>
          </div>
        </div>
      )}

      {/* ═══ 할 일 추가 ═══ */}
      <button
        onClick={() => onAddNew()}
        style={{
          alignSelf: 'flex-start',
          display: 'flex', alignItems: 'center', gap: 6,
          fontSize: 13, fontWeight: 600, padding: '8px 14px',
          background: '#3182F6', color: '#FFFFFF',
          border: 'none', borderRadius: 8, cursor: 'pointer', marginTop: 4,
        }}
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
          <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"/>
        </svg>
        할 일 추가
      </button>

      {/* ═══ 오늘 할 것 ═══ */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#4E5968', marginBottom: 6, padding: '0 2px', letterSpacing: '-0.01em' }}>
          오늘 할 것
        </div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {OWNERS.filter(o => o !== '공동').map(owner => {
          const myTasks = data.personTasks[owner] || [];
          const oc = ownerColors[owner] || ownerColors['공동'];
          if (myTasks.length === 0) return null;
          return (
            <div key={owner} style={{
              flex: '1 1 280px', minWidth: 0,
              background: '#FFFFFF', border: '1px solid #E5E8EB', borderRadius: 10,
              overflow: 'hidden',
            }}>
              <div style={{ padding: '8px 12px 4px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{
                  width: 8, height: 8, borderRadius: '50%', background: oc.accent, flexShrink: 0,
                }} />
                <span style={{ fontSize: 14, fontWeight: 500, color: '#1A1613' }}>{owner}</span>
                <span style={{ fontSize: 12, color: '#B5AFA6' }}>{myTasks.length}</span>
              </div>
              <div style={{ padding: '0 6px 8px', display: 'flex', flexDirection: 'column', gap: 2 }}>
                {myTasks.map(t => {
                  const isOverdue = t.deadline != null && t.deadline < todayDate;
                  return (
                    <div
                      key={t.id}
                      onClick={() => onEdit(t.id)}
                      className="dash-row"
                      style={{
                        padding: '5px 10px', cursor: 'pointer', borderRadius: 5,
                        display: 'flex', alignItems: 'center', gap: 8,
                        minHeight: 28,
                      }}
                    >
                      <span
                        onClick={(e) => { e.stopPropagation(); onMarkDone(t.id); }}
                        style={{ width: 14, height: 14, borderRadius: '50%', border: '1.5px solid #D1D6DB', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', flexShrink: 0 }}
                      />
                      <span style={{ fontSize: 13, lineHeight: 1.4, color: '#191F28', fontWeight: 500, flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {t.title}
                        {t.project && (
                          <span style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500, marginLeft: 6 }}>{t.project}</span>
                        )}
                      </span>
                      <span
                        onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
                        style={{ fontSize: 11, color: t.deadline ? (isOverdue ? '#F04452' : '#8B95A1') : '#C5CCD3', whiteSpace: 'nowrap', fontWeight: 500, cursor: 'pointer', padding: '2px 4px' }}
                        title={t.deadline ? '날짜 수정' : '날짜 추가'}
                      >
                        {t.deadline ? fD(t.deadline) : '+날짜'}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          );
        })}
        </div>
      </div>

      {/* ═══ 트랙 > 절차(신호등) > TODO ═══ */}
      <div style={{ marginTop: 8 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: '#4E5968', marginBottom: 6, padding: '0 2px', letterSpacing: '-0.01em' }}>
          트랙
        </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {data.trackData.map(track => {
        const isOpen = openTracks.has(track.name);
        const pct = track.total > 0 ? Math.round((track.done / track.total) * 100) : 0;
        const accent = trackAccent[track.name] || trackAccent['기타'];
        return (
          <div key={track.name} style={{
            background: accent.bg, border: '1px solid #E5E8EB', borderRadius: 10, overflow: 'hidden',
            borderLeft: `3px solid ${track.hasOverdue ? '#F04452' : accent.dot}`,
          }}>
            {/* Track header */}
            <div
              onClick={() => toggleTrack(track.name)}
              className="dash-row"
              style={{
                padding: '10px 14px', cursor: 'pointer',
                display: 'flex', alignItems: 'center', gap: 10,
                minHeight: 40,
              }}
            >
              <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 14, fontWeight: 600, color: '#191F28', letterSpacing: '-0.01em' }}>{track.name}</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 3 }}>
                  {track.phases.map((p, i) => (
                    <React.Fragment key={p.name}>
                      <span title={p.name} style={{
                        width: 6, height: 6, borderRadius: '50%',
                        background: signalColor(p.status),
                        transition: 'background .3s',
                      }} />
                      {i < track.phases.length - 1 && (
                        <span style={{ width: 4, height: 1, background: '#E5E8EB' }} />
                      )}
                    </React.Fragment>
                  ))}
                </div>
                {track.target && (
                  <span style={{ fontSize: 11, color: dU(track.target) < 0 ? '#F04452' : '#8B95A1', fontWeight: 500 }}>
                    {dU(track.target) < 0 ? `D+${Math.abs(dU(track.target))}` : dU(track.target) === 0 ? 'D-DAY' : `D-${dU(track.target)}`}
                  </span>
                )}
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                <svg width="14" height="14" viewBox="0 0 18 18" style={{ transform: 'rotate(-90deg)' }}>
                  <circle cx="9" cy="9" r="7" fill="none" stroke="#E5E8EB" strokeWidth="2" />
                  <circle
                    cx="9" cy="9" r="7" fill="none" stroke={accent.dot} strokeWidth="2"
                    strokeDasharray={`${(pct / 100) * 43.98} 43.98`}
                    strokeLinecap="round"
                    style={{ transition: 'stroke-dasharray .5s ease' }}
                  />
                </svg>
                <span style={{ fontSize: 11, color: '#8B95A1', fontWeight: 600, minWidth: 24 }}>{pct}%</span>
              </div>
              <svg width="14" height="14" viewBox="0 0 14 14" fill="none" style={{
                color: '#8B95A1',
                transform: isOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                transition: 'transform .2s ease', flexShrink: 0,
              }}>
                <path d="M5.5 3.5L9 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </div>

            {/* Track expanded — show phases with signal lights */}
            {isOpen && (
              <div style={{ borderTop: '1px solid #F2F4F6', padding: '4px 6px 6px' }}>
                {track.phases.map(phase => {
                  const phaseOpen = openPhases.has(`${track.name}/${phase.name}`);
                  const phasePct = phase.total > 0 ? Math.round((phase.done / phase.total) * 100) : 0;
                  return (
                    <div key={phase.name} style={{ marginBottom: 2 }}>
                      {/* Phase row */}
                      <div
                        onClick={() => togglePhase(`${track.name}/${phase.name}`)}
                        className="dash-row"
                        style={{
                          display: 'flex', alignItems: 'center', gap: 10,
                          padding: '5px 12px', cursor: 'pointer', borderRadius: 6,
                          minHeight: 28,
                        }}
                      >
                        <span style={{
                          width: 8, height: 8, borderRadius: '50%', flexShrink: 0,
                          background: signalColor(phase.status),
                          boxShadow: phase.status === 'overdue' ? '0 0 4px rgba(240,68,82,.4)' : 'none',
                        }} />
                        <span style={{ fontSize: 13, fontWeight: 500, color: '#4E5968', flex: 1 }}>{phase.name}</span>
                        {phase.target && phase.status !== 'done' && (
                          <span style={{
                            fontSize: 11, fontWeight: 500,
                            color: dU(phase.target) < 0 ? '#F04452' : '#8B95A1',
                          }}>
                            {dU(phase.target) < 0 ? `D+${Math.abs(dU(phase.target))}` : dU(phase.target) === 0 ? 'D-DAY' : `D-${dU(phase.target)}`}
                          </span>
                        )}
                        <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{
                          color: '#8B95A1',
                          transform: phaseOpen ? 'rotate(90deg)' : 'rotate(0deg)',
                          transition: 'transform .2s ease', flexShrink: 0,
                        }}>
                          <path d="M5.5 3.5L9 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </div>

                      {/* Phase expanded — show tasks + per-phase add-task button */}
                      {phaseOpen && (
                        <div style={{ padding: '2px 0 6px 34px', display: 'flex', flexDirection: 'column', gap: 1 }}>
                          {phase.tasks.map(t => renderTask(t))}
                          <button
                            onClick={(e) => {
                              e.stopPropagation();
                              const trackCategory: Record<string, string> = { '제품': '제조', '운영': '사업자/인허가', '마케팅': '마케팅' };
                              const phaseMeta = TRACKS.find(tr => tr.name === track.name)?.phases.find(p => p.name === phase.name);
                              const firstProject = phase.tasks[0]?.project || phaseMeta?.projects[0] || '';
                              onAddNew({
                                category: trackCategory[track.name] || '기타',
                                project: firstProject,
                                deadline: phaseMeta?.target || null,
                              });
                            }}
                            style={{
                              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                              width: '100%', marginTop: 4, padding: '5px 12px',
                              background: 'transparent', border: '1px dashed #D1D6DB',
                              borderRadius: 6, color: '#8B95A1', fontSize: 11, fontWeight: 500,
                              cursor: 'pointer',
                            }}
                          >
                            <svg width="9" height="9" viewBox="0 0 12 12" fill="none">
                              <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                            </svg>
                            할 일 추가
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })}
                {/* Add new project (phase-level) — opens editor with new project name preset */}
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    const trackCategory: Record<string, string> = { '제품': '제조', '운영': '사업자/인허가', '마케팅': '마케팅' };
                    const name = window.prompt(`${track.name}에 새 프로젝트 이름을 입력하세요`);
                    if (!name || !name.trim()) return;
                    const phaseName = name.trim();
                    addExtraPhase(track.name, phaseName);
                    onAddNew({
                      category: trackCategory[track.name] || '기타',
                      project: phaseName,
                    });
                  }}
                  style={{
                    display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                    width: '100%', marginTop: 6, padding: '6px 12px',
                    background: 'transparent', border: '1px dashed #D1D6DB',
                    borderRadius: 6, color: '#8B95A1', fontSize: 12, fontWeight: 500,
                    cursor: 'pointer',
                  }}
                >
                  <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                    <path d="M6 2v8M2 6h8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round"/>
                  </svg>
                  프로젝트 추가
                </button>
              </div>
            )}
          </div>
        );
      })}
      </div>

      {/* Uncategorized tasks */}
      {data.uncatTasks.length > 0 && (
        <div style={{ background: '#FFFFFF', border: '1px solid #ECE8E0', borderRadius: 12, overflow: 'hidden', marginTop: 8 }}>
          <div
            onClick={() => toggleTrack('기타')}
            className="dash-row"
            style={{ padding: '14px 16px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 12, minHeight: 48 }}
          >
            <span style={{ fontSize: 14, fontWeight: 500, color: '#1A1613', flex: 1 }}>기타</span>
            <span style={{ fontSize: 12, color: '#B5AFA6' }}>{data.uncatTasks.length - data.uncatDone}개 남음</span>
            <svg width="12" height="12" viewBox="0 0 14 14" fill="none" style={{ color: '#8B95A1', transform: openTracks.has('기타') ? 'rotate(90deg)' : 'rotate(0deg)', transition: 'transform .2s ease', flexShrink: 0 }}>
              <path d="M5.5 3.5L9 7l-3.5 3.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          {openTracks.has('기타') && (
            <div style={{ borderTop: '1px solid #ECE8E0', padding: '6px 8px 10px' }}>
              {data.uncatTasks
                .sort((a, b) => {
                  if (a.status === 'done' && b.status !== 'done') return 1;
                  if (a.status !== 'done' && b.status === 'done') return -1;
                  return dU(a.deadline) - dU(b.deadline);
                })
                .map(t => renderTask(t))}
            </div>
          )}
        </div>
      )}
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
            <div style={{ fontSize: 15 }}>{d.date.getDate()}</div>
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
  projects, expandedProjects, onToggleExpand, onEdit, onChangeStatus, onMarkDone, onDateClick,
}: {
  projects: { name: string; category: string; items: AppTask[]; done: number; total: number; active: number; primaryOwner: string; isNew: boolean }[];
  expandedProjects: Set<string>;
  onToggleExpand: (name: string) => void;
  onEdit: (id: string) => void;
  onChangeStatus: (id: string, newStatus: string) => void;
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
              <span style={{ fontSize: 13, flex: 1 }}>
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
                {proj.total - proj.done}개 남음
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
                          onClick={(e) => { e.stopPropagation(); isDone ? onChangeStatus(t.id, 'todo') : onMarkDone(t.id); }}
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
// OWNER PICKER (inline popover)
// ═══════════════════════════════════════════════════
function OwnerPicker({
  currentOwner, pos, onClose, onPick,
}: {
  currentOwner: string;
  pos: { top: number; left: number };
  onClose: () => void;
  onPick: (owner: string) => void;
}) {
  const popupTop = Math.min(pos.top + 8, window.innerHeight - 100);
  const popupLeft = Math.min(pos.left, window.innerWidth - 140);
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 1005 }} onClick={onClose}>
      <div
        style={{
          position: 'fixed', top: popupTop, left: popupLeft,
          background: '#FFFFFF', border: '1px solid #E5E8EB', borderRadius: 8,
          padding: 4, minWidth: 120,
          boxShadow: '0 8px 24px rgba(0,0,0,.12)',
          display: 'flex', flexDirection: 'column', gap: 2,
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {OWNERS.map(o => {
          const oc = ownerColors[o] || ownerColors['공동'];
          const active = o === currentOwner;
          return (
            <button
              key={o}
              onClick={() => onPick(o)}
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                padding: '8px 12px', border: 'none',
                background: active ? '#F2F4F6' : 'transparent',
                color: '#191F28', fontSize: 13, fontWeight: 500,
                borderRadius: 6, cursor: 'pointer', textAlign: 'left',
              }}
            >
              <span style={{ width: 8, height: 8, borderRadius: '50%', background: oc.accent }} />
              {o}
              {active && <span style={{ marginLeft: 'auto', color: '#3182F6', fontWeight: 700 }}>✓</span>}
            </button>
          );
        })}
      </div>
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
          <span style={{ fontSize: 13 }}>
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
  tasks, selectMode, selectedIds, onSelect, onEdit, onChangeStatus, onCycleOwner, onCyclePriority, onMarkDone, onDateClick, dragId, dragCol, onDS, onDO, onDD, onDE,
}: {
  tasks: AppTask[];
  selectMode: boolean;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onChangeStatus: (id: string, newStatus: string) => void;
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
              <span style={{ color: sc.tx, fontSize: 13 }}>{SL[st]}</span>
              <span style={{ color: sc.tx, fontSize: 18 }}>{items.length}</span>
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
                        <select
                          className="status-pill"
                          value={t.status}
                          onClick={(e) => e.stopPropagation()}
                          onChange={(e) => onChangeStatus(t.id, e.target.value)}
                          style={{ ...S.stBadge, background: SC[t.status]?.bg, color: SC[t.status]?.tx, border: `1px solid ${SC[t.status]?.bd}`, cursor: 'pointer', outline: 'none', minWidth: 48 }}
                        >
                          {STS.map(st => <option key={st} value={st} style={{ background: SC[st]?.bg, color: SC[st]?.tx }}>{SL[st]}</option>)}
                        </select>
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
  task, initialValues, onClose, onSave, onDelete, allTasks,
}: {
  task?: AppTask;
  initialValues?: Partial<AppTask>;
  onClose: () => void;
  onSave: (t: Partial<AppTask>) => void;
  onDelete?: () => void;
  allTasks: AppTask[];
}) {
  const projectsList = [...new Set(allTasks.map((t) => t.project).filter(Boolean))];
  const iv = initialValues || {};
  const [f, setF] = useState({
    title: task?.title || iv.title || '',
    category: task?.category || iv.category || '기타',
    project: task?.project || iv.project || '',
    owner: task?.owner || iv.owner || OWNERS[0],
    deadline: task?.deadline || iv.deadline || '',
    status: task?.status || iv.status || 'todo',
    note: task?.note || iv.note || '',
    priority: task?.priority || iv.priority || 'medium',
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
@import url('https://fonts.googleapis.com/css2?family=Noto+Sans+KR:wght@300;400;500;600;700&display=swap');
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/variable/pretendardvariable-dynamic-subset.min.css');
*{box-sizing:border-box;margin:0}
button,select{cursor:pointer;font-family:inherit}
input,select,textarea{font-family:inherit}
select.status-pill{-webkit-appearance:none;appearance:none;padding-right:16px;background-repeat:no-repeat;background-position:right 5px center;background-size:8px;background-image:url("data:image/svg+xml,%3Csvg viewBox='0 0 10 6' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M1 1l4 4 4-4' stroke='%238A7D72' stroke-width='1.5' fill='none'/%3E%3C/svg%3E")}
@keyframes fadeUp{from{opacity:0;transform:translateY(8px) translateX(0)}to{opacity:1;transform:translateY(0) translateX(0)}}
@keyframes flashGreen{0%{background:#EBF3E6}50%{background:#A8C496}100%{background:#EBF3E6}}
.dash-row{transition:background .15s ease}
.dash-row:hover{background:rgba(95,75,130,.04) !important}
.dash-row:active{background:rgba(95,75,130,.08) !important}
@media(max-width:767px){
  .board-grid{grid-template-columns:1fr !important}
}
`;

const S: Record<string, React.CSSProperties> = {
  root: {
    minHeight: '100vh', background: '#FAFAF8', fontFamily: "'Pretendard','Noto Sans KR',sans-serif",
    fontWeight: 400, color: '#1A1613', maxWidth: 800, margin: '0 auto',
    display: 'flex', flexDirection: 'column', gap: 8,
    paddingBottom: 60, fontSize: 13, lineHeight: 1.5,
    fontVariantNumeric: 'tabular-nums',
  },
  // Header
  header: {
    position: 'sticky', top: 0, zIndex: 100,
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 10,
    padding: '12px 16px',
    background: '#FAFAF8', borderBottom: '1px solid #ECE8E0',
  },
  hL: { display: 'flex', alignItems: 'center', gap: 8 },
  hR: { display: 'flex', gap: 6, flexWrap: 'wrap' },
  brand: { display: 'flex', alignItems: 'center', gap: 6 },
  dot: { width: 5, height: 5, borderRadius: '50%', background: '#5F4B82', display: 'inline-block' },
  bTxt: { fontSize: 11, letterSpacing: '.3em', color: '#4A3F38' },
  ms: { background: '#FAF6EF', border: '1px solid', padding: '4px 12px', borderRadius: 8, textAlign: 'right' as const, minWidth: 76 },
  msL: { fontSize: 10, letterSpacing: '.05em', color: '#8A7D72' },
  msD: { fontSize: 17, fontWeight: 600, lineHeight: 1.2 },
  msDt: { fontSize: 10, color: '#AAA49C' },
  // Command bar
  cmdBar: {
    position: 'sticky', top: 47, zIndex: 99,
    display: 'flex', gap: 6, alignItems: 'flex-start',
    padding: '8px 14px',
    background: '#FAFAF8', borderBottom: '1px solid #ECE8E0',
    flexDirection: 'column',
  },
  cmdInput: {
    flex: 1, padding: '10px 14px', background: '#fff', border: '1px solid #DDD3C2', borderRadius: 6,
    fontSize: 14, color: '#1A1613', outline: 'none', fontWeight: 300,    minWidth: 200,
  },
  cmdAddBtn: {
    padding: '10px 16px', background: '#1A1613', color: '#FAF6EF',
    border: 'none', borderRadius: 6, fontSize: 13, fontWeight: 500, whiteSpace: 'nowrap',
  },
  // Filters
  filterBar: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6, flexWrap: 'wrap',
    padding: '0 14px',
  },
  filters: { display: 'flex', gap: 4 },
  sel: { padding: '6px 10px', border: '1px solid #DDD3C2', borderRadius: 8, background: '#FAF6EF', fontSize: 12, color: '#4A3F38' },
  toolBtn: {
    padding: '6px 12px', background: '#FAF6EF', border: '1px solid #A896C4', borderRadius: 8,
    color: '#5F4B82', fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
  },
  // Stats
  stats: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 4, padding: '0 14px' },
  st: { background: '#FAF6EF', padding: '6px 10px', borderRadius: 2, borderLeft: '3px solid', display: 'flex', alignItems: 'baseline', gap: 4 },
  stN: { fontSize: 'clamp(16px,3vw,22px)', lineHeight: 1 },
  stL: { fontSize: 9, color: '#8A7D72' },
  // Collapsible sections
  section: { border: '1px solid #E8DFCE', borderRadius: 12, overflow: 'hidden', margin: '0 16px' },
  sectionHead: {
    display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%',
    padding: '12px 16px', background: '#FAF6EF', border: 'none', borderBottom: '1px solid #E8DFCE',
    cursor: 'pointer',  },
  sectionTitle: { fontSize: 14, fontWeight: 500, color: '#1A1613' },
  sectionToggle: { fontSize: 12, color: '#AAA49C' },
  sectionBody: { padding: 8 },
  // Cards
  card: {
    padding: '12px 16px', background: '#FAF6EF', borderLeft: '3px solid #DDD3C2', borderRadius: 12,
    cursor: 'pointer', transition: 'all .15s', animation: 'fadeUp .3s ease-out', userSelect: 'none',
  },
  cTop: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, flexWrap: 'wrap' },
  catB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, letterSpacing: '.03em', whiteSpace: 'nowrap' },
  ownB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, whiteSpace: 'nowrap' },
  cTitle: { fontSize: 12, fontWeight: 400, lineHeight: 1.4, marginBottom: 2 },
  cBot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 },
  cDate: { fontStyle: 'italic', fontSize: 10 },
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
  modal: { background: '#FAF6EF', borderRadius: 16, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto', border: '1px solid #DDD3C2', boxShadow: '0 20px 60px rgba(26,22,19,.15)' },
  mHead: { padding: '12px 16px 8px', borderBottom: '1px solid #EFE7D6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  mTitle: { fontWeight: 400, fontSize: 17, margin: 0 },
  mClose: { background: 'transparent', border: 'none', fontSize: 20, color: '#8A7D72', padding: 0 },
  mBody: { padding: '10px 16px', display: 'flex', flexDirection: 'column', gap: 8 },
  label: { fontStyle: 'italic', fontSize: 11, color: '#8A7D72' },
  input: { padding: '10px 14px', background: '#fff', border: '1px solid #DDD3C2', borderRadius: 8, fontSize: 14, color: '#1A1613', outline: 'none', fontWeight: 400, width: '100%' },
  r2: { display: 'flex', gap: 8 },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  mFoot: { padding: '8px 16px 12px', borderTop: '1px solid #EFE7D6', display: 'flex', gap: 8, alignItems: 'center' },
  delBtn: { padding: '8px 16px', background: 'transparent', border: '1px solid #D4A4A4', color: '#B84848', borderRadius: 8, fontSize: 12 },
  canBtn: { padding: '8px 16px', background: 'transparent', border: '1px solid #DDD3C2', color: '#8A7D72', borderRadius: 8, fontSize: 12 },
  savBtn: { padding: '8px 20px', background: '#1A1613', border: 'none', color: '#FAF6EF', borderRadius: 8, fontSize: 14, fontWeight: 500 },
  confirmBtn: { padding: '12px 20px', background: '#5F4B82', color: '#FAF6EF', border: 'none', borderRadius: 8, fontSize: 14, fontWeight: 500, width: '100%', marginTop: 8 },
  pChk: { width: 16, height: 16, borderRadius: 2, border: '1.5px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0, marginTop: 1 },
  footer: { padding: '12px 14px', borderTop: '1px solid #DDD3C2', display: 'flex', alignItems: 'center', gap: 8, fontStyle: 'italic', fontSize: 11, color: '#8A7D72', marginTop: 'auto' },
  fLink: { background: 'transparent', border: 'none', fontSize: 10, color: '#B84848', textDecoration: 'underline', padding: 0, fontFamily: 'inherit', fontStyle: 'italic' },
};
