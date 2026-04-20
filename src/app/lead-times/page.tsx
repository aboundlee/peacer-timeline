'use client';

import { useState, useEffect, useCallback, useMemo } from 'react';
import { supabase, type LeadTime } from '@/lib/supabase';
import { fD, dU } from '@/lib/constants';

const SHIP_DATE = '2026-05-19';

const STATUS_META: Record<string, { label: string; bg: string; tx: string; bd: string }> = {
  confirmed: { label: '확정', bg: '#EBF3E6', tx: '#3E5A2E', bd: '#A8C496' },
  inquiring: { label: '문의중', bg: '#FAF0F0', tx: '#8B4848', bd: '#C49696' },
  tbd: { label: 'TBD', bg: '#F2F4F6', tx: '#8B95A1', bd: '#E5E8EB' },
};

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() - days);
  return d.toISOString().slice(0, 10);
}

function calcOrderByDate(lt: LeadTime): string | null {
  const totalDays = (lt.lead_days || 0) + (lt.buffer_days || 0);
  if (!lt.lead_days || totalDays === 0) return null;
  return addDays(lt.target_date || SHIP_DATE, totalDays);
}

function urgencyColor(dayUntil: number): { bg: string; bd: string; tx: string; label: string } {
  if (dayUntil < 0) return { bg: '#FDE8E8', bd: '#F04452', tx: '#B84848', label: `${Math.abs(dayUntil)}일 지남` };
  if (dayUntil <= 3) return { bg: '#FDE8E8', bd: '#F04452', tx: '#B84848', label: `D-${dayUntil}` };
  if (dayUntil <= 7) return { bg: '#FFF4E0', bd: '#E8A04C', tx: '#8B5A2A', label: `D-${dayUntil}` };
  return { bg: '#EBF3E6', bd: '#A8C496', tx: '#3E5A2E', label: `D-${dayUntil}` };
}

export default function LeadTimesPage() {
  const [items, setItems] = useState<LeadTime[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const fetchItems = useCallback(async () => {
    const { data, error } = await supabase
      .from('lead_times')
      .select('*')
      .order('created_at', { ascending: true });
    if (error) { console.error(error); return; }
    if (data) { setItems(data as LeadTime[]); setLoaded(true); }
  }, []);

  useEffect(() => { fetchItems(); }, [fetchItems]);

  useEffect(() => {
    const ch = supabase
      .channel('lead-times-rt')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'lead_times' }, () => fetchItems())
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [fetchItems]);

  const update = async (id: string, patch: Partial<LeadTime>) => {
    setItems(prev => prev.map(it => it.id === id ? { ...it, ...patch } : it));
    await supabase.from('lead_times').update(patch).eq('id', id);
  };

  const remove = async (id: string) => {
    if (!confirm('정말 삭제할까요?')) return;
    setItems(prev => prev.filter(it => it.id !== id));
    await supabase.from('lead_times').delete().eq('id', id);
  };

  const addItem = async (item: Partial<LeadTime>) => {
    const { data } = await supabase.from('lead_times').insert({
      item_name: item.item_name || '새 항목',
      category: item.category || null,
      lead_days: item.lead_days || null,
      buffer_days: item.buffer_days || 0,
      supplier: item.supplier || null,
      status: item.status || 'tbd',
      note: item.note || null,
      task_id: item.task_id || null,
      target_date: item.target_date || SHIP_DATE,
    }).select().single();
    if (data) setItems(prev => [...prev, data as LeadTime]);
    setAddOpen(false);
  };

  // Stats
  const stats = useMemo(() => {
    const confirmed = items.filter(i => i.status === 'confirmed').length;
    const inquiring = items.filter(i => i.status === 'inquiring').length;
    const urgent = items.filter(i => {
      const by = calcOrderByDate(i);
      return by && dU(by) <= 7 && i.status !== 'confirmed';
    }).length;
    const overdue = items.filter(i => {
      const by = calcOrderByDate(i);
      return by && dU(by) < 0;
    }).length;
    return { confirmed, inquiring, urgent, overdue, total: items.length };
  }, [items]);

  // Sort: overdue first, then by days until order
  const sorted = useMemo(() => {
    return [...items].sort((a, b) => {
      const ba = calcOrderByDate(a);
      const bb = calcOrderByDate(b);
      if (!ba && !bb) return 0;
      if (!ba) return 1;
      if (!bb) return -1;
      return dU(ba) - dU(bb);
    });
  }, [items]);

  if (!loaded) {
    return (
      <div style={{ padding: '100px 20px', textAlign: 'center', color: '#8B95A1', fontSize: 13 }}>
        불러오는 중…
      </div>
    );
  }

  const daysUntilShip = dU(SHIP_DATE);

  return (
    <div style={{ maxWidth: 1100, margin: '0 auto', padding: '24px 20px 80px', fontFamily: 'Pretendard, "Noto Sans KR", sans-serif' }}>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500, letterSpacing: '0.05em', marginBottom: 6 }}>
          LEAD TIMES
        </div>
        <h1 style={{ margin: 0, fontSize: 24, fontWeight: 700, color: '#1A1613', letterSpacing: '-0.02em' }}>
          리드타임 관리
        </h1>
        <p style={{ margin: '6px 0 0', fontSize: 13, color: '#8B95A1', lineHeight: 1.5 }}>
          출하 목표 <strong style={{ color: '#4E5968' }}>{fD(SHIP_DATE)} (D-{daysUntilShip})</strong> 기준. 발주가 늦어지면 리드타임만큼 출시도 밀려요.
        </p>
      </div>

      {/* Stats strip */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 8, marginBottom: 20,
      }}>
        <StatCard label="전체" value={stats.total} color="#4E5968" />
        <StatCard label="확정" value={stats.confirmed} color="#3E5A2E" />
        <StatCard label="문의중" value={stats.inquiring} color="#8B4848" sub={stats.inquiring > 0 ? '리드타임 확인 필요' : undefined} />
        <StatCard label="긴급 발주" value={stats.urgent} color={stats.urgent > 0 ? '#B84848' : '#8B95A1'} sub={stats.overdue > 0 ? `${stats.overdue}개 지남` : undefined} />
      </div>

      {/* Items list */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {sorted.map(item => (
          <LeadTimeCard
            key={item.id}
            item={item}
            editing={editingId === item.id}
            onToggleEdit={() => setEditingId(editingId === item.id ? null : item.id)}
            onUpdate={update}
            onDelete={remove}
          />
        ))}
      </div>

      {/* Add button */}
      {addOpen ? (
        <AddItemForm onAdd={addItem} onCancel={() => setAddOpen(false)} />
      ) : (
        <button
          onClick={() => setAddOpen(true)}
          style={{
            marginTop: 12, width: '100%', padding: '14px',
            background: '#FFF', border: '1px dashed #D1D6DB', borderRadius: 10,
            color: '#8B95A1', fontSize: 13, fontWeight: 500, cursor: 'pointer',
          }}
        >
          + 항목 추가
        </button>
      )}
    </div>
  );
}

function StatCard({ label, value, color, sub }: { label: string; value: number; color: string; sub?: string }) {
  return (
    <div style={{
      background: '#FFF', border: '1px solid #E5E8EB', borderRadius: 10,
      padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 2,
    }}>
      <span style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 22, fontWeight: 700, color, letterSpacing: '-0.02em' }}>{value}</span>
      {sub && <span style={{ fontSize: 10, color: '#B84848', fontWeight: 500 }}>{sub}</span>}
    </div>
  );
}

function LeadTimeCard({
  item, editing, onToggleEdit, onUpdate, onDelete,
}: {
  item: LeadTime;
  editing: boolean;
  onToggleEdit: () => void;
  onUpdate: (id: string, patch: Partial<LeadTime>) => void;
  onDelete: (id: string) => void;
}) {
  const [draft, setDraft] = useState(item);
  useEffect(() => { setDraft(item); }, [item, editing]);

  const orderBy = calcOrderByDate(item);
  const totalDays = (item.lead_days || 0) + (item.buffer_days || 0);
  const urgency = orderBy ? urgencyColor(dU(orderBy)) : null;
  const statusMeta = STATUS_META[item.status] || STATUS_META.tbd;

  if (editing) {
    return (
      <div style={{
        background: '#FFF', border: '1.5px solid #A896C4', borderRadius: 10,
        padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
      }}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Field label="항목명" flex={2}>
            <input
              value={draft.item_name}
              onChange={e => setDraft({ ...draft, item_name: e.target.value })}
              style={inputStyle}
              autoFocus
            />
          </Field>
          <Field label="분류">
            <input
              value={draft.category || ''}
              onChange={e => setDraft({ ...draft, category: e.target.value || null })}
              placeholder="포장, 원료…"
              style={inputStyle}
            />
          </Field>
          <Field label="공급사">
            <input
              value={draft.supplier || ''}
              onChange={e => setDraft({ ...draft, supplier: e.target.value || null })}
              style={inputStyle}
            />
          </Field>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <Field label="리드타임 (일)">
            <input
              type="number"
              value={draft.lead_days ?? ''}
              onChange={e => setDraft({ ...draft, lead_days: e.target.value ? parseInt(e.target.value) : null })}
              placeholder="42"
              style={inputStyle}
            />
          </Field>
          <Field label="버퍼 (일)">
            <input
              type="number"
              value={draft.buffer_days}
              onChange={e => setDraft({ ...draft, buffer_days: parseInt(e.target.value) || 0 })}
              style={inputStyle}
            />
          </Field>
          <Field label="상태">
            <select
              value={draft.status}
              onChange={e => setDraft({ ...draft, status: e.target.value as LeadTime['status'] })}
              style={inputStyle}
            >
              <option value="confirmed">확정</option>
              <option value="inquiring">문의중</option>
              <option value="tbd">TBD</option>
            </select>
          </Field>
          <Field label="목표일">
            <input
              type="date"
              value={draft.target_date}
              onChange={e => setDraft({ ...draft, target_date: e.target.value })}
              style={inputStyle}
            />
          </Field>
        </div>
        <Field label="메모">
          <input
            value={draft.note || ''}
            onChange={e => setDraft({ ...draft, note: e.target.value || null })}
            placeholder="6주 소요, 검수 필요 등"
            style={inputStyle}
          />
        </Field>
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 4 }}>
          <button
            onClick={() => onDelete(item.id)}
            style={{ ...btnStyle, background: 'transparent', color: '#B84848', border: '1px solid #F0C4C4' }}
          >삭제</button>
          <div style={{ display: 'flex', gap: 6 }}>
            <button onClick={onToggleEdit} style={{ ...btnStyle, background: '#F2F4F6', color: '#4E5968' }}>취소</button>
            <button
              onClick={() => { onUpdate(item.id, draft); onToggleEdit(); }}
              style={{ ...btnStyle, background: '#191F28', color: '#FFF' }}
            >저장</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      onClick={onToggleEdit}
      style={{
        background: '#FFF',
        border: `1px solid ${urgency && urgency.tx === '#B84848' && item.status !== 'confirmed' ? '#F0C4C4' : '#E5E8EB'}`,
        borderLeft: `3px solid ${urgency && item.status !== 'confirmed' ? urgency.bd : '#E5E8EB'}`,
        borderRadius: 10,
        padding: '14px 16px',
        cursor: 'pointer',
        transition: 'box-shadow .15s',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
        {/* Main info */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4, flexWrap: 'wrap' }}>
            <span style={{
              fontSize: 10, fontWeight: 600, padding: '2px 8px', borderRadius: 100,
              background: statusMeta.bg, color: statusMeta.tx, border: `1px solid ${statusMeta.bd}`,
            }}>
              {statusMeta.label}
            </span>
            {item.category && (
              <span style={{ fontSize: 10, color: '#8B95A1', fontWeight: 500 }}>{item.category}</span>
            )}
            {item.supplier && (
              <span style={{ fontSize: 10, color: '#8B95A1' }}>· {item.supplier}</span>
            )}
          </div>
          <div style={{ fontSize: 14, fontWeight: 600, color: '#1A1613', marginBottom: 4, letterSpacing: '-0.01em' }}>
            {item.item_name}
          </div>
          {item.note && (
            <div style={{ fontSize: 11, color: '#8B95A1', lineHeight: 1.5 }}>{item.note}</div>
          )}
        </div>

        {/* Right: lead time + order-by date */}
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, flexShrink: 0 }}>
          {item.lead_days ? (
            <div style={{ fontSize: 11, color: '#8B95A1', fontWeight: 500 }}>
              {item.lead_days}일
              {item.buffer_days > 0 && <span> + {item.buffer_days}일</span>}
              <span style={{ marginLeft: 4 }}>= {totalDays}일</span>
            </div>
          ) : (
            <div style={{ fontSize: 11, color: '#B84848', fontWeight: 500 }}>리드타임 미정</div>
          )}
          {orderBy && urgency ? (
            <div style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '4px 10px', borderRadius: 6,
              background: item.status === 'confirmed' ? '#F2F4F6' : urgency.bg,
              border: `1px solid ${item.status === 'confirmed' ? '#E5E8EB' : urgency.bd}`,
            }}>
              <span style={{ fontSize: 11, fontWeight: 600, color: item.status === 'confirmed' ? '#8B95A1' : urgency.tx }}>
                {fD(orderBy)} 발주
              </span>
              <span style={{ fontSize: 10, fontWeight: 600, color: item.status === 'confirmed' ? '#8B95A1' : urgency.tx }}>
                {urgency.label}
              </span>
            </div>
          ) : (
            <div style={{
              fontSize: 11, color: '#8B95A1', fontWeight: 500,
              padding: '4px 10px', background: '#F2F4F6', borderRadius: 6,
            }}>
              계산 불가
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function AddItemForm({ onAdd, onCancel }: { onAdd: (i: Partial<LeadTime>) => void; onCancel: () => void }) {
  const [draft, setDraft] = useState<Partial<LeadTime>>({
    item_name: '', category: null, lead_days: null, buffer_days: 0,
    supplier: null, status: 'tbd', note: null, target_date: SHIP_DATE,
  });
  return (
    <div style={{
      marginTop: 12, background: '#FFF', border: '1.5px solid #A896C4', borderRadius: 10,
      padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10,
    }}>
      <Field label="항목명" flex={2}>
        <input
          value={draft.item_name || ''}
          onChange={e => setDraft({ ...draft, item_name: e.target.value })}
          autoFocus
          placeholder="예: 유리병, 스티커"
          style={inputStyle}
        />
      </Field>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <Field label="분류">
          <input
            value={draft.category || ''}
            onChange={e => setDraft({ ...draft, category: e.target.value || null })}
            style={inputStyle}
          />
        </Field>
        <Field label="공급사">
          <input
            value={draft.supplier || ''}
            onChange={e => setDraft({ ...draft, supplier: e.target.value || null })}
            style={inputStyle}
          />
        </Field>
        <Field label="리드 (일)">
          <input
            type="number"
            value={draft.lead_days ?? ''}
            onChange={e => setDraft({ ...draft, lead_days: e.target.value ? parseInt(e.target.value) : null })}
            style={inputStyle}
          />
        </Field>
        <Field label="버퍼 (일)">
          <input
            type="number"
            value={draft.buffer_days || 0}
            onChange={e => setDraft({ ...draft, buffer_days: parseInt(e.target.value) || 0 })}
            style={inputStyle}
          />
        </Field>
        <Field label="상태">
          <select
            value={draft.status}
            onChange={e => setDraft({ ...draft, status: e.target.value as LeadTime['status'] })}
            style={inputStyle}
          >
            <option value="confirmed">확정</option>
            <option value="inquiring">문의중</option>
            <option value="tbd">TBD</option>
          </select>
        </Field>
      </div>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 6, marginTop: 4 }}>
        <button onClick={onCancel} style={{ ...btnStyle, background: '#F2F4F6', color: '#4E5968' }}>취소</button>
        <button
          onClick={() => { if (draft.item_name) onAdd(draft); }}
          style={{ ...btnStyle, background: '#191F28', color: '#FFF' }}
        >추가</button>
      </div>
    </div>
  );
}

function Field({ label, flex = 1, children }: { label: string; flex?: number; children: React.ReactNode }) {
  return (
    <div style={{ flex, display: 'flex', flexDirection: 'column', gap: 4, minWidth: 80 }}>
      <label style={{ fontSize: 10, color: '#8B95A1', fontWeight: 500, letterSpacing: '0.02em' }}>{label}</label>
      {children}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  padding: '8px 10px', background: '#FAFAF8', border: '1px solid #E5E8EB',
  borderRadius: 6, fontSize: 13, color: '#1A1613', outline: 'none', width: '100%',
  fontFamily: 'inherit',
};

const btnStyle: React.CSSProperties = {
  padding: '7px 14px', border: 'none', borderRadius: 6,
  fontSize: 12, fontWeight: 600, cursor: 'pointer',
};
