import { describe, expect, it } from 'vitest';
import {
  acceptsShortcutEvent,
  actionsForContext,
  bindingError,
  bindingFor,
  inScope,
  keyStroke,
  normalizeBinding,
  sanitizePreferences,
  shortcutActions,
} from '../lib/shortcuts';
const event = (
  key: string,
  mods: Partial<{
    ctrlKey: boolean;
    metaKey: boolean;
    altKey: boolean;
    shiftKey: boolean;
  }> = {},
) => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});
describe('contextual shortcuts', () => {
  it('offers a remappable Task link action without hijacking System Map or typing', () => {
    const action = shortcutActions.find((item) => item.id === 'openLink')!;
    expect(action.keys).toBe('O');
    expect(bindingFor(action, { openLink: 'Shift+O' })).toBe('Shift+O');
    expect(bindingError('openLink', 'Shift+O', {})).toBe('');
    expect(inScope(action, 'Tasks')).toBe(true);
    expect(inScope(action, 'System Map')).toBe(false);
    expect(
      actionsForContext('Tasks', true, false).map((item) => item.id),
    ).not.toContain('openLink');
    expect(
      actionsForContext('Tasks', false, true).map((item) => item.id),
    ).not.toContain('openLink');
  });
  it('leaves prevented, repeat, and IME events alone', () => {
    const normal = {
      defaultPrevented: false,
      repeat: false,
      isComposing: false,
    };
    expect(acceptsShortcutEvent(normal)).toBe(true);
    expect(acceptsShortcutEvent({ ...normal, repeat: true })).toBe(false);
    expect(acceptsShortcutEvent({ ...normal, defaultPrevented: true })).toBe(
      false,
    );
    expect(acceptsShortcutEvent({ ...normal, isComposing: true })).toBe(false);
    expect(acceptsShortcutEvent(normal, 229)).toBe(false);
  });
  it('protects typing, text undo and dialog priority', () => {
    const typing = actionsForContext('System Map', true, false).map(
      (a) => a.id,
    );
    expect(typing).toContain('submit');
    for (const id of [
      'undo',
      'redo',
      'map.child',
      'map.create',
      'map.delete',
      'nav.Today',
    ])
      expect(typing).not.toContain(id);
    expect(actionsForContext('Tasks', false, true).map((a) => a.id)).toEqual([
      'submit',
      'cancel',
    ]);
    expect(bindingError('submit', 'Q', {})).toMatch(/typing/);
    expect(bindingError('palette', 'Mod+C', {})).toMatch(/text editing/);
  });
  it('has unique action identities and no conflicting defaults', () => {
    expect(new Set(shortcutActions.map((a) => a.id)).size).toBe(
      shortcutActions.length,
    );
    for (const action of shortcutActions)
      expect(bindingError(action.id, action.keys, {}), action.id).toBe('');
  });
  it('normalizes Ctrl and Cmd to one portable modifier', () => {
    expect(keyStroke(event('k', { ctrlKey: true }))).toBe('Mod+K');
    expect(keyStroke(event('k', { metaKey: true }))).toBe('Mod+K');
    expect(normalizeBinding('cmd+shift+k')).toBe('Mod+Shift+K');
  });
  it('canonicalizes shifted punctuation and preserves real shift combinations', () => {
    expect(keyStroke(event('?', { shiftKey: true }))).toBe('?');
    expect(normalizeBinding('Shift+?')).toBe('?');
    expect(normalizeBinding('Shift+/')).toBe('?');
    expect(normalizeBinding('Shift+=')).toBe('+');
    expect(bindingError('map.create', 'Shift+1', {})).toMatch(/shifted digits/);
    expect(normalizeBinding('Mod+Shift++')).toBe('Mod++');
    expect(keyStroke(event('+', { ctrlKey: true, shiftKey: true }))).toBe(
      'Mod++',
    );
    expect(keyStroke(event('B', { shiftKey: true }))).toBe('Shift+B');
  });
  it('ignores modifier, dead and unknown keys', () => {
    for (const key of ['Shift', 'Control', 'Meta', 'Dead', 'Unidentified'])
      expect(keyStroke(event(key))).toBe('');
  });
  it('normalizes aliases and sequence keys', () => {
    expect(normalizeBinding('g t')).toBe('G T');
    expect(normalizeBinding('alt+arrowleft')).toBe('Alt+ArrowLeft');
    expect(normalizeBinding('esc')).toBe('Escape');
  });
  it('keeps map and other module keys separate', () => {
    const moduleAction = shortcutActions.find((a) => a.id === 'create')!;
    expect(inScope(moduleAction, 'Tasks')).toBe(true);
    expect(inScope(moduleAction, 'System Map')).toBe(false);
    expect(
      inScope(
        shortcutActions.find((a) => a.id === 'map.child')!,
        'Tasks',
      ),
    ).toBe(false);
  });
  it('reserves browser keys and native Tab', () => {
    for (const key of [
      'Mod+W',
      'Mod+L',
      'Mod+T',
      'Mod+N',
      'Mod+R',
      'Alt+F4',
      'Tab',
      'Shift+Tab',
    ])
      expect(bindingError('create', key, {})).not.toBe('');
  });
  it('detects exact and prefix collisions across global/module contexts', () => {
    expect(bindingError('create', 'Mod+K', {})).toMatch(/Conflicts/);
    expect(bindingError('map.group', 'G', {})).toMatch(/Conflicts/);
    expect(bindingError('create', 'G T', {})).toMatch(/Conflicts/);
    expect(bindingError('map.group', 'N X', {})).toMatch(/Conflicts/);
  });
  it('allows disable and safe reassignment', () => {
    expect(bindingError('create', '', {})).toBe('');
    expect(bindingError('create', 'E', { edit: 'Y' })).toBe('');
    expect(
      bindingFor(
        shortcutActions.find((a) => a.id === 'edit')!,
        { edit: '' },
      ),
    ).toBe('');
  });
  it('round-trips valid swaps independently of catalog order', () => {
    const preferences = {
      'nav.Today': 'G G',
      'nav.Goals': 'G T',
      edit: 'Y',
      create: 'E',
    };
    expect(sanitizePreferences(preferences)).toEqual(preferences);
  });
  it('rejects unreachable multi-key typing actions', () => {
    expect(bindingError('submit', 'Q W', {})).toMatch(/single/);
    expect(bindingError('palette', 'Q W', {})).toMatch(/single/);
  });
  it('drops malformed, reserved, unknown and conflicting stored data', () => {
    expect(
      sanitizePreferences({
        create: 'Mod+W',
        edit: {},
        evil: 'Y',
        find: '',
        'map.group': 'G',
      }),
    ).toEqual({ find: '' });
    expect(sanitizePreferences(null)).toEqual({});
    expect(sanitizePreferences([])).toEqual({});
  });
});
