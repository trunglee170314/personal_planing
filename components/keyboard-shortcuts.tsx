'use client';
/* oxlint-disable react/react-compiler -- This opt-out component bridges the imperative keyboard/DOM action registry. Availability is checked live at dispatch, not captured from render. */
import {
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import {
  shortcutActions,
  actionsForContext,
  acceptsShortcutEvent,
  bindingFor,
  bindingError,
  inScope,
  keyStroke,
  normalizeBinding,
  sanitizePreferences,
  type ShortcutPreferences,
} from '@/lib/shortcuts';
import type { MapCluster } from '@/lib/system-map/commands';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from './ui/dialog';
import { Button } from './ui/button';
import { WorkspaceCommandResults } from './workspace-command-results';
import type { SearchFocus } from './workspace-search';

export type ShortcutHandler = {
  run: () => void;
  enabled?: () => boolean;
  release?: () => void;
};
type Handlers = Record<string, ShortcutHandler>;
type KeyboardContext = {
  register: (handlers: Handlers) => () => void;
  getClipboard: () => MapCluster | null;
  setClipboard: (cluster: MapCluster) => void;
  section: string;
  preferences: ShortcutPreferences;
  setBinding: (id: string, value: string) => string;
  reset: () => void;
  openSettings: () => void;
};
const Context = createContext<KeyboardContext | null>(null);
export function useKeyboard() {
  return useContext(Context);
}
export function useShortcutActions(handlers: Handlers) {
  const context = useKeyboard();
  const register = context?.register;
  const latest = useRef(handlers);
  useLayoutEffect(() => {
    latest.current = handlers;
  });
  const ids = Object.keys(handlers).sort().join('|');
  const holds = Object.keys(handlers)
    .filter((id) => handlers[id].release)
    .sort()
    .join('|');
  useEffect(
    () =>
      register?.(
        Object.fromEntries(
          ids
            .split('|')
            .filter(Boolean)
            .map((id) => [
              id,
              {
                run: () => latest.current[id]?.run(),
                enabled: () => latest.current[id]?.enabled?.() ?? true,
                release: holds.split('|').includes(id)
                  ? () => latest.current[id]?.release?.()
                  : undefined,
              },
            ]),
        ),
      ),
    [register, ids, holds],
  );
}
function isEditable(target: EventTarget | null) {
  return (
    target instanceof Element &&
    !!target.closest(
      'input,textarea,select,[contenteditable]:not([contenteditable="false"]),[role=combobox],[role=textbox],[role=listbox],[role=menu]',
    )
  );
}
function visible(selector: string) {
  return Array.from(document.querySelectorAll<HTMLElement>(selector)).find(
    (el) =>
      el.getClientRects().length && !el.closest('[inert],[aria-hidden="true"]'),
  );
}
function enabledButton(selector: string) {
  const el = visible(selector);
  return el && !el.matches(':disabled,[aria-disabled="true"]') ? el : undefined;
}
export function KeyboardProvider({
  scope,
  section,
  navigate,
  navigation,
  children,
}: {
  scope: string;
  section: string;
  navigate: (section: string, focus?: SearchFocus) => void;
  navigation: string[];
  children: ReactNode;
}) {
  'use no memo';
  const cacheKey = `myplan-shortcuts:v1:${scope}`;
  const [preferences, setPreferences] = useState<ShortcutPreferences>(() => {
    try {
      return sanitizePreferences(
        JSON.parse(localStorage.getItem(cacheKey) ?? '{}'),
      );
    } catch {
      return {};
    }
  });
  const [overlay, setOverlay] = useState<
    'palette' | 'help' | 'settings' | null
  >(null);
  const [query, setQuery] = useState('');
  const handlers = useRef(new Map<string, ShortcutHandler[]>());
  const clipboard = useRef<MapCluster | null>(null);
  const prefix = useRef({ key: '', until: 0 });
  const selectedRow = useRef<HTMLElement | null>(null);
  const [, refresh] = useState(0);
  const register = useState(() => (entries: Handlers) => {
    for (const [id, handler] of Object.entries(entries))
      handlers.current.set(id, [...(handlers.current.get(id) ?? []), handler]);
    refresh((n) => n + 1);
    return () => {
      for (const [id, handler] of Object.entries(entries))
        handlers.current.set(
          id,
          (handlers.current.get(id) ?? []).filter((h) => h !== handler),
        );
      refresh((n) => n + 1);
    };
  })[0];
  useEffect(() => {
    try {
      localStorage.setItem(cacheKey, JSON.stringify(preferences));
    } catch {
      /* Session preferences still work if storage is unavailable. */
    }
  }, [cacheKey, preferences]);
  useEffect(() => {
    prefix.current = { key: '', until: 0 };
    selectedRow.current = null;
  }, [section]);
  useEffect(() => {
    prefix.current = { key: '', until: 0 };
  }, [overlay]);
  function resolve(id: string): ShortcutHandler | undefined {
    if (id === 'cancel' && visible('[role="dialog"],[role="alertdialog"]'))
      return {
        run: () => {
          if (overlay) setOverlay(null);
          else
            enabledButton(
              '[data-slot="dialog-close"], [data-slot="alert-dialog-cancel"]',
            )?.click();
        },
      };
    const custom = handlers.current.get(id)?.at(-1);
    if (custom) return custom;
    if (id.startsWith('nav.')) {
      const target = id.slice(4);
      return navigation.includes(target)
        ? { run: () => navigate(target) }
        : undefined;
    }
    if (id === 'palette' || id === 'help')
      return {
        run: () => {
          setQuery('');
          setOverlay(id);
        },
      };
    if (id === 'cancel')
      return {
        run: () => {
          if (overlay) {
            setOverlay(null);
            return;
          }
          enabledButton(
            '[data-slot="dialog-close"], [data-slot="alert-dialog-cancel"]',
          )?.click();
        },
      };
    if (id === 'submit') {
      const target = document.activeElement;
      const composer = target?.closest('[data-shortcut-composer]');
      const button = composer?.querySelector<HTMLButtonElement>(
        '[data-shortcut-submit]',
      );
      if (button)
        return {
          enabled: () => !button.matches(':disabled'),
          run: () => button.click(),
        };
      const form = target?.closest('form');
      if (form instanceof HTMLFormElement)
        return {
          enabled: () => !form.querySelector('button[type="submit"]:disabled'),
          run: () => form.requestSubmit(),
        };
      return undefined;
    }
    if (id === 'find')
      return {
        enabled: () => !!visible('.workspace-content [data-shortcut-search]'),
        run: () =>
          visible('.workspace-content [data-shortcut-search]')?.focus(),
      };
    if (['selectPrevious', 'selectNext'].includes(id))
      return {
        enabled: () => !!visible('.workspace-content [data-shortcut-item]'),
        run: () => {
          const rows = Array.from(
            document.querySelectorAll<HTMLElement>(
              '.workspace-content [data-shortcut-item]',
            ),
          ).filter((el) => el.getClientRects().length);
          const index = rows.indexOf(selectedRow.current!);
          const row =
            rows[
              Math.max(
                0,
                Math.min(
                  rows.length - 1,
                  index + (id === 'selectNext' ? 1 : -1),
                ),
              )
            ];
          selectedRow.current = row;
          (row?.matches('[data-shortcut-action="edit"]')
            ? row
            : row?.querySelector<HTMLElement>(
                '[data-shortcut-action="edit"], [data-shortcut-action="openLink"]',
              )
          )?.focus();
        },
      };
    if (
      [
        'create',
        'edit',
        'openLink',
        'delete',
        'archive',
        'restore',
        'done',
        'collapse',
        'previous',
        'next',
        'today',
        'search',
      ].includes(id)
    ) {
      const selector = `[data-shortcut-action="${id}"]`;
      const selected = [
        'edit',
        'openLink',
        'delete',
        'archive',
        'restore',
        'done',
        'collapse',
      ].includes(id);
      const root = selected ? selectedRow.current : null;
      const button = root?.isConnected
        ? root.matches(selector)
          ? root
          : root.querySelector<HTMLElement>(selector)
        : visible(`.workspace-content ${selector}`);
      // Never silently edit/delete the first row when no item has been selected.
      if (selected && !root?.isConnected) return undefined;
      return button
        ? {
            enabled: () =>
              !!button.getClientRects().length &&
              !button.closest('[inert]') &&
              !button.matches(':disabled,[aria-disabled="true"]'),
            run: () => button.click(),
          }
        : undefined;
    }
    return undefined;
  }
  function available(id: string) {
    const h = resolve(id);
    return !!h && (h.enabled?.() ?? true);
  }
  function run(id: string) {
    const h = resolve(id);
    if (h && (h.enabled?.() ?? true)) h.run();
  }
  const runtime = useRef({
    preferences,
    section,
    overlay,
    resolve,
    available,
    run,
  });
  useLayoutEffect(() => {
    runtime.current = {
      preferences,
      section,
      overlay,
      resolve,
      available,
      run,
    };
  });
  useEffect(() => {
    const held = new Map<string, ShortcutHandler>();
    const resetPrefix = () => {
      prefix.current = { key: '', until: 0 };
    };
    const track = (event: Event) => {
      resetPrefix();
      if (event.target instanceof Element) {
        const row = event.target.closest<HTMLElement>('[data-shortcut-item]');
        if (row) selectedRow.current = row;
      }
    };
    const keydown = (event: KeyboardEvent) => {
      const state = runtime.current;
      if (!acceptsShortcutEvent(event, Reflect.get(event, 'keyCode'))) {
        resetPrefix();
        return;
      }
      const stroke = keyStroke(event);
      if (!stroke) return;
      const editing = event.composedPath().some(isEditable);
      const modal = visible(
        '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"], [data-shortcut-menu]',
      );
      // Native overlay primitives own Escape (including nested selects).
      if (
        event.key === 'Escape' &&
        visible(
          '[role="dialog"],[role="alertdialog"],[role="menu"],[role="listbox"]',
        )
      ) {
        resetPrefix();
        return;
      }
      const actions = actionsForContext(state.section, editing, !!modal);
      const activePrefix =
        !editing && !modal && Date.now() < prefix.current.until
          ? prefix.current.key
          : '';
      resetPrefix();
      const combo = activePrefix ? `${activePrefix} ${stroke}` : stroke;
      // Map child takes precedence over form-submit only when no composer is focused.
      const exact = actions
        .filter((a) => bindingFor(a, state.preferences) === combo)
        .sort((a, b) => Number(b.scope !== '*') - Number(a.scope !== '*'))
        .find((a) => state.available(a.id));
      if (exact) {
        event.preventDefault();
        const handler = state.resolve(exact.id);
        if (handler?.release) held.set(event.code, handler);
        state.run(exact.id);
        return;
      }
      const nextPrefix = actions.some(
        (a) =>
          bindingFor(a, state.preferences).startsWith(stroke + ' ') &&
          state.available(a.id),
      );
      if (!editing && !modal && nextPrefix) {
        event.preventDefault();
        prefix.current = { key: stroke, until: Date.now() + 1000 };
      }
    };
    const keyup = (event: KeyboardEvent) => {
      held.get(event.code)?.release?.();
      held.delete(event.code);
    };
    const releaseAll = () => {
      held.forEach((h) => h.release?.());
      held.clear();
      resetPrefix();
    };
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('focusin', track);
    window.addEventListener('pointerdown', track);
    window.addEventListener('blur', releaseAll);
    window.addEventListener('compositionstart', resetPrefix);
    return () => {
      releaseAll();
      window.removeEventListener('keyup', keyup);
      window.removeEventListener('keydown', keydown);
      window.removeEventListener('focusin', track);
      window.removeEventListener('pointerdown', track);
      window.removeEventListener('blur', releaseAll);
      window.removeEventListener('compositionstart', resetPrefix);
    };
  }, []);
  function setBinding(id: string, raw: string) {
    const value = normalizeBinding(raw),
      error = bindingError(id, value, preferences);
    if (!error) setPreferences((p) => ({ ...p, [id]: value }));
    return error;
  }
  const context = {
    register,
    getClipboard: () => clipboard.current,
    setClipboard: (cluster: MapCluster) => {
      clipboard.current = structuredClone(cluster);
    },
    section,
    preferences,
    setBinding,
    reset: () => setPreferences({}),
    openSettings: () => setOverlay('settings' as const),
  };
  const displayed = shortcutActions.filter(
    (a) =>
      inScope(a, section) &&
      (!a.id.startsWith('nav.') || navigation.includes(a.id.slice(4))) &&
      `${a.title} ${bindingFor(a, preferences)}`
        .toLowerCase()
        .includes(query.toLowerCase()),
  );
  return (
    <Context.Provider value={context}>
      {children}
      <div className="fixed bottom-20 right-4 z-30 flex gap-2 md:bottom-4">
        <Button
          size="sm"
          variant="outline"
          onClick={() => {
            setQuery('');
            setOverlay('palette');
          }}
        >
          Commands
        </Button>
        <Button
          size="icon-sm"
          variant="outline"
          aria-label="Keyboard shortcuts"
          onClick={() => {
            setQuery('');
            setOverlay('help');
          }}
        >
          ?
        </Button>
      </div>
      <Dialog
        open={!!overlay}
        onOpenChange={(open) => {
          if (!open) setOverlay(null);
        }}
      >
        <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>
              {overlay === 'palette'
                ? 'Command palette'
                : overlay === 'settings'
                  ? 'Keyboard shortcuts'
                  : `Shortcuts — ${section}`}
            </DialogTitle>
            <DialogDescription>
              {overlay === 'settings'
                ? 'Preferences are saved for this account and data mode on this browser. Mod means Ctrl on Windows/Linux or Cmd on macOS.'
                : 'Select or focus an item first for contextual actions. Shortcuts never replace normal typing or IME input.'}
            </DialogDescription>
          </DialogHeader>
          {overlay === 'settings' ? (
            <ShortcutSettings />
          ) : (
            <>
              <input
                aria-label="Filter commands"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                className="rounded-lg border p-3"
                placeholder="Search actions, navigation or keys…"
              />
              <div className="grid gap-1">
                {displayed.map((a) => (
                  <button
                    type="button"
                    key={a.id}
                    disabled={
                      overlay === 'palette' &&
                      (!available(a.id) || !!resolve(a.id)?.release)
                    }
                    className="flex items-center justify-between rounded-lg p-3 text-left text-sm hover:bg-muted disabled:opacity-40"
                    onClick={() => {
                      if (resolve(a.id)?.release) return;
                      setOverlay(null);
                      requestAnimationFrame(() => run(a.id));
                    }}
                  >
                    <span>
                      {a.title}
                      {overlay === 'help' && !available(a.id)
                        ? ' (unavailable here)'
                        : ''}
                    </span>
                    <kbd className="ml-4 whitespace-nowrap text-xs">
                      {bindingFor(a, preferences) || 'Disabled'}
                    </kbd>
                  </button>
                ))}
              </div>
              {overlay === 'palette' && (
                <WorkspaceCommandResults
                  query={query}
                  navigate={navigate}
                  close={() => setOverlay(null)}
                />
              )}
              {section === 'System Map' && (
                <p className="text-xs text-muted-foreground">
                  Shift+click toggles nodes. Shift+drag selects an area.
                  Space+drag pans. Copy includes only internal connections;
                  group copies include all group nodes. Clipboard stays inside
                  this account/mode.
                </p>
              )}
              <Button variant="outline" onClick={() => setOverlay('settings')}>
                Customize shortcuts
              </Button>
            </>
          )}
        </DialogContent>
      </Dialog>
    </Context.Provider>
  );
}
export function ShortcutSettings() {
  const keyboard = useKeyboard();
  const [filter, setFilter] = useState('');
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  if (!keyboard) return null;
  return (
    <section className="space-y-4" aria-label="Keyboard shortcut settings">
      <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
      <p className="text-sm text-muted-foreground">
        Use a key (N), combination (Mod+Shift+K), or two-key sequence (G T).
        Empty means disabled. Native text editing, Tab, Escape inside dialogs,
        and reserved browser shortcuts stay unchanged.
      </p>
      <input
        aria-label="Filter shortcut settings"
        className="w-full rounded-lg border p-2"
        placeholder="Find an action…"
        value={filter}
        onChange={(e) => setFilter(e.target.value)}
      />
      <p role="alert" className="text-sm text-destructive">
        {error}
      </p>
      <div className="max-h-[55dvh] space-y-2 overflow-y-auto">
        {shortcutActions
          .filter((a) =>
            `${a.title} ${a.scope}`
              .toLowerCase()
              .includes(filter.toLowerCase()),
          )
          .map((a) => (
            <div
              key={a.id}
              className="flex flex-wrap items-center gap-2 rounded-lg border p-2"
            >
              <label
                htmlFor={`shortcut-${a.id}`}
                className="min-w-44 flex-1 text-sm"
              >
                {a.title}
                <small className="block text-muted-foreground">
                  {a.scope === '*' ? 'Global' : a.scope}
                </small>
              </label>
              <input
                id={`shortcut-${a.id}`}
                aria-label={`${a.title} shortcut`}
                className="w-36 rounded border p-2 text-xs"
                value={draft[a.id] ?? bindingFor(a, keyboard.preferences)}
                onChange={(e) =>
                  setDraft((p) => ({ ...p, [a.id]: e.target.value }))
                }
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  const issue = keyboard.setBinding(
                    a.id,
                    draft[a.id] ?? bindingFor(a, keyboard.preferences),
                  );
                  setError(issue);
                  if (!issue)
                    setDraft((p) => {
                      const next = { ...p };
                      delete next[a.id];
                      return next;
                    });
                }}
              >
                Apply
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setError(keyboard.setBinding(a.id, ''));
                  setDraft((p) => ({ ...p, [a.id]: '' }));
                }}
              >
                Disable
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  const issue = keyboard.setBinding(a.id, a.keys);
                  setError(issue);
                  if (!issue) setDraft((p) => ({ ...p, [a.id]: a.keys }));
                }}
              >
                Reset
              </Button>
            </div>
          ))}
      </div>
      <Button
        variant="outline"
        onClick={() => {
          if (window.confirm('Reset all keyboard shortcuts to defaults?')) {
            keyboard.reset();
            setDraft({});
            setError('');
          }
        }}
      >
        Reset all shortcuts
      </Button>
    </section>
  );
}
