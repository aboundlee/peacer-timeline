import { dU } from './constants';

export type AppTask = {
  id: string;
  title: string;
  category: string;
  project: string | null;
  owner: string;
  deadline: string | null;
  status: string;
  priority: string;
  note: string;
  dependsOn: string[];
  blocksCount: number;
  isUnblocked?: boolean;
  created_at?: string;
  updated_at?: string;
};

export function calcCriticalPath(tasks: AppTask[]) {
  const active = tasks.filter((t) => t.status !== 'done');
  const byId: Record<string, AppTask> = {};
  tasks.forEach((t) => { byId[t.id] = t; });

  function countDownstream(id: string, visited = new Set<string>()): number {
    if (visited.has(id)) return 0;
    visited.add(id);
    const blocked = active.filter((t) => (t.dependsOn || []).includes(id));
    let count = blocked.length;
    for (const b of blocked) count += countDownstream(b.id, visited);
    return count;
  }

  const enriched = active.map((t) => {
    const bc = countDownstream(t.id);
    const deps = t.dependsOn || [];
    const allDepsDone = deps.length === 0 || deps.every((d) => byId[d]?.status === 'done');
    return { ...t, blocksCount: bc, isUnblocked: allDepsDone };
  });

  const critical = enriched
    .filter((t) => t.isUnblocked && t.status !== 'done')
    .sort((a, b) => {
      if (b.blocksCount !== a.blocksCount) return b.blocksCount - a.blocksCount;
      return dU(a.deadline) - dU(b.deadline);
    });

  return { enriched, critical };
}
