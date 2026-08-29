import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { undoHeaders } from '@/lib/undo-manager';

let browserClient: SupabaseClient | null = null;

export function hasSupabaseConfig() {
  return Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
  );
}

export function getSupabaseBrowserClient(): SupabaseClient | null {
  if (!hasSupabaseConfig()) return null;
  if (browserClient) return browserClient;

  browserClient = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      global:{fetch:(input,init)=>{const headers=new Headers(init?.headers);for(const [key,value] of Object.entries(undoHeaders()))headers.set(key,value);return fetch(input,{...init,headers});}},
      auth: {
        flowType: 'pkce',
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    },
  );
  return browserClient;
}
