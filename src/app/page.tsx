'use client';

import { useState, useEffect, useCallback } from 'react';
import { supabase, dbToApp, appToDb } from '@/lib/supabase';
import { CATS, CC, STS, SL, SC, OWNERS, MST, OKR, dU, fD, uid } from '@/lib/constants';
import { calcCriticalPath, AppTask } from '@/lib/criticalPath';

// ═══════════════════════════════════════════════════
// MAIN APP
// ═══════════════════════════════════════════════════
export default function App() {
  const [tasks, setTasks] = useState<AppTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState('today');
  const [editId, setEditId] = useState<string | null>(null);
  const [addMode, setAddMode] = useState(false);
  const [syncMode, setSyncMode] = useState(false);
  const [analyzeMode, setAnalyzeMode] = useState(false);
  const [fCat, setFCat] = useState('all');
  const [fOwn, setFOwn] = useState('all');
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragCol, setDragCol] = useState<string | null>(null);
  const [realtimeStatus, setRealtimeStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');

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

  if (!loaded) {
    return (
      <div style={{ ...S.root, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <div style={{ fontFamily: "'DM Serif Display',serif", fontSize: 24, marginBottom: 8 }}>PEACER</div>
          <div style={{ fontSize: 13, color: '#8A7D72' }}>불러오는 중...</div>
        </div>
      </div>
    );
  }

  return (
    <div style={S.root}>
      <style>{CSS}</style>

      {/* HEADER */}
      <header style={S.header}>
        <div style={S.hL}>
          <div style={S.brand}>
            <span style={S.dot} />
            <span style={S.bTxt}>PEACER</span>
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                background: realtimeStatus === 'connected' ? '#A8C496' : realtimeStatus === 'error' ? '#B84848' : '#DDD3C2',
                display: 'inline-block',
                marginLeft: 4,
              }}
              title={realtimeStatus === 'connected' ? '실시간 연결됨' : realtimeStatus === 'error' ? '연결 오류' : '연결 중...'}
            />
          </div>
          <h1 style={S.h1}>런칭 타임라인</h1>
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

      {/* OKR BAR */}
      <div style={S.okr}>
        <span style={S.okrLabel}>Q2 OKR</span>
        <span style={S.okrText}>{OKR.objective}</span>
      </div>

      {/* STATS */}
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
          <span style={S.stN}>
            {done.length}/{tasks.length}
          </span>
          <span style={S.stL}>완료</span>
        </div>
      </div>

      {/* CONTROLS */}
      <div style={S.ctrl}>
        <div style={S.tabs}>
          {(
            [
              ['today', '⚡ 오늘'],
              ['project', '📁 프로젝트'],
              ['board', '📋 보드'],
              ['roadmap', '🗺 로드맵'],
            ] as const
          ).map(([k, l]) => (
            <button key={k} onClick={() => setView(k)} style={{ ...S.tab, ...(view === k ? S.tabOn : {}) }}>
              {l}
            </button>
          ))}
        </div>
        <div style={S.filters}>
          <select value={fCat} onChange={(e) => setFCat(e.target.value)} style={S.sel}>
            <option value="all">전체</option>
            {CATS.map((c) => (
              <option key={c}>{c}</option>
            ))}
          </select>
          <select value={fOwn} onChange={(e) => setFOwn(e.target.value)} style={S.sel}>
            <option value="all">전체</option>
            {OWNERS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </div>
        <button onClick={() => setSyncMode(true)} style={S.syncBtn}>
          📋 텍스트 추가
        </button>
        <button onClick={() => setAnalyzeMode(true)} style={S.aiBtn}>
          🔗 AI 분석
        </button>
        <button onClick={() => setAddMode(true)} style={S.addBtn}>
          +
        </button>
      </div>

      {/* VIEWS */}
      {view === 'today' && (
        <TodayView tasks={tasks} enriched={enriched} critical={critical} onEdit={setEditId} onSt={(id, s) => up(id, { status: s as AppTask['status'] })} />
      )}
      {view === 'project' && <ProjectView tasks={filtered} allTasks={tasks} onEdit={setEditId} />}
      {view === 'board' && (
        <BoardView
          tasks={filtered}
          onEdit={setEditId}
          onSt={(id, s) => up(id, { status: s as AppTask['status'] })}
          dragId={dragId}
          dragCol={dragCol}
          onDS={(id) => setDragId(id)}
          onDO={(s) => (e: React.DragEvent) => { e.preventDefault(); setDragCol(s); }}
          onDD={(s) => () => { if (dragId) up(dragId, { status: s as AppTask['status'] }); setDragId(null); setDragCol(null); }}
          onDE={() => { setDragId(null); setDragCol(null); }}
        />
      )}
      {view === 'roadmap' && <RoadmapView tasks={filtered} allTasks={tasks} onEdit={setEditId} />}

      {/* MODALS */}
      {addMode && (
        <Editor
          onClose={() => setAddMode(false)}
          onSave={(t) => { add(t); setAddMode(false); }}
          allTasks={tasks}
        />
      )}
      {editId && (
        <Editor
          task={tasks.find((t) => t.id === editId)}
          onClose={() => setEditId(null)}
          onSave={(t) => { up(editId, t); setEditId(null); }}
          onDelete={() => { del(editId); setEditId(null); }}
          allTasks={tasks}
        />
      )}
      {syncMode && (
        <SyncModal
          onClose={() => setSyncMode(false)}
          onAdd={(arr) => { addBatch(arr); setSyncMode(false); }}
          existing={tasks}
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
        <span>풍성 · 은채</span>
        <button onClick={() => { if (confirm('초기화?')) fetchTasks(); }} style={S.fLink}>
          새로고침
        </button>
        <span style={{ marginLeft: 'auto', opacity: 0.5 }}>
          v6 · {realtimeStatus === 'connected' ? '🟢 실시간' : '⏳ 연결중'}
        </span>
      </footer>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// TODAY VIEW — The Battle Plan
// ═══════════════════════════════════════════════════
function TodayView({
  tasks, enriched, critical, onEdit, onSt,
}: {
  tasks: AppTask[];
  enriched: AppTask[];
  critical: AppTask[];
  onEdit: (id: string) => void;
  onSt: (id: string, s: string) => void;
}) {
  const today = new Date().toISOString().slice(0, 10);
  const overdueItems = enriched.filter((t) => t.deadline && t.deadline < today && t.status !== 'done');
  const todayItems = enriched.filter((t) => t.deadline === today && t.status !== 'done');
  const thisWeek = enriched.filter((t) => {
    if (!t.deadline || t.status === 'done') return false;
    const d = dU(t.deadline);
    return d > 0 && d <= 7;
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
      {critical.filter((t) => t.blocksCount > 0).length > 0 && (
        <div style={S.critBox}>
          <div style={S.critHead}>
            <div>
              <div style={S.critLabel}>🔥 CRITICAL PATH</div>
              <div style={S.critTitle}>이거 안 끝내면 뒤에 전부 밀립니다</div>
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
            {critical
              .filter((t) => t.blocksCount > 0)
              .slice(0, 5)
              .map((t) => {
                const c = CC[t.category] || CC['기타'];
                return (
                  <div key={t.id} onClick={() => onEdit(t.id)} style={S.critItem}>
                    <div style={S.critItemLeft}>
                      <span style={{ ...S.catB, background: c.bg, color: c.tx }}>{t.category}</span>
                      <span style={S.critItemTitle}>{t.title}</span>
                    </div>
                    <div style={S.critItemRight}>
                      <span style={S.critChain}>→ {t.blocksCount}개 밀림</span>
                      {t.deadline && (
                        <span style={{ ...S.critDate, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72' }}>
                          {fD(t.deadline)}
                        </span>
                      )}
                      {t.owner && (
                        <span
                          style={{
                            ...S.ownB,
                            fontSize: 9,
                            background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2',
                            color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38',
                          }}
                        >
                          {t.owner}
                        </span>
                      )}
                    </div>
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {[
        { key: 'overdue', label: '⚠ 지연', sub: '마감일이 지났습니다', items: overdueItems, color: '#B84848' },
        { key: 'today', label: '● 오늘', sub: '오늘 반드시', items: todayItems, color: '#5F4B82' },
        { key: 'week', label: '→ 이번 주', sub: '7일 이내', items: thisWeek, color: '#8B5A3C' },
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
                  <MiniCard key={t.id} t={t} onEdit={() => onEdit(t.id)} onSt={(s) => onSt(t.id, s)} />
                ))}
              </div>
            </div>
          )
      )}
    </div>
  );
}

function MiniCard({ t, onEdit, onSt }: { t: AppTask; onEdit: () => void; onSt: (s: string) => void }) {
  const c = CC[t.category] || CC['기타'];
  return (
    <div onClick={onEdit} style={{ ...S.card, borderLeftColor: c.bd }}>
      <div style={S.cTop}>
        <span style={{ ...S.catB, background: c.bg, color: c.tx }}>{t.category}</span>
        {t.project && <span style={S.projB}>{t.project}</span>}
        {t.priority === 'high' && <span style={{ fontSize: 9 }}>🔴</span>}
        {t.blocksCount > 0 && <span style={S.chainB}>→{t.blocksCount}</span>}
        {t.owner && (
          <span
            style={{
              ...S.ownB,
              marginLeft: 'auto',
              background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2',
              color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38',
            }}
          >
            {t.owner}
          </span>
        )}
      </div>
      <div style={S.cTitle}>{t.title}</div>
      {t.note && <div style={S.cNote}>{t.note}</div>}
      <div style={S.cBot}>
        {t.deadline && <span style={{ ...S.cDate, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72' }}>{fD(t.deadline)}</span>}
        <select
          value={t.status}
          onClick={(e) => e.stopPropagation()}
          onChange={(e) => { e.stopPropagation(); onSt(e.target.value); }}
          style={{ ...S.stSel, background: SC[t.status]?.bg, color: SC[t.status]?.tx }}
        >
          {STS.map((s) => (
            <option key={s} value={s}>{SL[s]}</option>
          ))}
        </select>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// PROJECT VIEW
// ═══════════════════════════════════════════════════
function ProjectView({ tasks, allTasks, onEdit }: { tasks: AppTask[]; allTasks: AppTask[]; onEdit: (id: string) => void }) {
  const tree: Record<string, Record<string, AppTask[]>> = {};
  tasks.forEach((t) => {
    const cat = t.category || '기타';
    const proj = t.project || '기타';
    if (!tree[cat]) tree[cat] = {};
    if (!tree[cat][proj]) tree[cat][proj] = [];
    tree[cat][proj].push(t);
  });

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
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
                      <div key={t.id} onClick={() => onEdit(t.id)} style={{ ...S.treeItem, opacity: t.status === 'done' ? 0.5 : 1, borderLeftColor: t.status === 'done' ? c.bd + '55' : c.bd }}>
                        <span style={{ ...S.stBadge, background: SC[t.status]?.bg, color: SC[t.status]?.tx }}>{SL[t.status]}</span>
                        <span style={{ flex: 1, fontSize: 12, textDecoration: t.status === 'done' ? 'line-through' : 'none' }}>{t.title}</span>
                        {t.owner && (
                          <span style={{ ...S.ownB, fontSize: 9, background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2', color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38' }}>
                            {t.owner}
                          </span>
                        )}
                        {t.deadline && <span style={{ fontSize: 10, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72', fontStyle: 'italic' }}>{fD(t.deadline)}</span>}
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
  tasks, onEdit, onSt, dragId, dragCol, onDS, onDO, onDD, onDE,
}: {
  tasks: AppTask[];
  onEdit: (id: string) => void;
  onSt: (id: string, s: string) => void;
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
              {items.map((t) => (
                <div
                  key={t.id}
                  draggable
                  onDragStart={() => onDS(t.id)}
                  onDragEnd={onDE}
                  onClick={() => onEdit(t.id)}
                  style={{
                    ...S.card,
                    borderLeftColor: (CC[t.category] || CC['기타']).bd,
                    opacity: dragId === t.id ? 0.35 : t.status === 'done' ? 0.5 : 1,
                    cursor: 'grab',
                  }}
                >
                  <div style={S.cTop}>
                    <span style={{ ...S.catB, background: (CC[t.category] || CC['기타']).bg, color: (CC[t.category] || CC['기타']).tx }}>{t.category}</span>
                    {t.priority === 'high' && <span style={{ fontSize: 9 }}>🔴</span>}
                    {t.owner && (
                      <span style={{ ...S.ownB, marginLeft: 'auto', background: t.owner === '풍성' ? '#D4C5EA' : t.owner === '은채' ? '#EDD9C4' : '#DDD3C2', color: t.owner === '풍성' ? '#5F4B82' : t.owner === '은채' ? '#8B5A3C' : '#4A3F38' }}>
                        {t.owner}
                      </span>
                    )}
                  </div>
                  <div style={S.cTitle}>{t.title}</div>
                  <div style={S.cBot}>
                    {t.deadline && <span style={{ ...S.cDate, color: dU(t.deadline) < 0 ? '#B84848' : '#8A7D72' }}>{fD(t.deadline)}</span>}
                    <select
                      value={t.status}
                      onClick={(e) => e.stopPropagation()}
                      onChange={(e) => { e.stopPropagation(); onSt(t.id, e.target.value); }}
                      style={{ ...S.stSel, background: SC[t.status]?.bg, color: SC[t.status]?.tx }}
                    >
                      {STS.map((s) => (
                        <option key={s} value={s}>{SL[s]}</option>
                      ))}
                    </select>
                  </div>
                </div>
              ))}
              {!items.length && <div style={S.empty}>—</div>}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════
// ROADMAP VIEW — Gantt chart
// ═══════════════════════════════════════════════════
function RoadmapView({ tasks, allTasks, onEdit }: { tasks: AppTask[]; allTasks: AppTask[]; onEdit: (id: string) => void }) {
  const withDL = tasks.filter((t) => t.deadline);
  if (!withDL.length) return <div style={S.emptyBig}>마감일이 있는 항목이 없습니다</div>;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayStr = today.toISOString().slice(0, 10);
  const dates = withDL.map((t) => t.deadline!).sort();
  const minDate = new Date(Math.min(today.getTime(), new Date(dates[0] + 'T00:00:00').getTime()));
  const maxDate = new Date(Math.max(today.getTime() + 7 * 864e5, new Date(dates[dates.length - 1] + 'T00:00:00').getTime() + 3 * 864e5));

  const sd = minDate.getDay();
  const mo = sd === 0 ? -6 : 1 - sd;
  const gridStart = new Date(minDate);
  gridStart.setDate(gridStart.getDate() + mo);
  const totalDays = Math.ceil((maxDate.getTime() - gridStart.getTime()) / 864e5) + 1;
  const dayWidth = 32;
  const labelWidth = 160;
  const totalWidth = labelWidth + totalDays * dayWidth;

  const days: Date[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(gridStart);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  const weeks: { start: Date; end: Date; span: number }[] = [];
  for (let i = 0; i < days.length; i += 7) {
    const wStart = days[i];
    const wEnd = days[Math.min(i + 6, days.length - 1)];
    const span = Math.min(7, days.length - i);
    weeks.push({ start: wStart, end: wEnd, span });
  }

  type GroupItem =
    | { type: 'cat'; cat: string; total: number; done: number; pct: number }
    | { type: 'proj'; cat: string; proj: string; total: number; done: number; pct: number }
    | { type: 'task'; task: AppTask; cat: string };

  const groups: GroupItem[] = [];
  const tree: Record<string, Record<string, AppTask[]>> = {};
  withDL.forEach((t) => {
    const cat = t.category || '기타';
    const proj = t.project || '기타';
    if (!tree[cat]) tree[cat] = {};
    if (!tree[cat][proj]) tree[cat][proj] = [];
    tree[cat][proj].push(t);
  });

  CATS.forEach((cat) => {
    if (!tree[cat]) return;
    const projs = Object.entries(tree[cat]);
    const catItems = projs.flatMap(([, items]) => items);
    const catDone = catItems.filter((t) => t.status === 'done').length;
    const catPct = Math.round((catDone / catItems.length) * 100);
    groups.push({ type: 'cat', cat, total: catItems.length, done: catDone, pct: catPct });
    projs.forEach(([proj, items]) => {
      const pDone = items.filter((t) => t.status === 'done').length;
      groups.push({ type: 'proj', cat, proj, total: items.length, done: pDone, pct: Math.round((pDone / items.length) * 100) });
      items.sort((a, b) => (a.deadline || '').localeCompare(b.deadline || '')).forEach((t) => {
        groups.push({ type: 'task', task: t, cat });
      });
    });
  });

  const dayPos = (dateStr: string) => {
    const d = new Date(dateStr + 'T00:00:00');
    return Math.round((d.getTime() - gridStart.getTime()) / 864e5) * dayWidth;
  };
  const todayPos = dayPos(todayStr);
  const fmtDay = (d: Date) => `${d.getMonth() + 1}/${d.getDate()}`;
  const ROW_H = 28;
  const CAT_H = 32;
  const PROJ_H = 26;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
      <div style={S.catProgress}>
        {CATS.map((cat) => {
          const items = allTasks.filter((t) => t.category === cat);
          if (!items.length) return null;
          const d = items.filter((t) => t.status === 'done').length;
          const p = Math.round((d / items.length) * 100);
          return (
            <div key={cat} style={S.catProgressItem}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ ...S.catB, background: CC[cat].bg, color: CC[cat].tx, fontSize: 9 }}>{cat}</span>
                <span style={S.cpPct}>{p}%</span>
                <span style={S.cpCount}>{d}/{items.length}</span>
              </div>
              <div style={S.cpBar}><div style={{ ...S.cpBarIn, width: `${p}%`, background: CC[cat].bd }} /></div>
            </div>
          );
        }).filter(Boolean)}
      </div>

      <div style={{ overflowX: 'auto', border: '1px solid #E8DFCE', borderRadius: 2, background: '#fff' }}>
        <div style={{ minWidth: totalWidth, position: 'relative' }}>
          {/* Week header */}
          <div style={{ display: 'flex', borderBottom: '1px solid #E8DFCE', position: 'sticky', top: 0, zIndex: 3, background: '#FAF6EF' }}>
            <div style={{ width: labelWidth, minWidth: labelWidth, padding: '6px 10px', borderRight: '1px solid #E8DFCE', fontFamily: "'DM Serif Display',serif", fontSize: 11, color: '#5F4B82', letterSpacing: '.1em' }}>프로젝트</div>
            <div style={{ display: 'flex', flex: 1 }}>
              {weeks.map((w, i) => (
                <div key={i} style={{ width: w.span * dayWidth, borderRight: '1px solid #EFE7D6', padding: '6px 4px', textAlign: 'center', fontFamily: "'DM Serif Display',serif", fontSize: 11, color: '#8A7D72' }}>
                  {fmtDay(w.start)} — {fmtDay(w.end)}
                </div>
              ))}
            </div>
          </div>

          {/* Day header */}
          <div style={{ display: 'flex', borderBottom: '1px solid #DDD3C2', position: 'sticky', top: 31, zIndex: 3, background: '#FDFBF7' }}>
            <div style={{ width: labelWidth, minWidth: labelWidth, borderRight: '1px solid #E8DFCE' }} />
            <div style={{ display: 'flex', flex: 1 }}>
              {days.map((d, i) => {
                const isToday = d.toISOString().slice(0, 10) === todayStr;
                const isWeekend = d.getDay() === 0 || d.getDay() === 6;
                return (
                  <div key={i} style={{ width: dayWidth, textAlign: 'center', fontSize: 9, padding: '3px 0', color: isToday ? '#5F4B82' : isWeekend ? '#C4A896' : '#AAA49C', fontWeight: isToday ? 600 : 300, background: isToday ? '#EFEBFA' : 'transparent', borderRight: '1px solid #F5F1EA' }}>
                    {d.getDate()}
                  </div>
                );
              })}
            </div>
          </div>

          {/* Rows */}
          <div style={{ position: 'relative' }}>
            <div style={{ position: 'absolute', left: labelWidth + todayPos + dayWidth / 2, top: 0, bottom: 0, width: 2, background: '#B84848', zIndex: 2, opacity: 0.6 }} />
            {MST.map((m, mi) => {
              const mPos = dayPos(m.date);
              if (mPos < 0 || mPos > totalDays * dayWidth) return null;
              return (
                <div key={mi} style={{ position: 'absolute', left: labelWidth + mPos + dayWidth / 2, top: 0, bottom: 0, width: 2, background: m.color, zIndex: 1, opacity: 0.3 }}>
                  <div style={{ position: 'absolute', top: -28, left: 4, fontSize: 9, color: m.color, fontWeight: 500, whiteSpace: 'nowrap', fontFamily: "'DM Serif Display',serif" }}>{m.label}</div>
                </div>
              );
            })}

            {groups.map((g, gi) => {
              if (g.type === 'cat') {
                const c = CC[g.cat] || CC['기타'];
                return (
                  <div key={gi} style={{ display: 'flex', height: CAT_H, borderBottom: '1px solid #E8DFCE', background: c.bg }}>
                    <div style={{ width: labelWidth, minWidth: labelWidth, display: 'flex', alignItems: 'center', gap: 6, padding: '0 10px', borderRight: '1px solid #E8DFCE' }}>
                      <span style={{ fontFamily: "'DM Serif Display',serif", fontSize: 12, fontWeight: 400, color: c.tx }}>{g.cat}</span>
                      <span style={{ fontSize: 10, color: c.tx, opacity: 0.7 }}>{g.pct}%</span>
                      <div style={{ flex: 1, height: 3, background: c.tx + '22', borderRadius: 100, overflow: 'hidden', marginLeft: 4 }}>
                        <div style={{ width: `${g.pct}%`, height: '100%', background: c.bd, borderRadius: 100 }} />
                      </div>
                    </div>
                    <div style={{ flex: 1 }} />
                  </div>
                );
              }
              if (g.type === 'proj') {
                return (
                  <div key={gi} style={{ display: 'flex', height: PROJ_H, borderBottom: '1px solid #EFE7D6', background: '#FDFBF7' }}>
                    <div style={{ width: labelWidth, minWidth: labelWidth, display: 'flex', alignItems: 'center', gap: 4, padding: '0 10px 0 24px', borderRight: '1px solid #E8DFCE' }}>
                      <span style={{ fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#4A3F38' }}>{g.proj}</span>
                      <span style={{ fontSize: 9, color: '#8A7D72', marginLeft: 'auto' }}>{g.done}/{g.total}</span>
                    </div>
                    <div style={{ flex: 1 }} />
                  </div>
                );
              }
              const t = g.task;
              const c = CC[g.cat] || CC['기타'];
              const pos = dayPos(t.deadline!);
              const isDone = t.status === 'done';
              const isOv = t.deadline && !isDone && dU(t.deadline) < 0;
              const barColor = isDone ? '#A8C496' : isOv ? '#B84848' : c.bd;
              return (
                <div key={gi} style={{ display: 'flex', height: ROW_H, borderBottom: '1px solid #F5F1EA', position: 'relative', cursor: 'pointer' }} onClick={() => onEdit(t.id)}>
                  <div style={{ width: labelWidth, minWidth: labelWidth, display: 'flex', alignItems: 'center', gap: 4, padding: '0 6px 0 36px', borderRight: '1px solid #E8DFCE', overflow: 'hidden' }}>
                    {t.priority === 'high' && <span style={{ fontSize: 8, flexShrink: 0 }}>🔴</span>}
                    <span style={{ fontSize: 11, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', opacity: isDone ? 0.5 : 1, textDecoration: isDone ? 'line-through' : 'none', color: '#1A1613' }}>{t.title}</span>
                  </div>
                  <div style={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center' }}>
                    {days.map((d, di) => (d.getDay() === 0 || d.getDay() === 6) ? <div key={di} style={{ position: 'absolute', left: di * dayWidth, width: dayWidth, top: 0, bottom: 0, background: '#F5F1EA' }} /> : null)}
                    <div style={{ position: 'absolute', left: pos, top: 6, height: ROW_H - 12, width: Math.max(dayWidth - 4, dayWidth), borderRadius: 3, background: barColor, opacity: isDone ? 0.4 : 0.85, display: 'flex', alignItems: 'center', paddingLeft: 4 }}>
                      {t.owner && <span style={{ fontSize: 8, color: '#fff', fontWeight: 600, opacity: 0.9 }}>{t.owner === '풍성' ? '풍' : t.owner === '은채' ? '은' : '공'}</span>}
                    </div>
                    <div style={{ position: 'absolute', left: pos + dayWidth + 2, top: 6, fontSize: 9, color: SC[t.status]?.tx, background: SC[t.status]?.bg, padding: '1px 5px', borderRadius: 100, whiteSpace: 'nowrap' }}>{SL[t.status]}</div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════
// SYNC MODAL — Text extraction via Claude API
// ═══════════════════════════════════════════════════
function SyncModal({
  onClose, onAdd, existing,
}: {
  onClose: () => void;
  onAdd: (arr: Partial<AppTask>[]) => void;
  existing: AppTask[];
}) {
  const [text, setText] = useState('');
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
          system: `Extract actionable todos from text for Peacer (피서) shower bomb brand.\n\nEXISTING TASKS:\n${el}\n\nReturn ONLY JSON array:\n[{"title":"concise task","category":"제조|사업자/인허가|마케팅|디자인|계약|기타","project":"project name","owner":"풍성|은채|공동","deadline":"YYYY-MM-DD|null","status":"todo|doing|waiting|done","note":"","priority":"high|medium|low","isDuplicate":bool,"duplicateOf":"existing title|null"}]\n\nRules: today=${new Date().toISOString().slice(0, 10)} year=2026. ~~strikethrough~~=done. Semantically similar to existing=isDuplicate. "4/13"→"2026-04-13". Infer project names.`,
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
          <button onClick={onClose} style={S.mClose}>×</button>
        </div>
        <div style={S.mBody}>
          <div style={S.hint}>회의록, 카톡, 메모 등을 붙여넣으세요.</div>
          <textarea value={text} onChange={(e) => setText(e.target.value)} style={{ ...S.input, minHeight: 140, resize: 'vertical', lineHeight: 1.6 }} placeholder="회의 내용을 붙여넣기..." />
          <button onClick={parse} disabled={parsing || !text.trim()} style={{ ...S.syncBtnBig, opacity: parsing || !text.trim() ? 0.5 : 1 }}>
            {parsing ? '⏳ AI 분석 중…' : '🔍 추출하기'}
          </button>
          {error && <div style={{ color: '#B84848', fontSize: 12 }}>⚠ {error}</div>}
          {preview && (
            <div style={S.prevBox}>
              <div style={{ fontSize: 11, color: '#5F4B82', fontWeight: 500, marginBottom: 8 }}>
                {preview.filter((t) => t.selected).length}개 선택 · {preview.filter((t) => t.isDuplicate).length}개 중복
              </div>
              {preview.map((t, i) => (
                <div key={i} onClick={() => toggle(i)} style={{ ...S.prevItem, opacity: t.selected ? 1 : 0.4, background: t.isDuplicate ? '#FFF5F5' : t.selected ? '#F5FFF5' : '#FAF6EF', borderLeftColor: t.isDuplicate ? '#D4A4A4' : CC[t.category || '기타']?.bd || '#DDD3C2' }}>
                  <span style={{ ...S.pChk, background: t.selected ? '#5F4B82' : 'transparent', borderColor: t.selected ? '#5F4B82' : '#DDD3C2', color: '#fff' }}>
                    {t.selected ? '✓' : ''}
                  </span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 12 }}>{t.title}</div>
                    <div style={{ fontSize: 10, color: '#8A7D72', marginTop: 2 }}>
                      {t.category} · {t.project || '미정'} · {t.owner || '미정'} · {t.deadline ? fD(t.deadline) : '마감일 없음'}
                      {t.isDuplicate && <span style={{ color: '#B84848', marginLeft: 6 }}>≈ {t.duplicateOf}</span>}
                    </div>
                  </div>
                </div>
              ))}
              <button
                onClick={() => {
                  onAdd(preview.filter((t) => t.selected).map(({ isDuplicate, selected, duplicateOf, ...r }) => r));
                }}
                style={S.confirmBtn}
              >
                ✓ {preview.filter((t) => t.selected).length}개 추가
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
          system: `You analyze task dependencies for Peacer (피서) shower bomb brand.\n\nReturn ONLY JSON (no fences):\n{"dependencies":[{"id":"task_id","dependsOn":["other_task_id"],"reason":"1-line why"}]}\n\nRules:\n- Only include tasks that ACTUALLY depend on another task completing first\n- Use business logic: 사업자등록→법인설립, 향료발주→향확정, 패키지발주→전성분표\n- Don't create circular dependencies\n- Be conservative: only add dependencies you're confident about`,
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
          <button onClick={onClose} style={S.mClose}>×</button>
        </div>
        <div style={S.mBody}>
          <div style={S.hint}>AI가 전체 태스크를 분석해서 &quot;A가 끝나야 B를 시작할 수 있다&quot;는 의존관계를 자동으로 추론합니다.</div>
          {!result && (
            <button onClick={analyze} disabled={analyzing} style={{ ...S.syncBtnBig, background: '#5F4B82', opacity: analyzing ? 0.5 : 1 }}>
              {analyzing ? '⏳ AI 분석 중… (5-10초)' : '🔗 의존관계 분석 시작'}
            </button>
          )}
          {error && <div style={{ color: '#B84848', fontSize: 12 }}>⚠ {error}</div>}
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
                      <div style={{ fontSize: 10, color: '#5F4B82', marginTop: 2 }}>← {d.dependsOn.map((did) => byId[did]?.title || did).join(', ')}</div>
                      <div style={{ fontSize: 10, color: '#8A7D72', marginTop: 1, fontStyle: 'italic' }}>{d.reason}</div>
                    </div>
                  </div>
                );
              })}
              <button onClick={apply} style={S.confirmBtn}>✓ 의존관계 적용하기</button>
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
          <button onClick={onClose} style={S.mClose}>×</button>
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
                <option value="high">높음 🔴</option>
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
const CSS = `@import url('https://fonts.googleapis.com/css2?family=DM+Serif+Display:ital@0;1&family=IBM+Plex+Sans+KR:wght@300;400;500;600&display=swap');*{box-sizing:border-box;margin:0}button,select{cursor:pointer;font-family:inherit}input,select,textarea{font-family:inherit}@keyframes fadeUp{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}`;

const S: Record<string, React.CSSProperties> = {
  root: { minHeight: '100vh', background: '#F5F1EA', padding: '20px 14px 60px', fontFamily: "'IBM Plex Sans KR',sans-serif", fontWeight: 300, color: '#1A1613', maxWidth: 1100, margin: '0 auto' },
  header: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 12, paddingBottom: 14, borderBottom: '1px solid #DDD3C2', marginBottom: 10 },
  hL: { flex: 1, minWidth: 160 },
  hR: { display: 'flex', gap: 8, flexWrap: 'wrap' },
  brand: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 },
  dot: { width: 6, height: 6, borderRadius: '50%', background: '#5F4B82', display: 'inline-block' },
  bTxt: { fontFamily: "'DM Serif Display',serif", fontSize: 11, letterSpacing: '.3em', color: '#4A3F38' },
  h1: { fontFamily: "'DM Serif Display',serif", fontWeight: 400, fontSize: 'clamp(20px,4vw,30px)', lineHeight: 1.1 },
  ms: { background: '#FAF6EF', border: '1px solid', padding: '7px 12px', borderRadius: 2, textAlign: 'right' as const, minWidth: 86 },
  msL: { fontFamily: "'DM Serif Display',serif", fontSize: 9, letterSpacing: '.12em', color: '#8A7D72', textTransform: 'uppercase' as const },
  msD: { fontFamily: "'DM Serif Display',serif", fontSize: 18, fontWeight: 400, lineHeight: 1.2 },
  msDt: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 10, color: '#8A7D72' },
  okr: { display: 'flex', alignItems: 'center', gap: 10, padding: '8px 14px', background: 'linear-gradient(135deg,#FAF6EF,#F0E9DB)', border: '1px solid #DDD3C2', borderRadius: 2, marginBottom: 10 },
  okrLabel: { fontFamily: "'DM Serif Display',serif", fontSize: 10, letterSpacing: '.2em', color: '#5F4B82', flexShrink: 0 },
  okrText: { fontSize: 13, fontWeight: 400 },
  stats: { display: 'grid', gridTemplateColumns: 'repeat(4,1fr)', gap: 6, marginBottom: 10 },
  st: { background: '#FAF6EF', padding: '8px 12px', borderRadius: 2, borderLeft: '3px solid', display: 'flex', alignItems: 'baseline', gap: 6 },
  stN: { fontFamily: "'DM Serif Display',serif", fontSize: 'clamp(18px,3vw,24px)', lineHeight: 1 },
  stL: { fontSize: 10, color: '#8A7D72' },
  ctrl: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap', marginBottom: 14 },
  tabs: { display: 'flex', background: '#FAF6EF', border: '1px solid #DDD3C2', borderRadius: 2, padding: 2, flexWrap: 'wrap' },
  tab: { padding: '5px 10px', background: 'transparent', border: 'none', fontSize: 11, color: '#8A7D72', borderRadius: 2, whiteSpace: 'nowrap' },
  tabOn: { background: '#1A1613', color: '#FAF6EF' },
  filters: { display: 'flex', gap: 4 },
  sel: { padding: '4px 6px', border: '1px solid #DDD3C2', borderRadius: 2, background: '#FAF6EF', fontSize: 10, color: '#4A3F38' },
  syncBtn: { padding: '5px 12px', background: 'linear-gradient(135deg,#5F4B82,#8B7AAD)', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' },
  aiBtn: { padding: '5px 12px', background: '#FAF6EF', border: '1px solid #A896C4', borderRadius: 2, color: '#5F4B82', fontSize: 11, fontWeight: 500, whiteSpace: 'nowrap' },
  addBtn: { padding: '5px 10px', background: '#1A1613', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 13, fontWeight: 500, lineHeight: 1 },
  critBox: { background: 'linear-gradient(135deg,#FEF5F3,#FBEDEA)', border: '1px solid #D4A4A4', borderRadius: 2, padding: '16px 18px', animation: 'fadeUp .4s ease-out' },
  critHead: { marginBottom: 10 },
  critLabel: { fontFamily: "'DM Serif Display',serif", fontSize: 10, letterSpacing: '.2em', color: '#B84848', marginBottom: 3 },
  critTitle: { fontFamily: "'DM Serif Display',serif", fontSize: 16, fontWeight: 400 },
  critItem: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, padding: '8px 12px', background: '#fff', borderRadius: 2, cursor: 'pointer', flexWrap: 'wrap' },
  critItemLeft: { display: 'flex', alignItems: 'center', gap: 6, flex: 1, minWidth: 140 },
  critItemTitle: { fontSize: 12, fontWeight: 400 },
  critItemRight: { display: 'flex', alignItems: 'center', gap: 6 },
  critChain: { fontSize: 10, color: '#B84848', fontWeight: 500, background: '#FBEDEA', padding: '2px 6px', borderRadius: 100 },
  critDate: { fontSize: 10, fontStyle: 'italic' },
  secBox: { border: '1px solid', borderRadius: 2, overflow: 'hidden' },
  secHead: { display: 'flex', alignItems: 'center', gap: 10, padding: '10px 14px' },
  secTitle: { fontFamily: "'DM Serif Display',serif", fontSize: 14 },
  secSub: { fontSize: 11, color: '#8A7D72', fontStyle: 'italic' },
  secCount: { marginLeft: 'auto', fontFamily: "'DM Serif Display',serif", fontSize: 20, fontWeight: 400 },
  secBody: { padding: 8, display: 'flex', flexDirection: 'column', gap: 5 },
  card: { padding: '8px 10px', background: '#FAF6EF', borderLeft: '3px solid #DDD3C2', borderRadius: 2, cursor: 'pointer', transition: 'all .15s', animation: 'fadeUp .3s ease-out', userSelect: 'none' },
  cTop: { display: 'flex', alignItems: 'center', gap: 4, marginBottom: 4, flexWrap: 'wrap' },
  catB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, letterSpacing: '.03em', whiteSpace: 'nowrap' },
  projB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, background: '#F5F1EA', color: '#4A3F38', border: '1px solid #E8DFCE' },
  ownB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500, whiteSpace: 'nowrap' },
  chainB: { fontSize: 9, padding: '1px 6px', borderRadius: 100, background: '#FBEDEA', color: '#B84848', fontWeight: 500 },
  cTitle: { fontSize: 12, fontWeight: 400, lineHeight: 1.4, marginBottom: 2 },
  cNote: { fontSize: 10, color: '#8A7D72', fontStyle: 'italic', lineHeight: 1.4, marginBottom: 3, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical' as const, overflow: 'hidden' },
  cBot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 4 },
  cDate: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 10 },
  stSel: { padding: '2px 5px', border: '1px solid #E8DFCE', borderRadius: 2, fontSize: 10, fontWeight: 500 },
  stBadge: { fontSize: 9, padding: '1px 6px', borderRadius: 100, fontWeight: 500 },
  empty: { textAlign: 'center' as const, padding: '16px 0', color: '#CCBFA8', fontStyle: 'italic', fontSize: 12 },
  emptyBig: { textAlign: 'center' as const, padding: '40px 0', color: '#CCBFA8', fontStyle: 'italic', fontSize: 14 },
  board: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(200px,1fr))', gap: 8, marginBottom: 20 },
  col: { border: '1px solid', borderRadius: 2, minHeight: 160, display: 'flex', flexDirection: 'column', transition: 'all .2s' },
  colH: { padding: '8px 12px', display: 'flex', justifyContent: 'space-between', alignItems: 'center', borderBottom: '1px solid' },
  colB: { padding: 6, display: 'flex', flexDirection: 'column', gap: 5, flex: 1, minHeight: 60 },
  catProgress: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 6, padding: '12px 14px', background: '#FAF6EF', border: '1px solid #DDD3C2', borderRadius: 2, marginBottom: 8 },
  catProgressItem: {},
  cpPct: { fontFamily: "'DM Serif Display',serif", fontSize: 13, color: '#1A1613' },
  cpCount: { fontSize: 10, color: '#8A7D72', fontStyle: 'italic' },
  cpBar: { width: '100%', height: 4, background: '#E8DFCE', borderRadius: 100, overflow: 'hidden', marginTop: 3 },
  cpBarIn: { height: '100%', borderRadius: 100, transition: 'width .5s ease' },
  treeBox: { border: '1px solid', borderRadius: 2, overflow: 'hidden', marginBottom: 4 },
  treeCatHead: { padding: '8px 14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  treeCatName: { fontFamily: "'DM Serif Display',serif", fontSize: 14, fontWeight: 400 },
  treeCatCount: { fontFamily: "'DM Serif Display',serif", fontSize: 16 },
  treeProjBox: { borderTop: '1px solid #EFE7D6' },
  treeProjHead: { display: 'flex', alignItems: 'center', gap: 8, padding: '8px 14px', background: '#FDFBF7' },
  treeProjName: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 13, color: '#4A3F38', minWidth: 80 },
  treeProjBar: { flex: 1, height: 4, background: '#E8DFCE', borderRadius: 100, overflow: 'hidden' },
  treeProjCount: { fontSize: 11, color: '#8A7D72', fontStyle: 'italic', minWidth: 30, textAlign: 'right' as const },
  treeProjBody: { padding: '4px 8px 8px' },
  treeItem: { display: 'flex', alignItems: 'center', gap: 6, padding: '6px 10px', borderLeft: '2px solid #DDD3C2', borderRadius: 2, cursor: 'pointer', marginBottom: 2, transition: 'all .1s', flexWrap: 'wrap' },
  backdrop: { position: 'fixed', inset: 0, background: 'rgba(26,22,19,.45)', backdropFilter: 'blur(3px)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 14 },
  modal: { background: '#FAF6EF', borderRadius: 2, width: '100%', maxWidth: 460, maxHeight: '90vh', overflow: 'auto', border: '1px solid #DDD3C2', boxShadow: '0 20px 60px rgba(26,22,19,.2)' },
  mHead: { padding: '14px 18px 10px', borderBottom: '1px solid #EFE7D6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' },
  mTitle: { fontFamily: "'DM Serif Display',serif", fontWeight: 400, fontSize: 18, margin: 0 },
  mClose: { background: 'transparent', border: 'none', fontSize: 22, color: '#8A7D72', padding: 0 },
  mBody: { padding: '12px 18px', display: 'flex', flexDirection: 'column', gap: 10 },
  label: { fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#8A7D72' },
  input: { padding: '7px 10px', background: '#fff', border: '1px solid #DDD3C2', borderRadius: 2, fontSize: 13, color: '#1A1613', outline: 'none', fontWeight: 300, width: '100%' },
  r2: { display: 'flex', gap: 8 },
  field: { flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
  mFoot: { padding: '10px 18px 14px', borderTop: '1px solid #EFE7D6', display: 'flex', gap: 8, alignItems: 'center' },
  delBtn: { padding: '6px 12px', background: 'transparent', border: '1px solid #D4A4A4', color: '#B84848', borderRadius: 2, fontSize: 11 },
  canBtn: { padding: '6px 14px', background: 'transparent', border: '1px solid #DDD3C2', color: '#8A7D72', borderRadius: 2, fontSize: 11 },
  savBtn: { padding: '6px 18px', background: '#1A1613', border: 'none', color: '#FAF6EF', borderRadius: 2, fontSize: 12, fontWeight: 500 },
  hint: { fontSize: 12, color: '#8A7D72', lineHeight: 1.5, padding: '6px 10px', background: '#EFEBFA', borderRadius: 2, borderLeft: '3px solid #A896C4' },
  syncBtnBig: { padding: '10px 20px', background: '#1A1613', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 13, fontWeight: 500, width: '100%', marginTop: 4 },
  prevBox: { marginTop: 8, border: '1px solid #E8DFCE', borderRadius: 2, padding: 10, maxHeight: 300, overflowY: 'auto' },
  prevItem: { display: 'flex', alignItems: 'flex-start', gap: 8, padding: '8px 10px', borderLeft: '3px solid', borderRadius: 2, cursor: 'pointer', marginBottom: 4 },
  pChk: { width: 16, height: 16, borderRadius: 2, border: '1.5px solid', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 10, flexShrink: 0, marginTop: 1 },
  confirmBtn: { padding: '10px 20px', background: '#5F4B82', color: '#FAF6EF', border: 'none', borderRadius: 2, fontSize: 13, fontWeight: 500, width: '100%', marginTop: 8 },
  footer: { paddingTop: 14, borderTop: '1px solid #DDD3C2', display: 'flex', alignItems: 'center', gap: 8, fontFamily: "'DM Serif Display',serif", fontStyle: 'italic', fontSize: 11, color: '#8A7D72' },
  fLink: { background: 'transparent', border: 'none', fontSize: 10, color: '#B84848', textDecoration: 'underline', padding: 0, fontFamily: 'inherit', fontStyle: 'italic' },
};
