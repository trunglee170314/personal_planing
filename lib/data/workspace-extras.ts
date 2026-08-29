'use client';

import { getAppDataMode, localRequest } from './repository';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import { recordUndo } from '@/lib/undo-manager';

export type AnnotationTarget = {
  kind: 'task' | 'calendar' | 'milestone';
  id: string;
};
export type Annotation = {
  id: string;
  kind: 'comment' | 'link';
  body: string;
  url: string | null;
  created_at: string;
  updated_at: string;
};
export type Holiday = {
  id: string;
  title: string;
  starts_on: string;
  ends_on: string;
};
const targetColumns = {
  task: 'task_id',
  calendar: 'calendar_entry_id',
  milestone: 'milestone_id',
} as const;
const client = () => {
  const value = getSupabaseBrowserClient();
  if (!value) throw new Error('Online workspace unavailable.');
  return value;
};
export async function listAnnotations(
  target: AnnotationTarget,
): Promise<Annotation[]> {
  if (getAppDataMode() === 'local')
    return localRequest(
      `/api/annotations?kind=${target.kind}&id=${encodeURIComponent(target.id)}`,
    );
  const { data, error } = await client()
    .from('planner_annotations')
    .select('id,kind,body,url,created_at,updated_at')
    .eq(targetColumns[target.kind], target.id)
    .order('created_at')
    .order('id');
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function saveAnnotationNow(
  target: AnnotationTarget,
  input: Pick<Annotation, 'kind' | 'body' | 'url'>,
  id?: string,
) {
  if (!input.body.trim() || input.body.length > 10000)
    throw new Error('Enter text (maximum 10,000 characters).');
  if (
    input.kind === 'link' &&
    (!input.url || !['https:', 'http:'].includes(new URL(input.url).protocol))
  )
    throw new Error('Use an http:// or https:// link.');
  if (getAppDataMode() === 'local')
    return localRequest('/api/annotations', {
      method: 'POST',
      body: JSON.stringify({ target, input, id }),
    });
  const values = {
    ...input,
    body: input.body.trim(),
    url: input.kind === 'link' ? input.url : null,
    updated_at: new Date().toISOString(),
  };
  const query = id
    ? client()
        .from('planner_annotations')
        .update(values)
        .eq('id', id)
        .eq(targetColumns[target.kind], target.id)
    : client()
        .from('planner_annotations')
        .insert({ ...values, [targetColumns[target.kind]]: target.id });
  const { error } = await query;
  if (error) throw new Error(error.message);
}
async function deleteAnnotationNow(id: string) {
  if (getAppDataMode() === 'local')
    return localRequest(`/api/annotations/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  const { error } = await client()
    .from('planner_annotations')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}
export async function listHolidays(): Promise<Holiday[]> {
  if (getAppDataMode() === 'local') return localRequest('/api/holidays');
  const { data, error } = await client()
    .from('planner_holidays')
    .select('id,title,starts_on,ends_on')
    .order('starts_on')
    .order('id');
  if (error) throw new Error(error.message);
  return data ?? [];
}
async function saveHolidayNow(input: Omit<Holiday, 'id'>, id?: string) {
  if (
    !input.title.trim() ||
    input.title.length > 200 ||
    !input.starts_on ||
    input.ends_on < input.starts_on
  )
    throw new Error('Enter a title and valid date range.');
  if (getAppDataMode() === 'local')
    return localRequest('/api/holidays', {
      method: 'POST',
      body: JSON.stringify({ input, id }),
    });
  const { error } = await (id
    ? client().from('planner_holidays').update(input).eq('id', id)
    : client().from('planner_holidays').insert(input));
  if (error) throw new Error(error.message);
}
async function deleteHolidayNow(id: string) {
  if (getAppDataMode() === 'local')
    return localRequest(`/api/holidays/${encodeURIComponent(id)}`, {
      method: 'DELETE',
    });
  const { error } = await client()
    .from('planner_holidays')
    .delete()
    .eq('id', id);
  if (error) throw new Error(error.message);
}

// Share the mutation lane even when an action is not undoable, so another
// command's operation header cannot accidentally leak into this request.
export function saveAnnotation(
  target: AnnotationTarget,
  input: Pick<Annotation, 'kind' | 'body' | 'url'>,
  id?: string,
) {
  return recordUndo(
    'comment/link',
    () => saveAnnotationNow(target, input, id),
    false,
    true,
  );
}
export function deleteAnnotation(id: string) {
  return recordUndo(
    'delete comment/link',
    () => deleteAnnotationNow(id),
    false,
    true,
  );
}
export function saveHoliday(input: Omit<Holiday, 'id'>, id?: string) {
  return recordUndo('holiday', () => saveHolidayNow(input, id), false, true);
}
export function deleteHoliday(id: string) {
  return recordUndo('delete holiday', () => deleteHolidayNow(id), false, true);
}
