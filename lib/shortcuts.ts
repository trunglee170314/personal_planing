export type ShortcutAction = {
  id: string;
  title: string;
  scope: string;
  keys: string;
  input?: boolean;
};
const action = (
  id: string,
  title: string,
  keys: string,
  scope = '*',
  input = false,
): ShortcutAction => ({ id, title, keys, scope, input });
export const navigationKeys: Record<string, string> = {
  Today: 'T',
  Goals: 'G',
  Tasks: 'K',
  Checklists: 'H',
  Reminders: 'R',
  Calendar: 'C',
  Timeline: 'L',
  Mindmap: 'M',
  'System Map': 'S',
  Import: 'I',
  Pomodoro: 'P',
  Reviews: 'V',
  Insights: 'A',
  Settings: 'O',
  Users: 'U',
};
export const shortcutActions: ShortcutAction[] = [
  action('palette', 'Open command palette', 'Mod+K', '*', true),
  action('help', 'Show keyboard shortcuts', '?'),
  action(
    'submit',
    'Save focused form / send focused comment',
    'Mod+Enter',
    '*',
    true,
  ),
  action('cancel', 'Cancel / close', 'Escape', '*', true),
  action('undo', 'Undo recent edit', 'Mod+Z'),
  action('redo', 'Redo System Map edit', 'Mod+Shift+Z', 'System Map'),
  action('search', 'Search workspace data', 'Mod+Shift+K'),
  ...Object.entries(navigationKeys).map(([title, key]) =>
    action(`nav.${title}`, `Go to ${title}`, `G ${key}`),
  ),
  action('create', 'Create item', 'N', 'module'),
  action('edit', 'Edit selected item', 'E', 'module'),
  action('openLink', 'Open selected Task link', 'O', 'module'),
  action('delete', 'Delete selected item', 'Delete', 'module'),
  action('archive', 'Archive selected item', 'X', 'module'),
  action('restore', 'Restore selected item', 'Shift+X', 'module'),
  action('done', 'Toggle selected item completion', 'D', 'module'),
  action('collapse', 'Collapse / expand selected branch', 'B', 'module'),
  action('selectPrevious', 'Select previous item', 'ArrowUp', 'module'),
  action('selectNext', 'Select next item', 'ArrowDown', 'module'),
  action('find', 'Focus section search', '/', 'module'),
  action('previous', 'Previous period', '[', 'module'),
  action('next', 'Next period', ']', 'module'),
  action('today', 'Go to today', 'T', 'module'),
  action('map.create', 'Quick-create node at pointer', 'N', 'System Map'),
  action('map.child', 'Create connected node', 'Mod+Enter', 'System Map'),
  action('map.sibling', 'Create nearby node', 'Shift+Enter', 'System Map'),
  action('map.edit', 'Edit selected node / group', 'E', 'System Map'),
  action('map.rename', 'Rename node inline', 'F2', 'System Map'),
  action('map.area', 'Area selection mode (then drag)', 'R', 'System Map'),
  action('map.all', 'Select visible nodes', 'Mod+A', 'System Map'),
  action('map.copy', 'Copy selected nodes / group', 'Mod+C', 'System Map'),
  action('map.paste', 'Paste copied cluster', 'Mod+V', 'System Map'),
  action(
    'map.duplicate',
    'Duplicate selected cluster',
    'Shift+D',
    'System Map',
  ),
  action('map.delete', 'Delete selection', 'Delete', 'System Map'),
  action('map.group', 'Draw a group', 'B', 'System Map'),
  action(
    'map.collapse',
    'Collapse / expand selected group',
    'Shift+B',
    'System Map',
  ),
  action('map.connect', 'Connect selected node to a target', 'C', 'System Map'),
  action('map.confirm', 'Confirm connection target', 'Enter', 'System Map'),
  action('map.line', 'Toggle selected connection style', 'L', 'System Map'),
  action('map.arrow', 'Cycle selected connection arrow', 'A', 'System Map'),
  action('map.link', 'Open selected node link', 'O', 'System Map'),
  action('map.pan', 'Hold to pan with pointer drag', 'Space', 'System Map'),
  action('map.zoomIn', 'Zoom in', '+', 'System Map'),
  action('map.zoomOut', 'Zoom out', '-', 'System Map'),
  action('map.resetZoom', 'Zoom to 100%', '0', 'System Map'),
  action('map.fit', 'Fit map', 'F', 'System Map'),
  action('map.find', 'Focus node search', '/', 'System Map'),
  action('map.layout', 'Open auto-layout menu', 'J', 'System Map'),
  action(
    'map.branch',
    'Arrange selected branch Right',
    'Shift+J',
    'System Map',
  ),
  action('map.keep', 'Toggle Keep position', 'Shift+P', 'System Map'),
  action('map.fitResults', 'Fit search results', 'Shift+F', 'System Map'),
  action('map.nextResult', 'Next node search result', 'F3', 'System Map', true),
  action(
    'map.previousResult',
    'Previous node search result',
    'Alt+F3',
    'System Map',
    true,
  ),
  ...(
    [
      'left',
      'center',
      'right',
      'top',
      'middle',
      'bottom',
      'horizontal',
      'vertical',
    ] as const
  ).map((kind, i) =>
    action(
      `map.align.${kind}`,
      `${kind === 'horizontal' || kind === 'vertical' ? 'Distribute' : 'Align'} selected nodes ${kind}`,
      `Alt+Shift+${['L', 'C', 'R', 'T', 'M', 'B', 'H', 'V'][i]}`,
      'System Map',
    ),
  ),
  action('map.new', 'New map', 'M', 'System Map'),
  action('map.settings', 'Edit map', 'Shift+M', 'System Map'),
  action('map.history', 'Open map history', 'H', 'System Map'),
  action('map.trash', 'Open map trash', 'T', 'System Map'),
  action('map.trashMap', 'Move active map to trash', 'Shift+T', 'System Map'),
  action('map.shortcuts', 'Open shortcut settings', 'K', 'System Map'),
  ...['Left', 'Right', 'Up', 'Down'].flatMap((direction) => [
    action(
      `map.select${direction}`,
      `Select node ${direction.toLowerCase()}`,
      `Arrow${direction}`,
      'System Map',
    ),
    action(
      `map.extend${direction}`,
      `Extend selection ${direction.toLowerCase()}`,
      `Shift+Arrow${direction}`,
      'System Map',
    ),
    action(
      `map.move${direction}`,
      `Move selection ${direction.toLowerCase()}`,
      `Alt+Arrow${direction}`,
      'System Map',
    ),
  ]),
];
export type ShortcutPreferences = Record<string, string>;
export function bindingFor(
  action: ShortcutAction,
  preferences: ShortcutPreferences,
) {
  return preferences[action.id] ?? action.keys;
}
export function inScope(action: ShortcutAction, section: string) {
  return (
    action.scope === '*' ||
    action.scope === section ||
    (action.scope === 'module' && section !== 'System Map')
  );
}
export function actionsForContext(
  section: string,
  editing: boolean,
  overlay: boolean,
) {
  return shortcutActions.filter(
    (a) =>
      inScope(a, section) &&
      (!editing || a.input) &&
      (!overlay || ['submit', 'cancel'].includes(a.id)),
  );
}
export function acceptsShortcutEvent(
  event: { defaultPrevented: boolean; repeat: boolean; isComposing: boolean },
  legacyCode?: unknown,
) {
  return (
    !event.defaultPrevented &&
    !event.repeat &&
    !event.isComposing &&
    legacyCode !== 229
  );
}
export function keyStroke(
  event: Pick<
    KeyboardEvent,
    'key' | 'ctrlKey' | 'metaKey' | 'altKey' | 'shiftKey'
  >,
) {
  let key =
    event.key === ' '
      ? 'Space'
      : event.key.length === 1
        ? event.key.toUpperCase()
        : event.key;
  if (key === 'Esc') key = 'Escape';
  if (['Control', 'Meta', 'Alt', 'Shift', 'Dead', 'Unidentified'].includes(key))
    return '';
  return [
    event.ctrlKey || event.metaKey ? 'Mod' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey && !['?', '+'].includes(key) ? 'Shift' : '',
    key,
  ]
    .filter(Boolean)
    .join('+');
}
export function normalizeBinding(raw: string) {
  return raw
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((stroke) => {
      if (stroke === '+') return '+';
      const parts = (stroke.endsWith('+') ? stroke.slice(0, -1) : stroke)
        .split('+')
        .filter(Boolean);
      let key = stroke.endsWith('+') ? '+' : parts.pop()!;
      const mods = new Set<string>(
        parts.map((p) =>
          /^(ctrl|cmd|meta|mod)$/i.test(p)
            ? 'Mod'
            : p.toLowerCase() === 'alt'
              ? 'Alt'
              : p.toLowerCase() === 'shift'
                ? 'Shift'
                : '?',
        ),
      );
      if (mods.has('Shift') && key === '/') key = '?';
      if (mods.has('Shift') && key === '=') key = '+';
      if (key === '?' || key === '+') mods.delete('Shift');
      const aliases: Record<string, string> = {
        esc: 'Escape',
        escape: 'Escape',
        enter: 'Enter',
        delete: 'Delete',
        space: 'Space',
        tab: 'Tab',
        arrowleft: 'ArrowLeft',
        arrowright: 'ArrowRight',
        arrowup: 'ArrowUp',
        arrowdown: 'ArrowDown',
      };
      return [
        ...['Mod', 'Alt', 'Shift', '?'].filter((p) => mods.has(p)),
        aliases[key.toLowerCase()] ?? key.toUpperCase(),
      ].join('+');
    })
    .join(' ');
}
function scopesOverlap(a: ShortcutAction, b: ShortcutAction) {
  if (a.scope === '*' || b.scope === '*') return true;
  if (a.scope === 'module') return b.scope !== 'System Map';
  if (b.scope === 'module') return a.scope !== 'System Map';
  return a.scope === b.scope;
}
export function bindingError(
  id: string,
  value: string,
  preferences: ShortcutPreferences,
) {
  if (!value) return '';
  const strokes = value.split(' ');
  if (
    strokes.length > 2 ||
    strokes.some(
      (s) =>
        !/^(?:(?:Mod|Alt|Shift)\+)*(?:[A-Z0-9/?=[\]-]|\+|F(?:[1-9]|1[0-2])|Enter|Escape|Delete|Space|Arrow(?:Left|Right|Up|Down))$/.test(
          s,
        ),
    )
  )
    return 'Use a key or a two-key sequence, e.g. Mod+K or G T.';
  if (
    strokes.some((s) => {
      const key = s.split('+').at(-1)!;
      return s.includes('Shift+') && key.length === 1 && !/^[A-Z]$/.test(key);
    })
  )
    return 'Use the resulting symbol for shifted punctuation; shifted digits are not supported.';
  if (
    strokes.some((s) =>
      /^(?:Mod\+(?:W|L|T|N|R|Q)|Alt\+F4|Mod\+Shift\+(?:W|T|N)|Tab|Shift\+Tab)$/.test(
        s,
      ),
    )
  )
    return 'This shortcut is reserved for the browser / operating system.';
  const candidate = shortcutActions.find((a) => a.id === id);
  if (!candidate) return 'Unknown action.';
  if (candidate.input && strokes.length > 1)
    return 'Actions that work while typing require a single combination.';
  if (
    candidate.input &&
    (!/^(?:Mod\+|Alt\+|Escape$|F(?:[1-9]|1[0-2])$)/.test(value) ||
      /^Mod\+(?:Shift\+)?[ACVXYZ]$/.test(value))
  )
    return 'Do not replace typing or native text editing shortcuts.';
  const conflict = shortcutActions.find((a) => {
    if (a.id === id || !scopesOverlap(candidate, a)) return false;
    // Submit applies to a focused composer; map child applies only outside it.
    if ([a.id, id].sort().join(':') === 'map.child:submit') return false;
    const other = bindingFor(a, preferences);
    return (
      other &&
      (other === value ||
        other.startsWith(value + ' ') ||
        value.startsWith(other + ' '))
    );
  });
  return conflict ? `Conflicts with “${conflict.title}”.` : '';
}
export function sanitizePreferences(raw: unknown): ShortcutPreferences {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const next: ShortcutPreferences = {};
  for (const a of shortcutActions) {
    const value = Reflect.get(raw, a.id);
    if (typeof value !== 'string' || value.length > 60) continue;
    next[a.id] = normalizeBinding(value);
  }
  // Validate the complete candidate graph, preserving swaps across reloads.
  // Removing a bad override may uncover another collision with a default.
  let changed = true;
  while (changed) {
    changed = false;
    const invalid = Object.entries(next)
      .filter(([id, value]) => bindingError(id, value, next))
      .map(([id]) => id);
    for (const id of invalid) {
      delete next[id];
      changed = true;
    }
  }
  return next;
}
