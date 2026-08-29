'use client';
import { getAppDataMode, localRequest } from './repository';
import { getSupabaseBrowserClient } from '@/lib/supabase/client';
import type {
  MapCommand,
  MapRevision,
  MapSummary,
  SystemMap,
} from '@/lib/system-map/model';
import { validateMapDocument } from '@/lib/system-map/schema.mjs';
const client = () => {
  const value = getSupabaseBrowserClient();
  if (!value) throw new Error('Online workspace unavailable.');
  return value;
};
export const systemMaps = {
  async list(trash = false): Promise<MapSummary[]> {
    if (getAppDataMode() === 'local')
      return localRequest(`/api/system-maps?trash=${trash ? '1' : '0'}`);
    const { data, error } = await client().rpc('system_map_list', {
      in_trash: trash,
    });
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async get(id: string): Promise<SystemMap> {
    if (getAppDataMode() === 'local')
      return localRequest(`/api/system-maps/${id}`);
    const { data, error } = await client()
      .from('system_maps')
      .select('id,name,document,version,updated_at,deleted_at')
      .eq('id', id)
      .single();
    if (error) throw new Error(error.message);
    return data as SystemMap;
  },
  async history(id: string, offset = 0): Promise<MapRevision[]> {
    if (getAppDataMode() === 'local')
      return localRequest(`/api/system-maps/${id}/history?offset=${offset}`);
    const { data, error } = await client()
      .from('system_map_revisions')
      .select('version,action,created_at,changed_by')
      .eq('map_id', id)
      .order('version', { ascending: false })
      .range(offset, offset + 19);
    if (error) throw new Error(error.message);
    return data ?? [];
  },
  async command(input: MapCommand): Promise<SystemMap | null> {
    if (input.document) validateMapDocument(input.document);
    if (getAppDataMode() === 'local')
      return localRequest('/api/system-maps/command', {
        method: 'POST',
        body: JSON.stringify(input),
      });
    const { data, error } = await client().rpc('system_map_command', {
      command: input,
    });
    if (error) throw new Error(error.message);
    return data as SystemMap | null;
  },
};
