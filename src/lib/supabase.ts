import { createClient } from '@supabase/supabase-js';
import { LEGACY_CAT_MAP } from './constants';

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || '';
const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseAnonKey || 'placeholder');

export type Task = {
  id: string;
  title: string;
  category: string;
  project: string | null;
  owner: string;
  deadline: string | null;
  status: 'todo' | 'doing' | 'waiting' | 'done';
  priority: 'high' | 'medium' | 'low';
  note: string;
  depends_on: string[];
  blocks_count: number;
  created_at: string;
  updated_at: string;
};

// Convert DB row to app format (snake_case → camelCase for dependsOn)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function dbToApp(row: any) {
  return {
    id: row.id as string,
    title: row.title as string,
    category: (LEGACY_CAT_MAP[row.category] || row.category) as string,
    project: (row.project || null) as string | null,
    owner: row.owner as string,
    deadline: (row.deadline || null) as string | null,
    status: row.status as 'todo' | 'doing' | 'waiting' | 'done',
    priority: row.priority as 'high' | 'medium' | 'low',
    note: (row.note || '') as string,
    dependsOn: (row.depends_on || []) as string[],
    blocksCount: (row.blocks_count || 0) as number,
    created_at: row.created_at as string,
    updated_at: row.updated_at as string,
  };
}

// ── Lead times ──
export type LeadTime = {
  id: string;
  item_name: string;
  category: string | null;
  lead_days: number | null;
  buffer_days: number;
  supplier: string | null;
  status: 'confirmed' | 'inquiring' | 'tbd';
  note: string | null;
  task_id: string | null;
  target_date: string;
  created_at: string;
  updated_at: string;
};

// Convert app format to DB format
export function appToDb(task: Record<string, unknown>) {
  const result: Record<string, unknown> = { ...task };
  if ('dependsOn' in result) {
    result.depends_on = result.dependsOn;
    delete result.dependsOn;
  }
  if ('blocksCount' in result) {
    result.blocks_count = result.blocksCount;
    delete result.blocksCount;
  }
  // Remove fields not in DB
  delete result.isUnblocked;
  return result;
}
