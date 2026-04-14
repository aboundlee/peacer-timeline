'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { supabase, dbToApp, appToDb } from '@/lib/supabase';
import { CATS, CC, STS, SL, SC, OWNERS, MST, OKR, dU, fD, uid } from '@/lib/constants';
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

type AiAction = {
  type: 'create' | 'update' | 'complete' | 'info';
  taskId?: string;
  taskTitle?: string;
  changes?: Partial<AppTask>;
  newTask?: Partial<AppTask>;
  message?: string;
  reason?: string;
  cascadeTargets?: { id: string; title: string; oldDeadline: string; newDeadline: string }[];
};

// ═══════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════
export default function App() {
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [analyzeMode, setAnalyzeMode] = useState(false);
  const [aiProcessing, setAiProcessing] = useState(false);
  const [aiActions, setAiActions] = useState<AiAction[] | null>(null);
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
  const cmdRef = useRef<HTMLTextAreaElement>(null);

  // Cmd+K to focus command bar
  useEffect(() => {
    const handleGlobalKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        cmdRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handleGlobalKey);
    return () => window.removeEventListener('keydown', handleGlobalKey);
  }, []);

  // Load collapsed state from localStorage
  useEffect(() => {
    try {
      const saved = localStorage.getItem('peacer-collapsed');
      if (saved) setCollapsed(JSON.parse(saved));
      else {
        // Mobile: collapse sections 3-5 by default
        if (window.innerWidth < 768) {
          setCollapsed({ weekly: true, progress: true, kanban: true });
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
    const idx = STS.indexOf(task.status as typeof STS[number]);
    const next = STS[(idx + 1) % STS.length];
    up(id, { status: next as AppTask['status'] });
  };

  const cycleOwner = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const idx = OWNERS.indexOf(task.owner);
    const next = OWNERS[(idx + 1) % OWNERS.length];
    up(id, { owner: next });
  };

  const cyclePriority = (id: string) => {
    const task = tasks.find((t) => t.id === id);
    if (!task) return;
    const order: AppTask['priority'][] = ['medium', 'high', 'low'];
    const idx = order.indexOf(task.priority as AppTask['priority']);
    const next = order[(idx + 1) % order.length];
    up(id, { priority: next });
  };

  // ─── AI Command bar handler ───
  const handleCmdSubmit = async () => {
    const text = cmdText.trim();
    if (!text || aiProcessing) return;

    setAiProcessing(true);
    setAiActions(null);

    try {
      const existingTasksSummary = tasks.map(t =>
        `id:"${t.id}" title:"${t.title}" category:${t.category} project:${t.project||'없음'} owner:${t.owner} deadline:${t.deadline||'없음'} status:${t.status} priority:${t.priority} note:"${t.note}" dependsOn:[${t.dependsOn.join(',')}]`
      ).join('\n');

      const today = todayStr();
      const dayOfWeek = ['일','월','화','수','목','금','토'][new Date().getDay()];

      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: `You are a PM assistant for Peacer (피서), a shower bomb brand. You manage the team's task timeline.

CURRENT DATE: ${today} (${dayOfWeek}요일), YEAR: 2026

EXISTING TASKS:
${existingTasksSummary}

CATEGORIES: 제조, 사업자/인허가, 마케팅, 디자인, 계약, 기타
OWNERS: 풍성, 은채, 공동
STATUSES: todo, doing, waiting, done
PRIORITIES: high, medium, low

INSTRUCTIONS:
The user will send you natural language text — meeting notes, status updates, casual messages, etc.
Analyze and return a JSON array of actions to take:

[
  {
    "type": "update",
    "taskId": "s12",
    "taskTitle": "existing task title for display",
    "changes": { "deadline": "2026-04-19", "status": "waiting", "note": "금요일 발송 예정" },
    "reason": "brief Korean explanation"
  },
  {
    "type": "create",
    "newTask": { "title": "새 태스크", "category": "제조", "project": "샘플링", "owner": "풍성", "deadline": "2026-04-20", "status": "todo", "priority": "medium", "note": "" },
    "reason": "brief Korean explanation"
  },
  {
    "type": "complete",
    "taskId": "s24",
    "taskTitle": "existing task title for display",
    "reason": "brief Korean explanation"
  },
  {
    "type": "info",
    "message": "Korean response to user's question"
  }
]

RULES:
- MATCH existing tasks by semantic similarity (don't just match exact title)
- For date keywords: "오늘"=${today}, "내일"=tomorrow, "이번주 금요일"=this Friday, "다음주"=next Monday, etc
- When updating deadline, also check if task has dependents (dependsOn field) and include cascadeTargets if downstream tasks should shift
- For cascade: calculate the day difference and shift all downstream tasks by that amount
- If the text is a question (뭐해야해? 일정 어때? etc), return type:"info" with a helpful PM-style response based on current tasks
- If the text contains multiple actionable items, return multiple actions
- Infer category, project, owner from context when possible
- For note updates on existing tasks, APPEND to existing note (don't replace)
- Return ONLY the JSON array, no markdown fences, no explanation outside JSON
- Always respond even if unclear — make your best guess and explain in "reason"`,
          userMessage: text,
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));

      let jsonStr = (data.content || [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
        .trim()
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();

      const si = jsonStr.indexOf('[');
      const ei = jsonStr.lastIndexOf(']');
      if (si === -1) throw new Error('파싱 실패');

      const actions: AiAction[] = JSON.parse(jsonStr.slice(si, ei + 1));
      setAiActions(actions);
    } catch (e: unknown) {
      setAiActions([{ type: 'info', message: `오류: ${e instanceof Error ? e.message : '알 수 없는 오류'}` }]);
    }
    setAiProcessing(false);
  };

  const applyAiActions = async () => {
    if (!aiActions) return;

    for (const action of aiActions) {
      if (action.type === 'create' && action.newTask) {
        await add(action.newTask);
      } else if (action.type === 'update' && action.taskId && action.changes) {
        const changes = { ...action.changes };
        // Handle note appending
        if (changes.note) {
          const existing = tasks.find(t => t.id === action.taskId);
          if (existing?.note) {
            changes.note = existing.note + ' | ' + changes.note;
          }
        }
        delete (changes as Record<string, unknown>).deadlineShift;
        await up(action.taskId, changes);

        // Apply cascade if specified
        if (action.cascadeTargets) {
          for (const ct of action.cascadeTargets) {
            await up(ct.id, { deadline: ct.newDeadline });
          }
        }
      } else if (action.type === 'complete' && action.taskId) {
        await up(action.taskId, { status: 'done' as AppTask['status'] });
      }
    }

    setAiActions(null);
    setCmdText('');
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

  const { enriched, critical } = calcCriticalPath(tasks);
  const active = tasks.filter((t) => t.status !== 'done');
  const overdue = active.filter((t) => t.deadline && dU(t.deadline) < 0);
  const done = tasks.filter((t) => t.status === 'done');
  const urgent = active.filter((t) => t.priority === 'high');

  const today = todayStr();
  const overdueItems = enriched.filter((t) => t.deadline && t.deadline < today && t.status !== 'done');
  const todayItems = enriched.filter((t) => t.deadline === today && t.status !== 'done');
  const thisWeek = enriched.filter((t) => {
    if (!t.deadline || t.status === 'done') return false;
    const d = dU(t.deadline);
    return d > 0 && d <= 7;
  });

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

      {/* ─── AI COMMAND BAR (sticky) ─── */}
      <div style={S.cmdBar}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start', width: '100%' }}>
          <textarea
            ref={cmdRef}
            value={cmdText}
            onChange={(e) => setCmdText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                handleCmdSubmit();
              }
            }}
            placeholder="무엇이든 입력하세요 — 회의록, 상황 업데이트, 질문 등 (Enter로 전송)"
            rows={1}
            style={{
              ...S.cmdInput,
              minHeight: cmdText.includes('\n') ? 60 : 36,
            }}
          />
          <button
            onClick={handleCmdSubmit}
            disabled={!cmdText.trim() || aiProcessing}
            style={{
              ...S.cmdAddBtn,
              opacity: !cmdText.trim() || aiProcessing ? 0.5 : 1,
              minWidth: 56,
            }}
          >
            {aiProcessing ? '⏳' : '전송'}
          </button>
        </div>

        {/* AI Processing indicator */}
        {aiProcessing && (
          <div style={{ padding: '8px 12px', fontSize: 12, color: '#5F4B82', background: '#EFEBFA', borderRadius: 2, marginTop: 8, display: 'flex', alignItems: 'center', gap: 6 }}>
            <span style={{ animation: 'fadeUp .6s ease-in-out infinite alternate' }}>🤖</span>
            AI가 분석 중입니다...
          </div>
        )}

        {/* AI Actions Preview */}
        {aiActions && aiActions.length > 0 && (
          <div style={{ marginTop: 8, border: '1px solid #A896C4', borderRadius: 2, background: '#FDFBF7', overflow: 'hidden' }}>
            <div style={{ padding: '10px 14px', background: '#EFEBFA', borderBottom: '1px solid #A896C4', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 13, color: '#5F4B82' }}>
                🤖 이렇게 반영할게요
              </span>
              <button onClick={() => setAiActions(null)} style={{ background: 'none', border: 'none', color: '#8A7D72', fontSize: 16, cursor: 'pointer', padding: 0 }}>×</button>
            </div>
            <div style={{ padding: '8px 14px', display: 'flex', flexDirection: 'column', gap: 6, maxHeight: 300, overflowY: 'auto' }}>
              {aiActions.map((action, i) => (
                <div key={i} style={{
                  padding: '8px 10px',
                  borderLeft: `3px solid ${
                    action.type === 'create' ? '#A8C496' :
                    action.type === 'update' ? '#5F4B82' :
                    action.type === 'complete' ? '#A8C496' :
                    '#DDD3C2'
                  }`,
                  background: action.type === 'info' ? '#FAF6EF' : '#fff',
                  borderRadius: 2,
                  fontSize: 12,
                }}>
                  {action.type === 'create' && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, background: '#EBF3E6', color: '#3E5A2E', fontWeight: 500 }}>새로 만들기</span>
                        <span style={{ fontWeight: 400 }}>{action.newTask?.title}</span>
                      </div>
                      <div style={{ fontSize: 10, color: '#8A7D72' }}>
                        {action.newTask?.category} · {action.newTask?.owner || '공동'} · {action.newTask?.deadline ? fD(action.newTask.deadline) : '마감일 없음'} · {action.newTask?.priority === 'high' ? '🔴 긴급' : action.newTask?.priority || 'medium'}
                      </div>
                      {action.reason && <div style={{ fontSize: 10, color: '#5F4B82', marginTop: 2, fontStyle: 'italic' }}>{action.reason}</div>}
                    </div>
                  )}
                  {action.type === 'update' && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 3 }}>
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, background: '#EFEBFA', color: '#5F4B82', fontWeight: 500 }}>수정</span>
                        <span style={{ fontWeight: 400 }}>{action.taskTitle || action.taskId}</span>
                      </div>
                      <div style={{ fontSize: 10, color: '#8A7D72' }}>
                        {action.changes && Object.entries(action.changes).filter(([k]) => k !== 'deadlineShift').map(([k, v]) => {
                          const labels: Record<string, string> = { deadline: '마감일', status: '상태', priority: '우선순위', owner: '담당', note: '메모', category: '카테고리', project: '프로젝트' };
                          const val = k === 'status' ? SL[v as string] || v : k === 'deadline' ? fD(v as string) : v;
                          return `${labels[k] || k}: ${val}`;
                        }).join(' · ')}
                      </div>
                      {action.cascadeTargets && action.cascadeTargets.length > 0 && (
                        <div style={{ marginTop: 4, padding: '4px 8px', background: '#FEF5F3', borderRadius: 2, fontSize: 10, color: '#B84848' }}>
                          ⚠ 연쇄 이동: {action.cascadeTargets.map(ct => `${ct.title} ${fD(ct.oldDeadline)}→${fD(ct.newDeadline)}`).join(', ')}
                        </div>
                      )}
                      {action.reason && <div style={{ fontSize: 10, color: '#5F4B82', marginTop: 2, fontStyle: 'italic' }}>{action.reason}</div>}
                    </div>
                  )}
                  {action.type === 'complete' && (
                    <div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ fontSize: 10, padding: '1px 6px', borderRadius: 100, background: '#EBF3E6', color: '#3E5A2E', fontWeight: 500 }}>✓ 완료</span>
                        <span style={{ fontWeight: 400 }}>{action.taskTitle || action.taskId}</span>
                      </div>
                      {action.reason && <div style={{ fontSize: 10, color: '#5F4B82', marginTop: 2, fontStyle: 'italic' }}>{action.reason}</div>}
                    </div>
                  )}
                  {action.type === 'info' && (
                    <div style={{ color: '#4A3F38', lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>
                      {action.message}
                    </div>
                  )}
                </div>
              ))}
            </div>
            {aiActions.some(a => a.type !== 'info') && (
              <div style={{ padding: '8px 14px', borderTop: '1px solid #E8DFCE', display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                <button onClick={() => setAiActions(null)} style={{ padding: '6px 14px', background: 'transparent', border: '1px solid #DDD3C2', color: '#8A7D72', borderRadius: 2, fontSize: 11, cursor: 'pointer' }}>
                  취소
                </button>
                <button onClick={applyAiActions} style={{ padding: '6px 18px', background: '#5F4B82', border: 'none', color: '#FAF6EF', borderRadius: 2, fontSize: 12, fontWeight: 500, cursor: 'pointer' }}>
                  ✓ 반영하기
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* ─── FILTERS ─── */}
      <div style={S.filterBar}>
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
        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
          <button
            onClick={() => { setSelectMode(!selectMode); if (selectMode) setSelectedIds(new Set()); }}
            style={{ ...S.toolBtn, background: selectMode ? '#5F4B82' : '#FAF6EF', color: selectMode ? '#fff' : '#5F4B82' }}
          >
            {selectMode ? '선택 해제' : '선택'}
          </button>
          <button onClick={() => setAnalyzeMode(true)} style={S.toolBtn}>AI 분석</button>
        </div>
      </div>

      {/* ─── STATS (compact) ─── */}
      <div style={S.stats}>
        <div style={{ ...S.st, borderLeftColor: '#B84848' }}>
          <span style={{ ...S.stN, color: overdue.length ? '#B84848' : '#8A7D72' }}>{overdue.length}</span>
          <span style={S.stL}>지연</span>
        </div>
        <div style={{ ...S.st, borderLeftColor: '#C49696' }}>
          <span style={{ ...S.stN, color: urgent.length ? '#B84848' : '#8A7D72' }}>{urgent.length}</span>
          <span style={S.stL}>긴급</span>
        </div>
        <div style={{ ...S.st, borderLeftColor: '#5F4B82' }}>
          <span style={S.stN}>{active.length}</span>
          <span style={S.stL}>진행</span>
        </div>
        <div style={{ ...S.st, borderLeftColor: '#A8C496' }}>
          <span style={S.stN}>{done.length}/{tasks.length}</span>
          <span style={S.stL}>완료</span>
        </div>
      </div>

      {/* ─── SECTION 1: CRITICAL PATH ─── */}
      {critical.filter((t) => t.blocksCount > 0).length > 0 && (
        <div style={S.critBox}>
          <div style={S.critHead}>
            <div style={S.critLabel}>CRITICAL PATH</div>
            <div style={S.critTitle}>이거 안 끝내면 뒤에 전부 밀립니다</div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {critical.filter((t) => t.blocksCount > 0).slice(0, 5).map((t) => (
              <TaskCard
                key={t.id} t={t} compact
                selectMode={selectMode} selected={selectedIds.has(t.id)}
                onSelect={() => toggleSelect(t.id)}
                onEdit={() => setEditId(t.id)}
                onCycleStatus={() => cycleStatus(t.id)}
                onCycleOwner={() => cycleOwner(t.id)}
                onCyclePriority={() => cyclePriority(t.id)}
                onDateClick={(e) => { setDatePickerId(t.id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
                extra={<span style={S.critChain}>{t.blocksCount}개 차단</span>}
              />
            ))}
          </div>
        </div>
      )}

      {/* ─── SECTION 2: URGENCY GROUPS ─── */}
      {[
        { key: 'overdue', label: '지연', sub: '마감일이 지났습니다', items: overdueItems, color: '#B84848' },
        { key: 'today', label: '오늘', sub: '오늘 반드시', items: todayItems, color: '#5F4B82' },
        { key: 'week', label: '이번 주', sub: '7일 이내', items: thisWeek, color: '#8B5A3C' },
      ].map(
        (sec) =>
          sec.items.length > 0 && (
            <div key={sec.key} style={{ ...S.secBox, borderColor: sec.color }}>
              <div style={{ ...S.secHead, background: sec.color + '11' }}>
                <span style={{ ...S.secTitle, color: sec.color }}>{sec.label}</span>
                <span style={S.secSub}>{sec.sub}</span>
                <span style={{ ...S.secCount, color: sec.color }}>{sec.items.length}</span>
              </div>
              <div style={S.secBody}>
                {sec.items.map((t) => (
                  <TaskCard
                    key={t.id} t={t}
                    selectMode={selectMode} selected={selectedIds.has(t.id)}
                    onSelect={() => toggleSelect(t.id)}
                    onEdit={() => setEditId(t.id)}
                    onCycleStatus={() => cycleStatus(t.id)}
                    onCycleOwner={() => cycleOwner(t.id)}
                    onCyclePriority={() => cyclePriority(t.id)}
                    onDateClick={(e) => { setDatePickerId(t.id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
                  />
                ))}
              </div>
            </div>
          )
      )}

      {/* ─── SECTION 3: WEEKLY TIMELINE ─── */}
      <CollapsibleSection
        title="이번 주 타임라인"
        sectionKey="weekly"
        collapsed={!!collapsed.weekly}
        onToggle={() => toggleCollapse('weekly')}
      >
        <WeeklyTimeline tasks={filtered} onEdit={setEditId} onDateChange={handleDateChange} />
      </CollapsibleSection>

      {/* ─── SECTION 4: PROJECT PROGRESS ─── */}
      <CollapsibleSection
        title="프로젝트 진행률"
        sectionKey="progress"
        collapsed={!!collapsed.progress}
        onToggle={() => toggleCollapse('progress')}
      >
        <ProjectProgress
          tasks={filtered} allTasks={tasks}
          selectMode={selectMode} selectedIds={selectedIds}
          onSelect={toggleSelect}
          onEdit={setEditId}
          onCycleStatus={cycleStatus}
          onCycleOwner={cycleOwner}
          onCyclePriority={cyclePriority}
          onDateClick={(id, e) => { setDatePickerId(id); setDatePickerPos({ top: e.clientY, left: e.clientX }); }}
        />
      </CollapsibleSection>

      {/* ─── SECTION 5: KANBAN BOARD ─── */}
      <CollapsibleSection
        title="칸반 보드"
        sectionKey="kanban"
        collapsed={!!collapsed.kanban}
        onToggle={() => toggleCollapse('kanban')}
      >
        <BoardView
          tasks={filtered}
          selectMode={selectMode} selectedIds={selectedIds}
          onSelect={toggleSelect}
          onEdit={setEditId}
          onCycleStatus={cycleStatus}
          onCycleOwner={cycleOwner}
          onCyclePriority={cyclePriority}
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

      {/* ─── MODALS ─── */}
      {editId && (
        <Editor
          task={tasks.find((t) => t.id === editId)}
          onClose={() => setEditId(null)}
          onSave={(t) => { up(editId, t); setEditId(null); }}
          onDelete={() => { del(editId); setEditId(null); }}
          allTasks={tasks}
        />
      )}
      {analyzeMode && (
        <AnalyzeModal
          tasks={tasks}
          onClose={() => setAnalyzeMode(false)}
          onApply={(depsMap) => { applyDeps(depsMap); setAnalyzeMode(false); }}
        />
      )}

      <footer style={S.footer}>
        <span>PEACER</span>
        <button onClick={() => { if (confirm('새로고침?')) fetchTasks(); }} style={S.fLink}>새로고침</button>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>v7</span>
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// TASK CARD — unified card component with inline toggles
// ═══════════════════════════════════════════════════
function TaskCard({
  t, compact, selectMode, selected, onSelect, onEdit, onCycleStatus, onCycleOwner, onCyclePriority, onDateClick, extra,
}: {
  t: AppTask;
  compact?: boolean;
  selectMode: boolean;
  selected: boolean;
  onSelect: () => void;
  onEdit: () => void;
  onCycleStatus: () => void;
  onCycleOwner: () => void;
  onCyclePriority: () => void;
  onDateClick: (e: React.MouseEvent) => void;
  extra?: React.ReactNode;
}) {
  const c = CC[t.category] || CC['기타'];
  const [flash, setFlash] = useState<string | null>(null);

  const handleStatusClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCycleStatus();
    setFlash('status');
    setTimeout(() => setFlash(null), 300);
  };

  const handleOwnerClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCycleOwner();
  };

  const handlePriorityClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onCyclePriority();
  };

  const handleDateClickLocal = (e: React.MouseEvent) => {
    e.stopPropagation();
    onDateClick(e);
  };

  return (
    <div
      onClick={() => selectMode ? onSelect() : onEdit()}
      onDoubleClick={() => { if (!selectMode) onEdit(); }}
      style={{
        ...S.card,
        borderLeftColor: c.bd,
        opacity: t.status === 'done' ? 0.55 : 1,
        outline: selected ? '2px solid #5F4B82' : 'none',
        outlineOffset: -2,
      }}
    >
      <div style={S.cTop}>
        {selectMode && (
          <span style={{ ...S.pChk, background: selected ? '#5F4B82' : 'transparent', borderColor: selected ? '#5F4B82' : '#DDD3C2', color: '#fff', marginRight: 2 }}>
            {selected ? '✓' : ''}
          </span>
        )}
        <span style={{ ...S.catB, background: c.bg, color: c.tx }}>{t.category}</span>
        {t.project && <span style={S.projB}>{t.project}</span>}
        <span
          onClick={handlePriorityClick}
          style={{ fontSize: 9, cursor: 'pointer', opacity: t.priority === 'low' ? 0.4 : 1 }}
          title={`우선순위: ${t.priority}`}
        >
          {t.priority === 'high' ? '🔴' : t.priority === 'low' ? '🔵' : '⚪'}
        </span>
        {extra}
        <span
          onClick={handleOwnerClick}
          style={{
            ...S.ownB,
            marginLeft: 'auto',
            cursor: 'pointer',
            background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2',
            color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38',
          }}
        >
          {t.owner}
        </span>
      </div>
      <div style={{ ...S.cTitle, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</div>
      {!compact && t.note && <div style={S.cNote}>{t.note}</div>}
      <div style={S.cBot}>
        {t.deadline ? (
          <span
            onClick={handleDateClickLocal}
            style={{
              ...S.cDate,
              color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72',
              cursor: 'pointer',
              background: dU(t.deadline) < 0 ? '#FBEDEA' : '#FAF6EF',
              padding: '1px 6px',
              borderRadius: 100,
              border: '1px solid ' + (dU(t.deadline) < 0 ? '#D4A4A4' : '#E8DFCE'),
            }}
          >
            {fD(t.deadline)}
            {dU(t.deadline) !== 0 && <span style={{ fontSize: 8, marginLeft: 3 }}>{dU(t.deadline) < 0 ? `D+${Math.abs(dU(t.deadline))}` : `D-${dU(t.deadline)}`}</span>}
          </span>
        ) : (
          <span
            onClick={handleDateClickLocal}
            style={{ fontSize: 10, color: '#CCBFA8', cursor: 'pointer', fontStyle: 'italic' }}
          >
            날짜 없음
          </span>
        )}
        <span
          onClick={handleStatusClick}
          style={{
            ...S.stBadge,
            background: SC[t.status]?.bg,
            color: SC[t.status]?.tx,
            border: `1px solid ${SC[t.status]?.bd}`,
            cursor: 'pointer',
            transition: 'all .15s',
            transform: flash === 'status' ? 'scale(1.15)' : 'scale(1)',
          }}
        >
          {SL[t.status]}
        </span>
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
// WEEKLY TIMELINE
// ═══════════════════════════════════════════════════
function WeeklyTimeline({
  tasks, onEdit, onDateChange,
}: {
  tasks: AppTask[];
  onEdit: (id: string) => void;
  onDateChange: (taskId: string, newDate: string) => void;
}) {
  const weekDays = useMemo(() => getWeekDays(), []);
  const active = tasks.filter((t) => t.status !== 'done');
  const [dragOver, setDragOver] = useState<string | null>(null);

  const tasksByOwnerDay: Record<string, Record<string, AppTask[]>> = {};
  OWNERS.forEach((o) => {
    tasksByOwnerDay[o] = {};
    weekDays.forEach((d) => { tasksByOwnerDay[o][d.str] = []; });
  });
  active.forEach((t) => {
    if (t.deadline) {
      const matchDay = weekDays.find((d) => d.str === t.deadline);
      if (matchDay && tasksByOwnerDay[t.owner]) {
        tasksByOwnerDay[t.owner][matchDay.str].push(t);
      }
    }
  });

  const todayS = todayStr();

  return (
    <div style={{ overflowX: 'auto' }}>
      <div style={{ display: 'grid', gridTemplateColumns: `60px repeat(7, 1fr)`, minWidth: 500, gap: 0 }}>
        {/* Header row */}
        <div style={S.wkCell} />
        {weekDays.map((d) => (
          <div
            key={d.str}
            style={{
              ...S.wkCell,
              ...S.wkHead,
              background: d.str === todayS ? '#EFEBFA' : '#FAF6EF',
              fontWeight: d.str === todayS ? 600 : 400,
              color: d.str === todayS ? '#5F4B82' : '#8A7D72',
            }}
          >
            <div style={{ fontSize: 10 }}>{d.label}</div>
            <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 13 }}>{d.date.getDate()}</div>
          </div>
        ))}

        {/* Owner rows */}
        {OWNERS.map((owner) => (
          <React.Fragment key={owner}>
            <div style={{ ...S.wkCell, fontWeight: 500, fontSize: 11, color: owner === '풍성' ? '#5F4B82' : owner === '은채' ? '#8B5A3C' : '#4A3F38', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {owner}
            </div>
            {weekDays.map((d) => {
              const dayTasks = tasksByOwnerDay[owner]?.[d.str] || [];
              const isOver = dragOver === `${owner}-${d.str}`;
              return (
                <div
                  key={d.str}
                  style={{
                    ...S.wkCell,
                    ...S.wkBody,
                    background: isOver ? '#EFEBFA' : d.str === todayS ? '#FDFBF7' : '#fff',
                    minHeight: 40,
                  }}
                  onDragOver={(e) => { e.preventDefault(); setDragOver(`${owner}-${d.str}`); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={(e) => {
                    e.preventDefault();
                    setDragOver(null);
                    const taskId = e.dataTransfer.getData('text/plain');
                    if (taskId) onDateChange(taskId, d.str);
                  }}
                >
                  {dayTasks.map((t) => {
                    const c = CC[t.category] || CC['기타'];
                    return (
                      <div
                        key={t.id}
                        draggable
                        onDragStart={(e) => { e.dataTransfer.setData('text/plain', t.id); }}
                        onClick={() => onEdit(t.id)}
                        style={{
                          fontSize: 10,
                          padding: '2px 5px',
                          background: c.bg,
                          borderLeft: `2px solid ${c.bd}`,
                          borderRadius: 2,
                          marginBottom: 2,
                          cursor: 'grab',
                          whiteSpace: 'nowrap',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          color: c.tx,
                        }}
                        title={t.title}
                      >
                        {t.priority === 'high' && '! '}
                        {t.title}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </React.Fragment>
        ))}
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

  const cells = [];
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
// PROJECT PROGRESS
// ═══════════════════════════════════════════════════
function ProjectProgress({
  tasks, allTasks, selectMode, selectedIds, onSelect, onEdit, onCycleStatus, onCycleOwner, onCyclePriority, onDateClick,
}: {
  tasks: AppTask[];
  allTasks: AppTask[];
  selectMode: boolean;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onCycleStatus: (id: string) => void;
  onCycleOwner: (id: string) => void;
  onCyclePriority: (id: string) => void;
  onDateClick: (id: string, e: React.MouseEvent) => void;
}) {
  const tree: Record<string, Record<string, AppTask[]>> = {};
  tasks.forEach((t) => {
    const cat = t.category || '기타';
    const proj = t.project || '기타';
    if (!tree[cat]) tree[cat] = {};
    if (!tree[cat][proj]) tree[cat][proj] = [];
    tree[cat][proj].push(t);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      {/* Progress bars */}
      <div style={S.catProgress}>
        {CATS.map((cat) => {
          const items = allTasks.filter((t) => t.category === cat);
          if (!items.length) return null;
          const d = items.filter((t) => t.status === 'done').length;
          const pct = Math.round((d / items.length) * 100);
          return (
            <div key={cat} style={S.catProgressItem}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ ...S.catB, background: CC[cat].bg, color: CC[cat].tx, fontSize: 9 }}>{cat}</span>
                <span style={S.cpPct}>{pct}%</span>
                <span style={S.cpCount}>{d}/{items.length}</span>
              </div>
              <div style={S.cpBar}><div style={{ ...S.cpBarIn, width: `${pct}%`, background: CC[cat].bd }} /></div>
            </div>
          );
        }).filter(Boolean)}
      </div>

      {/* Tree */}
      {Object.entries(tree).map(([cat, projects]) => {
        const c = CC[cat] || CC['기타'];
        const catItems = Object.values(projects).flat();
        const catDone = catItems.filter((t) => t.status === 'done').length;
        return (
          <div key={cat} style={{ ...S.treeBox, borderColor: c.bd }}>
            <div style={{ ...S.treeCatHead, background: c.bg }}>
              <span style={{ ...S.treeCatName, color: c.tx }}>{cat}</span>
              <span style={{ ...S.treeCatCount, color: c.tx }}>{catDone}/{catItems.length}</span>
            </div>
            {Object.entries(projects).map(([proj, items]) => {
              const pDone = items.filter((t) => t.status === 'done').length;
              const pPct = Math.round((pDone / items.length) * 100);
              return (
                <div key={proj} style={S.treeProjBox}>
                  <div style={S.treeProjHead}>
                    <span style={S.treeProjName}>{proj}</span>
                    <div style={S.treeProjBar}><div style={{ ...S.cpBarIn, width: `${pPct}%`, background: c.bd }} /></div>
                    <span style={S.treeProjCount}>{pDone}/{items.length}</span>
                  </div>
                  <div style={S.treeProjBody}>
                    {items.sort((a, b) => dU(a.deadline) - dU(b.deadline)).map((t) => (
                      <div
                        key={t.id}
                        onClick={() => selectMode ? onSelect(t.id) : onEdit(t.id)}
                        style={{
                          ...S.treeItem,
                          opacity: t.status === 'done' ? 0.5 : 1,
                          borderLeftColor: t.status === 'done' ? c.bd + '55' : c.bd,
                          outline: selectedIds.has(t.id) ? '2px solid #5F4B82' : 'none',
                        }}
                      >
                        {selectMode && (
                          <span style={{ ...S.pChk, width: 14, height: 14, background: selectedIds.has(t.id) ? '#5F4B82' : 'transparent', borderColor: selectedIds.has(t.id) ? '#5F4B82' : '#DDD3C2', color: '#fff', fontSize: 8 }}>
                            {selectedIds.has(t.id) ? '✓' : ''}
                          </span>
                        )}
                        <span
                          onClick={(e) => { e.stopPropagation(); onCycleStatus(t.id); }}
                          style={{ ...S.stBadge, background: SC[t.status]?.bg, color: SC[t.status]?.tx, cursor: 'pointer', border: `1px solid ${SC[t.status]?.bd}` }}
                        >
                          {SL[t.status]}
                        </span>
                        <span style={{ flex: 1, fontSize: 12, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</span>
                        <span
                          onClick={(e) => { e.stopPropagation(); onCycleOwner(t.id); }}
                          style={{
                            ...S.ownB, fontSize: 9, cursor: 'pointer',
                            background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2',
                            color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38',
                          }}
                        >
                          {t.owner}
                        </span>
                        {t.deadline && (
                          <span
                            onClick={(e) => { e.stopPropagation(); onDateClick(t.id, e); }}
                            style={{ fontSize: 10, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72', fontStyle: 'italic', cursor: 'pointer' }}
                          >
                            {fD(t.deadline)}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// BOARD VIEW
// ═══════════════════════════════════════════════════
function BoardView({
  tasks, selectMode, selectedIds, onSelect, onEdit, onCycleStatus, onCycleOwner, onCyclePriority, onDateClick, dragId, dragCol, onDS, onDO, onDD, onDE,
}: {
  tasks: AppTask[];
  selectMode: boolean;
  selectedIds: Set<string>;
  onSelect: (id: string) => void;
  onEdit: (id: string) => void;
  onCycleStatus: (id: string) => void;
  onCycleOwner: (id: string) => void;
  onCyclePriority: (id: string) => void;
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
                          background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2',
                          color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38',
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
                      <span
                        onClick={(e) => { e.stopPropagation(); onCycleStatus(t.id); }}
                        style={{ ...S.stBadge, background: SC[t.status]?.bg, color: SC[t.status]?.tx, border: `1px solid ${SC[t.status]?.bd}`, cursor: 'pointer' }}
                      >
                        {SL[t.status]}
                      </span>
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
// SYNC MODAL — Text extraction via Claude API
// ═══════════════════════════════════════════════════
function SyncModal({
  onClose, onAdd, existing, initialText, onDone,
}: {
  onClose: () => void;
  onAdd: (arr: Partial<AppTask>[]) => void;
  existing: AppTask[];
  initialText?: string;
  onDone?: () => void;
}) {
  const [text, setText] = useState(initialText || '');
  const [parsing, setParsing] = useState(false);
  const [preview, setPreview] = useState<(Partial<AppTask> & { isDuplicate?: boolean; duplicateOf?: string; selected?: boolean })[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const parse = async () => {
    if (!text.trim()) return;
    setParsing(true);
    setError(null);
    setPreview(null);
    try {
      const el = existing.map((t) => `- "${t.title}"`).join('\n');
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: `Extract actionable todos from text for Peacer shower bomb brand.\n\nEXISTING TASKS:\n${el}\n\nReturn ONLY JSON array:\n[{"title":"concise task","category":"제조|사업자/인허가|마케팅|디자인|계약|기타","project":"project name","owner":"풍성|은채|공동","deadline":"YYYY-MM-DD|null","status":"todo|doing|waiting|done","note":"","priority":"high|medium|low","isDuplicate":bool,"duplicateOf":"existing title|null"}]\n\nRules: today=${new Date().toISOString().slice(0, 10)} year=2026. ~~strikethrough~~=done. Semantically similar to existing=isDuplicate. "4/13"->"2026-04-13". Infer project names.`,
          userMessage: `Extract:\n\n${text}`,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
      let j = (data.content || [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
        .trim()
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      const si = j.indexOf('[');
      const ei = j.lastIndexOf(']');
      if (si === -1) throw new Error('파싱 실패');
      setPreview(
        JSON.parse(j.slice(si, ei + 1)).map((t: Record<string, unknown>) => ({ ...t, selected: !t.isDuplicate }))
      );
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류');
    }
    setParsing(false);
  };

  const toggle = (i: number) => setPreview((p) => p?.map((t, j) => (j === i ? { ...t, selected: !t.selected } : t)) || null);

  return (
    <div style={S.backdrop} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div style={S.mHead}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '.2em', color: '#5F4B82', fontFamily: "'DM Serif Display',serif" }}>SYNC</div>
            <h2 style={S.mTitle}>텍스트에서 할 일 추출</h2>
          </div>
          <button onClick={onClose} style={S.mClose}>x</button>
        </div>
        <div style={S.mBody}>
          <div style={S.hint}>회의록, 카톡, 메모 등을 붙여넣으세요.</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ ...S.input, minHeight: 140, resize: 'vertical', lineHeight: 1.6 }} placeholder="회의 내용을 붙여넣기..." />
          <button onClick={parse} disabled={parsing || !text.trim()} style={{ ...S.syncBtnBig, opacity: parsing || !text.trim() ? 0.5 : 1 }}>
            {parsing ? 'AI 분석 중...' : '추출하기'}
          </button>
          {error && <div style={{ color: '#B84848', fontSize: 12 }}>{error}</div>}
          {preview && (
            <div style={S.prevBox}>
              <div style={{ fontSize: 11, color: '#5F4B82', fontWeight: 500, marginBottom: 8 }}>
                {preview.filter((t) => t.selected).length}개 선택 / {preview.filter((t) => t.isDuplicate).length}개 중복
              </div>
              {preview.map((t, i) => (
                <div key={i} onClick={() => toggle(i)} style={{ ...S.prevItem, opacity: t.selected ? 1 : 0.4, background: t.isDuplicate ? '#FFF5F5' : t.selected ? '#F5FFF5' : '#FAF6EF', borderLeftColor: t.isDuplicate ? '#D4A4A4' : CC[t.category || '기타']?.bd || '#DDD3C2' }}>
                  <span style={{ ...S.pChk, background: t.selected ? '#5F4B82' : 'transparent', borderColor: t.selected ? '#5F4B82' : '#DDD3C2', color: '#fff' }}>
                    {t.selected ? '✓' : ''}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12 }}>{t.title}</div>
                    <div style={{ fontSize: 10, color: '#8A7D72', marginTop: 2 }}>
                      {t.category} / {t.project || '미정'} / {t.owner || '미정'} / {t.deadline ? fD(t.deadline) : '마감일 없음'}
                      {t.isDuplicate && <span style={{ color: '#B84848', marginLeft: 6 }}>~ {t.duplicateOf}</span>}
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => {
                  onAdd(preview.filter((t) => t.selected).map(({ isDuplicate, selected, duplicateOf, ...r }) => r));
                  onDone?.();
                }}
                style={S.confirmBtn}
              >
                {preview.filter((t) => t.selected).length}개 추가
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// AI ANALYZE MODAL
// ═══════════════════════════════════════════════════
function AnalyzeModal({
  tasks, onClose, onApply,
}: {
  tasks: AppTask[];
  onClose: () => void;
  onApply: (depsMap: Record<string, string[]>) => void;
}) {
  const [analyzing, setAnalyzing] = useState(false);
  const [result, setResult] = useState<{ id: string; dependsOn: string[]; reason: string }[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const analyze = async () => {
    setAnalyzing(true);
    setError(null);
    try {
      const tl = tasks
        .filter((t) => t.status !== 'done')
        .map((t) => `- id:"${t.id}" title:"${t.title}" category:${t.category} project:${t.project || '없음'} deadline:${t.deadline || '없음'} status:${t.status}`)
        .join('\n');
      const res = await fetch('/api/claude', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          system: `You analyze task dependencies for Peacer shower bomb brand.\n\nReturn ONLY JSON (no fences):\n{"dependencies":[{"id":"task_id","dependsOn":["other_task_id"],"reason":"1-line why"}]}\n\nRules:\n- Only include tasks that ACTUALLY depend on another task completing first\n- Use business logic\n- Don't create circular dependencies\n- Be conservative`,
          userMessage: `Analyze dependencies:\n\n${tl}`,
        }),
      });
      const data = await res.json();
      if (data.error) throw new Error(typeof data.error === 'string' ? data.error : JSON.stringify(data.error));
      let j = (data.content || [])
        .filter((b: { type: string }) => b.type === 'text')
        .map((b: { text: string }) => b.text)
        .join('')
        .trim()
        .replace(/```json\s*/g, '')
        .replace(/```\s*/g, '')
        .trim();
      const si = j.indexOf('{');
      const ei = j.lastIndexOf('}');
      if (si === -1) throw new Error('파싱 실패');
      const parsed = JSON.parse(j.slice(si, ei + 1));
      setResult(parsed.dependencies || []);
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : '알 수 없는 오류');
    }
    setAnalyzing(false);
  };

  const apply = () => {
    const map: Record<string, string[]> = {};
    (result || []).forEach((d) => { map[d.id] = d.dependsOn; });
    onApply(map);
  };

  const byId: Record<string, AppTask> = {};
  tasks.forEach((t) => { byId[t.id] = t; });

  return (
    <div style={S.backdrop} onClick={onClose}>
      <div style={{ ...S.modal, maxWidth: 600 }} onClick={(e) => e.stopPropagation()}>
        <div style={S.mHead}>
          <div>
            <div style={{ fontSize: 10, letterSpacing: '.2em', color: '#5F4B82', fontFamily: "'DM Serif Display',serif" }}>AI ANALYZE</div>
            <h2 style={S.mTitle}>의존관계 자동 분석</h2>
          </div>
          <button onClick={onClose} style={S.mClose}>x</button>
        </div>
        <div style={S.mBody}>
          <div style={S.hint}>AI가 전체 태스크를 분석해서 의존관계를 자동으로 추론합니다.</div>
          {!result && (
            <button onClick={analyze} disabled={analyzing} style={{ ...S.syncBtnBig, background: '#5F4B82', opacity: analyzing ? 0.5 : 1 }}>
              {analyzing ? 'AI 분석 중...' : '의존관계 분석 시작'}
            </button>
          )}
          {error && <div style={{ color: '#B84848', fontSize: 12 }}>{error}</div>}
          {result && (
            <div style={S.prevBox}>
              <div style={{ fontSize: 11, color: '#5F4B82', fontWeight: 500, marginBottom: 8 }}>{result.length}개 의존관계 발견</div>
              {result.map((d, i) => {
                const task = byId[d.id];
                if (!task) return null;
                return (
                  <div key={i} style={{ ...S.prevItem, borderLeftColor: '#A896C4', background: '#FDFBF7' }}>
                    <div style={{ flex: 1 }}>
                      <div style={{ fontSize: 12, fontWeight: 400 }}>{task.title}</div>
                      <div style={{ fontSize: 10, color: '#5F4B82', marginTop: 2 }}>{'<-'} {d.dependsOn.map((did) => byId[did]?.title || did).join(', ')}</div>
                      <div style={{ fontSize: 10, color: '#8A7D72', marginTop: 1, fontStyle: 'italic' }}>{d.reason}</div>
                    </div>
                  </div>
                );
              })}
              <button onClick={apply} style={S.confirmBtn}>의존관계 적용하기</button>
            </div>
          )}
        </div>
      </div>
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
  const projects = [...new Set(allTasks.map((t) => t.project).filter(Boolean))];
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
              <datalist id="proj-list">{projects.map((p) => <option key={p!} value={p!} />)}</datalist>
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
  },
  cmdInput: {
    flex: 1, padding: '8px 12px', background: '#fff', border: '1px solid #DDD3C2', borderRadius: 2,
    fontSize: 13, color: '#1A1613', outline: 'none', fontWeight: 300, fontFamily: "'IBM Plex Sans KR',sans-serif",
    resize: 'none', lineHeight: 1.5,
  },
  cmdAiBtn: {
    padding: '8px 14px', background: 'linear-gradient(135deg,#5F4B82,#8B7AAD)', color: '#FAF6EF',
    border: 'none', borderRadius: 2, fontSize: 12, fontWeight: 500, whiteSpace: 'nowrap',
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
  // Critical
  critBox: { background: 'linear-gradient(135deg,#FEF5F3,#FBEDEA)', border: '1px solid #D4A4A4', borderRadius: 2, padding: '12px 14px', margin: '0 14px', animation: 'fadeUp .4s ease-out' },
  critHead: { marginBottom: 8 },
  critLabel: { fontFamily: "'DM Serif Display',serif", fontSize: 10, letterSpacing: '.2em', color: '#B84848', marginBottom: 2 },
  critTitle: { fontFamily: "'DM Serif Display',serif", fontSize: 14, fontWeight: 400 },
  critChain: { fontSize: 9, padding: '1px 6px', borderRadius: 100, background: '#FBEDEA', color: '#B84848', fontWeight: 500 },
  // Sections
  secBox: { border: '1px solid', borderRadius: 2, overflow: 'hidden', margin: '0 14px' },
  secHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px' },
  secTitle: { fontFamily: "'DM Serif Display',serif", fontSize: 13 },
  secSub: { fontSize: 10, color: '#8A7D72', fontStyle: 'italic' },
  secCount: { marginLeft: 'auto', fontFamily: "'DM Serif Display',serif", fontSize: 18, fontWeight: 400 },
  secBody: { padding: 6, display: 'flex', flexDirection: 'column', gap: 4 },
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
  projB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, background: '#F5F1EA', color: '#4A3F38', border: '1px solid #E8DFCE' },
  ownB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, whiteSpace: 'nowrap' },
  cTitle: { fontSize: 12, fontWeight: 400, lineHeight: 1.4, marginBottom: 2 },
  cNote: { fontSize: 10, color: '#8A7D72', fontStyle: 'italic', lineHeight: 1.4, marginBottom: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' },
  cBot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 },
  cDate: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 10 },
  stBadge: { fontSize: 9, padding: '2px 7px', borderRadius: 100, fontWeight: 500 },
  // Board
  board: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: 6 },
  col: { border: '1px solid', borderRadius: 2, minHeight: 120, display: 'flex', flexDirection: 'column', transition: 'all .2s' },
  colH: { padding: '6px 10px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid' },
  colB: { padding: 5, display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minHeight: 40 },
  empty: { textAlign: 'center' as const, padding: '12px 0', color: '#CCBFA8', fontStyle: 'italic', fontSize: 11 },
  // Progress
  catProgress: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(130px,1fr))', gap: 6, padding: '10px 12px', background: '#FAF6EF', border: '1px solid #DDD3C2', borderRadius: 2, marginBottom: 6 },
  catProgressItem: {},
  cpPct: { fontFamily: "'DM Serif Display',serif", fontSize: 12, color: '#1A1613' },
  cpCount: { fontSize: 10, color: '#8A7D72', fontStyle: 'italic' },
  cpBar: { width: '100%', height: 3, background: '#E8DFCE', borderRadius: 100, overflow: 'hidden', marginTop: 3 },
  cpBarIn: { height: '100%', borderRadius: 100, transition: 'width .5s ease' },
  treeBox: { border: '1px solid', borderRadius: 2, overflow: 'hidden', marginBottom: 3 },
  treeCatHead: { padding: '6px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  treeCatName: { fontFamily: "'DM Serif Display',serif", fontSize: 13, fontWeight: 400 },
  treeCatCount: { fontFamily: "'DM Serif Display',serif", fontSize: 15 },
  treeProjBox: { borderTop: '1px solid #EFE7D6' },
  treeProjHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '6px 12px', background: '#FDFBF7' },
  treeProjName: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#4A3F38', minWidth: 70 },
  treeProjBar: { flex: 1, height: 3, background: '#E8DFCE', borderRadius: 100, overflow: 'hidden' },
  treeProjCount: { fontSize: 10, color: '#8A7D72', fontStyle: 'italic', minWidth: 28, textAlign: 'right' as const },
  treeProjBody: { padding: '3px 6px 6px' },
  treeItem: { display: 'flex', alignItems: 'center', gap: 5, padding: '5px 8px', borderLeft: '2px solid #DDD3C2', borderRadius: 2, cursor: 'pointer', marginBottom: 2, transition: 'all .1s', flexWrap: 'wrap' },
  // Weekly timeline
  wkCell: { padding: '4px 3px', borderRight: '1px solid #E8DFCE', borderBottom: '1px solid #E8DFCE' },
  wkHead: { textAlign: 'center' as const },
  wkBody: { display: 'flex', flexDirection: 'column', gap: 1 },
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
  hint: { fontSize: 12, color: '#8A7D72', lineHeight: 1.5, padding: '6px 10px', background: '#EFEBFA', borderRadius: 2, borderLeft: '3px solid #A896C4' },
  syncBtnBig: { padding: '10px 20px', background: '#1A1613', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 13, fontWeight: 500, width: '100%', marginTop: 4 },
  prevBox: { marginTop: 6, border: '1px solid #E8DFCE', borderRadius: 2, padding: 8, maxHeight: 280, overflowY: 'auto' },
  prevItem: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '6px 8px', borderLeft: '3px solid', borderRadius: 2, cursor: 'pointer', marginBottom: 3 },
  pChk: { width: 16, height: 16, borderRadius: 2, border: '1.5px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0, marginTop: 1 },
  confirmBtn: { padding: '10px 20px', background: '#5F4B82', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 13, fontWeight: 500, width: '100%', marginTop: 8 },
  footer: { padding: '12px 14px', borderTop: '1px solid #DDD3C2', display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#8A7D72', marginTop: 'auto' },
  fLink: { background: 'transparent', border: 'none', fontSize: 10, color: '#B84848', textDecoration: 'underline', padding: 0, fontFamily: 'inherit', fontStyle: 'italic' },
};

