'use client';
/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- The interactive map is an ARIA application; SVG paths supply focusable connection controls, where HTML buttons are not valid SVG children. */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import {
  ChevronDown,
  ChevronRight,
  ExternalLink,
  Group,
  History,
  LayoutGrid,
  LoaderCircle,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Scan,
  Search,
  Trash2,
  X,
} from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { systemMaps } from '@/lib/data/system-maps';
import { getErrorMessage } from '@/lib/data/repository';
import {
  validateMapDocument,
  NODE_WIDTH,
  NODE_HEIGHT,
  GROUP_HEADER,
} from '@/lib/system-map/schema.mjs';
import {
  arrangeMap,
  containingGroup,
  emptyMap,
  mapColors,
  moveGroup,
  removeGroup,
  removeNode,
  resizeGroup,
  type MapDocument,
  type MapEdge,
  type MapGroup,
  type MapNode,
  type MapRevision,
  type MapSummary,
  type SystemMap,
} from '@/lib/system-map/model';
import './system-map.css';

type Point = { x: number; y: number };
type Selection = { kind: 'node' | 'group' | 'edge'; id: string } | null;
type Editor = {
  kind: 'map' | 'node' | 'group';
  id?: string;
  name: string;
  description: string;
  url: string;
  color: string;
  group_id: string;
  point?: Point;
  rect?: Pick<MapGroup, 'x' | 'y' | 'width' | 'height'>;
};
type Gesture = {
  pointerId: number;
  capture: Element;
  kind: 'pan' | 'node' | 'group' | 'resize' | 'connect' | 'draw';
  start: Point;
  client: Point;
  doc: MapDocument;
  id?: string;
  handle?: string;
  pan: Point;
  moved: boolean;
};
const clamp = (n: number) => Math.max(-19000, Math.min(19000, n));
const nextId = () => crypto.randomUUID();
const visibleNodes = (doc: MapDocument) =>
  doc.nodes.filter(
    (n) => !doc.groups.find((g) => g.id === n.group_id)?.collapsed,
  );
function documentBounds(doc: MapDocument) {
  const items = [
    ...visibleNodes(doc).map((n) => ({
      x: n.x,
      y: n.y,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
    })),
    ...doc.groups.map((g) => ({
      ...g,
      height: g.collapsed ? GROUP_HEADER : g.height,
    })),
  ];
  if (!items.length) return { x: 0, y: 0, width: 800, height: 480 };
  const x = Math.min(...items.map((i) => i.x)) - 35,
    y = Math.min(...items.map((i) => i.y)) - 35;
  return {
    x,
    y,
    width: Math.max(...items.map((i) => i.x + i.width)) - x + 35,
    height: Math.max(...items.map((i) => i.y + i.height)) - y + 35,
  };
}
function connectionPath(a: MapNode, b: MapNode) {
  if (Math.abs(a.x - b.x) < NODE_WIDTH && Math.abs(a.y - b.y) > NODE_HEIGHT) {
    const down = b.y > a.y,
      x1 = a.x + NODE_WIDTH / 2,
      y1 = a.y + (down ? NODE_HEIGHT : 0),
      x2 = b.x + NODE_WIDTH / 2,
      y2 = b.y + (down ? 0 : NODE_HEIGHT),
      mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  const right = b.x > a.x,
    x1 = a.x + (right ? NODE_WIDTH : 0),
    y1 = a.y + NODE_HEIGHT / 2,
    x2 = b.x + (right ? 0 : NODE_WIDTH),
    y2 = b.y + NODE_HEIGHT / 2,
    bend = Math.max(50, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}

export function SystemMapPanel() {
  'use no memo'; // Pointer gestures intentionally bridge mutable refs and state.
  const [maps, setMaps] = useState<MapSummary[]>([]),
    [map, setMap] = useState<SystemMap | null>(null),
    [doc, setDoc] = useState<MapDocument | null>(null);
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [message, setMessage] = useState(''),
    [selection, setSelection] = useState<Selection>(null);
  const [viewport, setViewport] = useState({ x: 30, y: 30, zoom: 1 }),
    [size, setSize] = useState({ width: 800, height: 480 }),
    [query, setQuery] = useState('');
  const [context, setContext] = useState<{
      screen: Point;
      world: Point;
    } | null>(null),
    [editor, setEditor] = useState<Editor | null>(null);
  const [drawMode, setDrawMode] = useState(false),
    [drawRect, setDrawRect] = useState<Pick<
      MapGroup,
      'x' | 'y' | 'width' | 'height'
    > | null>(null),
    [connector, setConnector] = useState<{
      source: string;
      point: Point;
    } | null>(null),
    [dragging, setDragging] = useState(false);
  const [edgeMenu, setEdgeMenu] = useState<'line' | 'direction' | null>(null),
    [layoutMenu, setLayoutMenu] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false),
    [revisions, setRevisions] = useState<MapRevision[]>([]),
    [historyPage, setHistoryPage] = useState(0);
  const [trashOpen, setTrashOpen] = useState(false),
    [trash, setTrash] = useState<MapSummary[]>([]);
  const canvasRef = useRef<HTMLDivElement>(null),
    mapRef = useRef<SystemMap | null>(null),
    docRef = useRef<MapDocument | null>(null),
    viewportRef = useRef(viewport);
  const savingRef = useRef(false),
    unsavedRef = useRef(false),
    failedRef = useRef(false),
    mountedRef = useRef(true),
    loadRef = useRef(0),
    gesture = useRef<Gesture | null>(null),
    holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const markerId = useId().replace(/:/g, '');
  const editable = !!doc && !busy && !failed;
  const setDraft = useCallback((value: MapDocument) => {
    docRef.current = value;
    // Render from an immutable snapshot; gesture refs own the working copy.
    setDoc(structuredClone(value));
  }, []);
  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  const dispose = useCallback(() => {
    mountedRef.current = false;
    ++loadRef.current;
    cancelHold();
  }, [cancelHold]);
  const changeViewport = useCallback((value: typeof viewport) => {
    viewportRef.current = value;
    setViewport(value);
  }, []);
  const fit = useCallback(
    (value: MapDocument) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const b = documentBounds(value),
        zoom = Math.min(
          1.3,
          Math.max(
            0.15,
            Math.min(
              canvas.clientWidth / b.width,
              canvas.clientHeight / b.height,
            ) * 0.9,
          ),
        );
      changeViewport({
        zoom,
        x: (canvas.clientWidth - b.width * zoom) / 2 - b.x * zoom,
        y: (canvas.clientHeight - b.height * zoom) / 2 - b.y * zoom,
      });
    },
    [changeViewport],
  );
  const refreshList = useCallback(async () => {
    const items = await systemMaps.list();
    if (mountedRef.current) setMaps(items);
    return items;
  }, []);
  const adopt = useCallback(
    (value: SystemMap) => {
      mapRef.current = value;
      setMap(value);
      setDraft(value.document);
      unsavedRef.current = false;
      failedRef.current = false;
      setFailed(false);
      setSelection(null);
      setMessage('');
    },
    [setDraft],
  );
  const loadMap = useCallback(
    async (id: string) => {
      if (
        savingRef.current ||
        (unsavedRef.current &&
          !window.confirm('Discard unsaved changes and reload?'))
      )
        return;
      const request = ++loadRef.current;
      savingRef.current = true;
      setBusy(true);
      try {
        const value = await systemMaps.get(id);
        if (request === loadRef.current && mountedRef.current) {
          adopt(value);
          requestAnimationFrame(() => fit(value.document));
        }
      } catch (error) {
        if (mountedRef.current) setMessage(getErrorMessage(error));
      } finally {
        savingRef.current = false;
        if (mountedRef.current) setBusy(false);
      }
    },
    [adopt, fit],
  );
  useEffect(() => {
    mountedRef.current = true;
    const request = ++loadRef.current;
    void refreshList()
      .then((items) => {
        if (mountedRef.current && request === loadRef.current && items[0])
          void loadMap(items[0].id);
      })
      .catch((error) => {
        if (mountedRef.current) setMessage(getErrorMessage(error));
      });
    return dispose;
  }, [refreshList, loadMap, dispose]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (
        savingRef.current ||
        (unsavedRef.current &&
          !window.confirm('Leave this map and discard unsaved changes?'))
      )
        event.preventDefault();
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (savingRef.current || unsavedRef.current) {
        event.preventDefault();
        Reflect.set(event, 'returnValue', '');
      }
    };
    window.addEventListener('system-map-before-navigation', guard);
    window.addEventListener('beforeunload', unload);
    return () => {
      window.removeEventListener('system-map-before-navigation', guard);
      window.removeEventListener('beforeunload', unload);
    };
  }, []);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const observer = new ResizeObserver(() =>
      setSize({ width: canvas.clientWidth, height: canvas.clientHeight }),
    );
    observer.observe(canvas);
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const v = viewportRef.current;
      if (event.ctrlKey || event.metaKey) {
        const bounds = canvas.getBoundingClientRect(),
          x = event.clientX - bounds.left,
          y = event.clientY - bounds.top,
          zoom = Math.min(
            2,
            Math.max(0.15, v.zoom * Math.exp(-event.deltaY * 0.003)),
          );
        changeViewport({
          zoom,
          x: x - ((x - v.x) * zoom) / v.zoom,
          y: y - ((y - v.y) * zoom) / v.zoom,
        });
      } else
        changeViewport({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY });
      setContext(null);
      setSelection(null);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      canvas.removeEventListener('wheel', wheel);
    };
  }, [changeViewport]);
  async function save(next: MapDocument, label: string) {
    const current = mapRef.current;
    if (!current || savingRef.current || failedRef.current) return false;
    try {
      validateMapDocument(next);
    } catch (error) {
      setDraft(current.document);
      setMessage(getErrorMessage(error));
      return false;
    }
    setDraft(next);
    unsavedRef.current = true;
    savingRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await systemMaps.command({
        action: 'save',
        id: current.id,
        expected_version: current.version,
        document: next,
        label,
      });
      if (!result) throw new Error('Map save returned no data.');
      mapRef.current = result;
      unsavedRef.current = false;
      if (mountedRef.current) {
        setMap(result);
        setDraft(result.document);
        setMaps((items) =>
          items.map((item) =>
            item.id === result.id
              ? {
                  ...item,
                  name: result.name,
                  version: result.version,
                  updated_at: result.updated_at,
                }
              : item,
          ),
        );
      }
      return true;
    } catch (error) {
      failedRef.current = true;
      if (mountedRef.current) {
        setFailed(true);
        setMessage(getErrorMessage(error));
      }
      return false;
    } finally {
      savingRef.current = false;
      if (mountedRef.current) setBusy(false);
    }
  }
  async function runAction(
    action: 'trash' | 'restore' | 'purge' | 'restore_revision',
    target: MapSummary,
    revision?: number,
  ) {
    if (savingRef.current || unsavedRef.current) return;
    if (
      !window.confirm(
        action === 'purge'
          ? `Permanently delete “${target.name}” and its history?`
          : action === 'trash'
            ? `Move “${target.name}” to Trash?`
            : action === 'restore_revision'
              ? 'Restore this snapshot? The current version remains in History.'
              : `Restore “${target.name}”?`,
      )
    )
      return;
    savingRef.current = true;
    setBusy(true);
    setMessage('');
    try {
      const result = await systemMaps.command({
        action,
        id: target.id,
        expected_version: target.version,
        revision,
      });
      if (action === 'trash') {
        mapRef.current = null;
        docRef.current = null;
        setMap(null);
        setDoc(null);
        setSelection(null);
      } else if (
        result &&
        (action === 'restore_revision' || action === 'restore')
      ) {
        adopt(result);
        requestAnimationFrame(() => fit(result.document));
      }
      await refreshList();
      if (trashOpen) setTrash(await systemMaps.list(true));
      if (historyOpen && result)
        setRevisions(await systemMaps.history(result.id));
    } catch (error) {
      setMessage(getErrorMessage(error));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  }
  function openEditor(
    kind: Editor['kind'],
    id?: string,
    point?: Point,
    rect?: Editor['rect'],
  ) {
    if (busy || failed || (kind !== 'map' && !docRef.current)) return;
    const source =
      kind === 'node'
        ? docRef.current?.nodes.find((n) => n.id === id)
        : kind === 'group'
          ? docRef.current?.groups.find((g) => g.id === id)
          : id
            ? docRef.current
            : null;
    setEditor({
      kind,
      id,
      name: source?.name ?? (kind === 'map' ? 'New map' : ''),
      description: source && 'description' in source ? source.description : '',
      url: source && 'url' in source ? source.url : '',
      color: source && 'color' in source ? source.color : mapColors[0],
      group_id:
        source && 'group_id' in source
          ? (source.group_id ?? '')
          : kind === 'node' && point && docRef.current
            ? (containingGroup(docRef.current, point) ?? '')
            : '',
      point,
      rect,
    });
    setContext(null);
  }
  async function submitEditor() {
    if (!editor || busy || failed) return;
    const current = docRef.current;
    if (editor.kind === 'map' && !editor.id) {
      const next = {
        ...emptyMap(editor.name.trim()),
        description: editor.description,
      };
      try {
        validateMapDocument(next);
      } catch (error) {
        setMessage(getErrorMessage(error));
        return;
      }
      savingRef.current = true;
      setBusy(true);
      try {
        const value = await systemMaps.command({
          action: 'create',
          id: nextId(),
          expected_version: 0,
          document: next,
        });
        if (value) {
          adopt(value);
          setEditor(null);
          fit(value.document);
          await refreshList();
        }
      } catch (error) {
        setMessage(getErrorMessage(error));
      } finally {
        savingRef.current = false;
        setBusy(false);
      }
      return;
    }
    if (!current) return;
    let next = current;
    if (editor.kind === 'map')
      next = {
        ...current,
        name: editor.name.trim(),
        description: editor.description,
      };
    if (editor.kind === 'node') {
      const old = current.nodes.find((n) => n.id === editor.id),
        point = old ?? editor.point ?? { x: 80, y: 100 };
      const node: MapNode = {
        id: editor.id ?? nextId(),
        name: editor.name.trim(),
        description: editor.description,
        url: editor.url.trim(),
        color: editor.color,
        group_id: editor.group_id || null,
        x: point.x,
        y: point.y,
      };
      const group = current.groups.find((g) => g.id === node.group_id);
      if (
        group &&
        containingGroup({ ...current, groups: [group] }, node) !== group.id
      ) {
        node.x = group.x + 20;
        node.y = group.y + GROUP_HEADER + 16;
      }
      next = {
        ...current,
        nodes: editor.id
          ? current.nodes.map((n) => (n.id === node.id ? node : n))
          : [...current.nodes, node],
      };
    }
    if (editor.kind === 'group') {
      const old = current.groups.find((g) => g.id === editor.id),
        group: MapGroup = {
          id: editor.id ?? nextId(),
          name: editor.name.trim(),
          color: editor.color,
          collapsed: old?.collapsed ?? false,
          ...(old ?? editor.rect ?? { x: 60, y: 80, width: 300, height: 200 }),
        };
      group.name = editor.name.trim();
      group.color = editor.color;
      next = {
        ...current,
        groups: editor.id
          ? current.groups.map((g) => (g.id === group.id ? group : g))
          : [...current.groups, group],
      };
    }
    if (await save(next, `${editor.id ? 'Edit' : 'Add'} ${editor.kind}`))
      setEditor(null);
  }
  function worldPoint(client: Point): Point {
    const bounds = canvasRef.current!.getBoundingClientRect(),
      v = viewportRef.current;
    return {
      x: (client.x - bounds.left - v.x) / v.zoom,
      y: (client.y - bounds.top - v.y) / v.zoom,
    };
  }
  function begin(
    event: ReactPointerEvent,
    kind: Gesture['kind'],
    id?: string,
    handle?: string,
  ) {
    if (
      !event.isPrimary ||
      gesture.current ||
      event.button !== 0 ||
      !docRef.current ||
      (kind !== 'pan' && !editable)
    )
      return;
    event.stopPropagation();
    setContext(null);
    setEdgeMenu(null);
    setLayoutMenu(false);
    const start = worldPoint({ x: event.clientX, y: event.clientY });
    gesture.current = {
      pointerId: event.pointerId,
      capture: event.currentTarget,
      kind,
      id,
      handle,
      start,
      client: { x: event.clientX, y: event.clientY },
      doc: docRef.current,
      pan: viewportRef.current,
      moved: false,
    };
    // Capture the initiating target so native click/double-click still reaches
    // node buttons and group headings; move/up events bubble to the canvas.
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === 'connect') {
      setSelection(null);
      setConnector({ source: id!, point: start });
      setDragging(true);
    }
    if (kind === 'pan') {
      setSelection(null);
      if (event.pointerType === 'touch')
        holdTimer.current = setTimeout(() => {
          const active = gesture.current;
          if (!active || active.pointerId !== event.pointerId) return;
          if (active.capture.hasPointerCapture(active.pointerId))
            active.capture.releasePointerCapture(active.pointerId);
          gesture.current = null;
          const bounds = canvasRef.current!.getBoundingClientRect();
          setContext({
            screen: {
              x: event.clientX - bounds.left,
              y: event.clientY - bounds.top,
            },
            world: start,
          });
        }, 550);
    }
  }
  function move(event: ReactPointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    const point = worldPoint({ x: event.clientX, y: event.clientY }),
      dx = point.x - g.start.x,
      dy = point.y - g.start.y;
    if (
      Math.abs(event.clientX - g.client.x) +
        Math.abs(event.clientY - g.client.y) >
      3
    ) {
      g.moved = true;
      setDragging(true);
      if (holdTimer.current) clearTimeout(holdTimer.current);
    }
    if (g.kind === 'pan') {
      changeViewport({
        ...viewportRef.current,
        x: g.pan.x + event.clientX - g.client.x,
        y: g.pan.y + event.clientY - g.client.y,
      });
      return;
    }
    if (g.kind === 'node')
      setDraft({
        ...g.doc,
        nodes: g.doc.nodes.map((n) =>
          n.id === g.id ? { ...n, x: clamp(n.x + dx), y: clamp(n.y + dy) } : n,
        ),
      });
    if (g.kind === 'group') setDraft(moveGroup(g.doc, g.id!, dx, dy));
    if (g.kind === 'resize') {
      const original = g.doc.groups.find((item) => item.id === g.id)!;
      const left = g.handle!.includes('w'),
        top = g.handle!.includes('n');
      setDraft(
        resizeGroup(g.doc, g.id!, {
          x: left
            ? Math.min(original.x + dx, original.x + original.width - 220)
            : original.x,
          y: top
            ? Math.min(original.y + dy, original.y + original.height - 130)
            : original.y,
          width:
            original.width + (left ? -dx : g.handle!.includes('e') ? dx : 0),
          height:
            original.height + (top ? -dy : g.handle!.includes('s') ? dy : 0),
        }),
      );
    }
    if (g.kind === 'connect') setConnector({ source: g.id!, point });
    if (g.kind === 'draw')
      setDrawRect({
        x: Math.min(point.x, g.start.x),
        y: Math.min(point.y, g.start.y),
        width: Math.abs(dx),
        height: Math.abs(dy),
      });
  }
  function finish(event: ReactPointerEvent) {
    const g = gesture.current;
    if (!g || g.pointerId !== event.pointerId) return;
    gesture.current = null;
    setDragging(false);
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (g.capture.hasPointerCapture(event.pointerId))
      g.capture.releasePointerCapture(event.pointerId);
    if (g.kind === 'pan') return;
    if (g.kind === 'draw') {
      setDrawMode(false);
      setDrawRect(null);
      const end = worldPoint({ x: event.clientX, y: event.clientY });
      openEditor('group', undefined, undefined, {
        x: Math.min(g.start.x, end.x),
        y: Math.min(g.start.y, end.y),
        width: Math.max(220, Math.abs(end.x - g.start.x)),
        height: Math.max(130, Math.abs(end.y - g.start.y)),
      });
      return;
    }
    if (g.kind === 'connect') {
      setConnector(null);
      const target = document
        .elementFromPoint(event.clientX, event.clientY)
        ?.closest('[data-node-id]')
        ?.getAttribute('data-node-id');
      if (!target || target === g.id) return;
      const existing = g.doc.edges.find(
        (e) =>
          [e.source, e.target].includes(target) &&
          [e.source, e.target].includes(g.id!),
      );
      if (existing) {
        setSelection({ kind: 'edge', id: existing.id });
        return;
      }
      const edge: MapEdge = {
        id: nextId(),
        source: g.id!,
        target,
        line: 'solid',
        direction: 'forward',
      };
      void save(
        { ...g.doc, edges: [...g.doc.edges, edge] },
        'Add connection',
      ).then((ok) => {
        if (ok) setSelection({ kind: 'edge', id: edge.id });
      });
      return;
    }
    setSelection({ kind: g.kind === 'node' ? 'node' : 'group', id: g.id! });
    if (!g.moved) return;
    let next = docRef.current!;
    if (g.kind === 'node')
      next = {
        ...next,
        nodes: next.nodes.map((n) =>
          n.id === g.id ? { ...n, group_id: containingGroup(next, n) } : n,
        ),
      };
    void save(next, 'Move layout');
  }
  function cancelGesture(event?: ReactPointerEvent) {
    const g = gesture.current;
    if (event && g && event.pointerId !== g.pointerId) return;
    if (g?.capture.hasPointerCapture(g.pointerId))
      g.capture.releasePointerCapture(g.pointerId);
    if (g && g.kind !== 'pan') setDraft(g.doc);
    gesture.current = null;
    setDragging(false);
    setConnector(null);
    setDrawRect(null);
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }
  function showContext(event: React.MouseEvent) {
    event.preventDefault();
    if (
      !editable ||
      (event.target instanceof Element &&
        event.target.closest(
          '.sm-node,.sm-group-heading,.sm-edge-hit,.sm-controls,.sm-popup,.sm-context,.sm-minimap',
        ))
    ) {
      setContext(null);
      return;
    }
    cancelGesture();
    setSelection(null);
    setEdgeMenu(null);
    setLayoutMenu(false);
    const bounds = canvasRef.current!.getBoundingClientRect();
    setContext({
      screen: { x: event.clientX - bounds.left, y: event.clientY - bounds.top },
      world: worldPoint({ x: event.clientX, y: event.clientY }),
    });
  }
  async function deleteSelection() {
    if (!editable || !selection || !docRef.current) return;
    if (
      !window.confirm(
        selection.kind === 'group'
          ? 'Delete this group? Its nodes stay in the map.'
          : selection.kind === 'node'
            ? 'Delete this node and its connections? You can recover it from History.'
            : 'Delete this connection?',
      )
    )
      return;
    const current = docRef.current,
      next =
        selection.kind === 'node'
          ? removeNode(current, selection.id)
          : selection.kind === 'group'
            ? removeGroup(current, selection.id)
            : {
                ...current,
                edges: current.edges.filter((e) => e.id !== selection.id),
              };
    if (await save(next, `Delete ${selection.kind}`)) {
      setSelection(null);
      setEdgeMenu(null);
    }
  }
  const selectedNode =
      selection?.kind === 'node'
        ? doc?.nodes.find((n) => n.id === selection.id)
        : null,
    selectedGroup =
      selection?.kind === 'group'
        ? doc?.groups.find((g) => g.id === selection.id)
        : null,
    selectedEdge =
      selection?.kind === 'edge'
        ? doc?.edges.find((e) => e.id === selection.id)
        : null;
  const selectedItem = selectedNode ?? selectedGroup;
  const popupPoint = selectedItem
    ? {
        x: Math.max(
          8,
          Math.min(
            size.width - 275,
            selectedItem.x * viewport.zoom + viewport.x,
          ),
        ),
        y: Math.max(
          8,
          Math.min(
            size.height - 65,
            (selectedItem.y + (selectedNode ? NODE_HEIGHT : GROUP_HEADER)) *
              viewport.zoom +
              viewport.y +
              8,
          ),
        ),
      }
    : { x: Math.max(8, size.width / 2 - 130), y: 15 };
  const shownNodes = doc ? visibleNodes(doc) : [],
    bounds = doc
      ? documentBounds(doc)
      : { x: 0, y: 0, width: 800, height: 480 },
    searchMatches =
      doc?.nodes.filter((n) =>
        `${n.name} ${n.description}`
          .toLowerCase()
          .includes(query.toLowerCase()),
      ) ?? [];
  function zoomBy(factor: number) {
    const v = viewportRef.current,
      zoom = Math.min(2, Math.max(0.15, v.zoom * factor));
    changeViewport({
      zoom,
      x: size.width / 2 - ((size.width / 2 - v.x) * zoom) / v.zoom,
      y: size.height / 2 - ((size.height / 2 - v.y) * zoom) / v.zoom,
    });
    setSelection(null);
  }
  async function showHistory(page = 0) {
    if (!mapRef.current) return;
    setHistoryOpen(true);
    try {
      setRevisions(await systemMaps.history(mapRef.current.id, page * 20));
      setHistoryPage(page);
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  function downloadDraft() {
    if (!docRef.current) return;
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(docRef.current, null, 2)], {
          type: 'application/json',
        }),
      ),
      a = document.createElement('a');
    a.href = url;
    a.download = 'the-plan-map-recovery.json';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <section
      className="system-map"
      aria-label="System Map"
      role="application"
      onKeyDown={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest('input,textarea,select,[role=dialog]')
        )
          return;
        if (event.key === 'Escape') {
          cancelGesture();
          setSelection(null);
          setContext(null);
          setDrawMode(false);
          setLayoutMenu(false);
          setEdgeMenu(null);
        }
        if (event.key === 'Delete' || event.key === 'Backspace') {
          event.preventDefault();
          void deleteSelection();
        }
      }}
    >
      <div className="sm-toolbar">
        <div className="sm-title">
          <h1>System Map</h1>
          <select
            aria-label="Choose map"
            value={map?.id ?? ''}
            disabled={busy || failed}
            onChange={(e) => void loadMap(e.target.value)}
          >
            <option value="" disabled>
              Choose a map
            </option>
            {maps.map((item) => (
              <option key={item.id} value={item.id}>
                {item.name}
              </option>
            ))}
          </select>
        </div>
        <div className="sm-map-actions">
          <Button
            variant="outline"
            size="sm"
            disabled={busy || failed}
            onClick={() => openEditor('map')}
          >
            <Plus />
            New Map
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Edit map"
            disabled={!editable}
            onClick={() => openEditor('map', map!.id)}
          >
            <Pencil />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!map || busy || failed}
            onClick={() => void showHistory()}
          >
            <History />
            History
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy || failed}
            onClick={() => {
              setTrashOpen(true);
              void systemMaps
                .list(true)
                .then(setTrash)
                .catch((error) => setMessage(getErrorMessage(error)));
            }}
          >
            <Trash2 />
            Trash
          </Button>
        </div>
      </div>
      <div className="sm-viewbar">
        <label className="sm-search">
          <Search size={16} />
          <input
            aria-label="Search nodes"
            placeholder="Find a node…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => setQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </label>
        <div className="sm-layout">
          <Button
            variant="ghost"
            size="sm"
            disabled={!editable}
            aria-expanded={layoutMenu}
            onClick={() => setLayoutMenu(!layoutMenu)}
          >
            <LayoutGrid />
            Auto layout
            <ChevronDown />
          </Button>
          {layoutMenu && (
            <div className="sm-layout-menu">
              <button
                type="button"
                onClick={() => {
                  setLayoutMenu(false);
                  void save(arrangeMap(doc!, 'grid'), 'Auto layout').then(
                    (ok) => {
                      if (ok) fit(docRef.current!);
                    },
                  );
                }}
              >
                Grid
              </button>
              <button
                type="button"
                onClick={() => {
                  setLayoutMenu(false);
                  void save(arrangeMap(doc!, 'circle'), 'Auto layout').then(
                    (ok) => {
                      if (ok) fit(docRef.current!);
                    },
                  );
                }}
              >
                Circle
              </button>
            </div>
          )}
        </div>
      </div>
      {message && (
        <div className="sm-message" role="alert">
          <span>{message}</span>
          {failed && (
            <>
              <Button variant="outline" size="sm" onClick={downloadDraft}>
                Download unsaved map
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void loadMap(map!.id)}
              >
                <RotateCcw />
                Reload
              </Button>
            </>
          )}
        </div>
      )}
      <div
        ref={canvasRef}
        className={`sm-canvas ${drawMode ? 'sm-drawing' : ''}`}
        aria-label="Map workspace"
        role="application"
        tabIndex={0}
        onContextMenu={showContext}
        onPointerDown={(e) => {
          if (
            e.target instanceof Element &&
            e.target.closest(
              'button,input,select,.sm-popup,.sm-context,.sm-minimap,.sm-edge-hit',
            )
          )
            return;
          begin(e, drawMode ? 'draw' : 'pan');
        }}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={cancelGesture}
      >
        {!doc && (
          <div className="sm-empty">
            <Group size={28} />
            <h2>{busy ? 'Loading map…' : 'Your ideas, connected'}</h2>
            <p>Create a Map for systems, projects or relationships.</p>
            <Button disabled={busy || failed} onClick={() => openEditor('map')}>
              <Plus />
              New Map
            </Button>
          </div>
        )}
        {doc && (
          <div
            className="sm-world"
            style={{
              transform: `translate(${viewport.x}px,${viewport.y}px) scale(${viewport.zoom})`,
            }}
          >
            <div className="sm-groups">
              {/* oxlint-disable-next-line react/react-compiler -- JSX handlers access refs only when events fire. */}
              {doc.groups.map((g) => (
                <div
                  key={g.id}
                  className={`sm-group ${selection?.id === g.id ? 'sm-selected-group' : ''}`}
                  style={{
                    left: g.x,
                    top: g.y,
                    width: g.width,
                    height: g.collapsed ? GROUP_HEADER : g.height,
                    background: `color-mix(in srgb, ${g.color} 7%, var(--background))`,
                  }}
                >
                  <button
                    type="button"
                    className="sm-group-heading"
                    aria-label={`Select group ${g.name}`}
                    aria-expanded={!g.collapsed}
                    onPointerDown={(e) => begin(e, 'group', g.id)}
                    onClick={(e) => {
                      if (e.detail === 0)
                        setSelection({ kind: 'group', id: g.id });
                    }}
                    onDoubleClick={() =>
                      editable &&
                      void save(
                        {
                          ...doc,
                          groups: doc.groups.map((item) =>
                            item.id === g.id
                              ? { ...item, collapsed: !item.collapsed }
                              : item,
                          ),
                        },
                        g.collapsed ? 'Expand group' : 'Collapse group',
                      )
                    }
                  >
                    <span className="sm-dot" style={{ background: g.color }} />
                    {g.name}
                    <small>
                      {doc.nodes.filter((n) => n.group_id === g.id).length}
                    </small>
                    <ChevronDown
                      size={14}
                      style={{
                        transform: g.collapsed ? 'rotate(-90deg)' : undefined,
                      }}
                    />
                  </button>
                  {!g.collapsed &&
                    editable &&
                    selection?.id === g.id &&
                    ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'].map(
                      (handle) => (
                        <button
                          key={handle}
                          type="button"
                          className={`sm-resize sm-resize-${handle}`}
                          aria-label={`Resize ${g.name} ${handle}`}
                          onPointerDown={(e) =>
                            begin(e, 'resize', g.id, handle)
                          }
                        />
                      ),
                    )}
                </div>
              ))}
            </div>
            <svg className="sm-edges" aria-label="Map connections">
              <defs>
                <marker
                  id={markerId}
                  markerWidth="7"
                  markerHeight="7"
                  refX="6"
                  refY="3.5"
                  orient="auto-start-reverse"
                >
                  <path d="M0 0 L7 3.5 L0 7" fill="currentColor" />
                </marker>
              </defs>
              {doc.edges.map((edge) => {
                const a = shownNodes.find((n) => n.id === edge.source),
                  b = shownNodes.find((n) => n.id === edge.target);
                if (!a || !b) return null;
                const path = connectionPath(a, b);
                return (
                  <g key={edge.id}>
                    <path
                      d={path}
                      className={`sm-edge ${selection?.id === edge.id ? 'sm-selected-edge' : ''}`}
                      strokeDasharray={
                        edge.line === 'dashed' ? '6 5' : undefined
                      }
                      markerEnd={
                        edge.direction === 'none'
                          ? undefined
                          : `url(#${markerId})`
                      }
                      markerStart={
                        edge.direction === 'both'
                          ? `url(#${markerId})`
                          : undefined
                      }
                    />
                    <path
                      d={path}
                      className="sm-edge-hit"
                      role="button"
                      tabIndex={0}
                      aria-label={`Connection: ${a.name} to ${b.name}`}
                      onPointerDown={(e) => e.stopPropagation()}
                      onClick={() => {
                        setContext(null);
                        setSelection({ kind: 'edge', id: edge.id });
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          setSelection({ kind: 'edge', id: edge.id });
                        }
                      }}
                    />
                  </g>
                );
              })}
              {connector &&
                (() => {
                  const a = doc.nodes.find((n) => n.id === connector.source)!;
                  return (
                    <path
                      className="sm-edge sm-connecting"
                      d={`M${a.x + NODE_WIDTH} ${a.y + 32} L${connector.point.x} ${connector.point.y}`}
                    />
                  );
                })()}
            </svg>
            <div className="sm-nodes">
              {shownNodes.map((node) => {
                const match = !query || searchMatches.includes(node);
                return (
                  <div
                    key={node.id}
                    data-node-id={node.id}
                    className={`sm-node ${selection?.id === node.id ? 'sm-selected' : ''} ${!match ? 'sm-dim' : ''}`}
                    style={{ left: node.x, top: node.y }}
                  >
                    <button
                      type="button"
                      className="sm-node-body"
                      aria-label={`Select node ${node.name}`}
                      onPointerDown={(e) => begin(e, 'node', node.id)}
                      onClick={(e) => {
                        if (e.detail === 0)
                          setSelection({ kind: 'node', id: node.id });
                      }}
                    >
                      <span
                        className="sm-node-symbol"
                        style={{
                          color: node.color,
                          background: `color-mix(in srgb, ${node.color} 12%, var(--card))`,
                        }}
                      >
                        <Group size={16} />
                      </span>
                      <span className="sm-node-name">{node.name}</span>
                      {node.url && (
                        <ExternalLink className="sm-link-mark" size={12} />
                      )}
                    </button>
                    {editable && (
                      <button
                        type="button"
                        className="sm-port"
                        aria-label={`Connect from ${node.name}`}
                        onPointerDown={(e) => begin(e, 'connect', node.id)}
                        onClick={(e) => {
                          if (e.detail === 0) {
                            setConnector({
                              source: node.id,
                              point: { x: node.x + NODE_WIDTH, y: node.y + 32 },
                            });
                            setSelection({ kind: 'node', id: node.id });
                          }
                        }}
                      />
                    )}
                    {connector && !dragging && connector.source !== node.id && (
                      <button
                        type="button"
                        className="sm-connect-target"
                        aria-label={`Connect to ${node.name}`}
                        onClick={() => {
                          const edge: MapEdge = {
                            id: nextId(),
                            source: connector.source,
                            target: node.id,
                            line: 'solid',
                            direction: 'forward',
                          };
                          setConnector(null);
                          void save(
                            { ...doc, edges: [...doc.edges, edge] },
                            'Add connection',
                          ).then(
                            (ok) =>
                              ok && setSelection({ kind: 'edge', id: edge.id }),
                          );
                        }}
                      >
                        Connect here
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            {drawRect && (
              <div
                className="sm-draw-preview"
                style={{
                  left: drawRect.x,
                  top: drawRect.y,
                  width: drawRect.width,
                  height: drawRect.height,
                }}
              />
            )}
          </div>
        )}
        {editable && context && (
          <div
            className="sm-context"
            role="group"
            aria-label="Create in workspace"
            style={{
              left: Math.max(8, Math.min(size.width - 185, context.screen.x)),
              top: Math.max(8, Math.min(size.height - 105, context.screen.y)),
            }}
          >
            <button
              type="button"
              onClick={() => openEditor('node', undefined, context.world)}
            >
              <Plus size={16} />
              Add Node
            </button>
            <button
              type="button"
              onClick={() => {
                setContext(null);
                setDrawMode(true);
                setSelection(null);
              }}
            >
              <Group size={16} />
              Add Group
            </button>
          </div>
        )}
        {editable && selection && !dragging && !context && (
          <div
            className="sm-popup"
            style={{ left: popupPoint.x, top: popupPoint.y }}
          >
            {selectedItem && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    openEditor(selectedNode ? 'node' : 'group', selectedItem.id)
                  }
                >
                  <Pencil />
                  Edit
                </Button>
                {selectedNode?.url && (
                  <a
                    href={selectedNode.url}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    <ExternalLink size={14} />
                    Open Link
                  </a>
                )}
                {selectedGroup && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      void save(
                        {
                          ...doc!,
                          groups: doc!.groups.map((g) =>
                            g.id === selectedGroup.id
                              ? { ...g, collapsed: !g.collapsed }
                              : g,
                          ),
                        },
                        selectedGroup.collapsed
                          ? 'Expand group'
                          : 'Collapse group',
                      )
                    }
                  >
                    {selectedGroup.collapsed ? 'Expand' : 'Collapse'}
                  </Button>
                )}
              </>
            )}
            {selectedEdge && (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={edgeMenu === 'line'}
                  onClick={() =>
                    setEdgeMenu(edgeMenu === 'line' ? null : 'line')
                  }
                >
                  Line
                  <ChevronDown />
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-expanded={edgeMenu === 'direction'}
                  onClick={() =>
                    setEdgeMenu(edgeMenu === 'direction' ? null : 'direction')
                  }
                >
                  <ChevronRight />
                  Arrow
                  <ChevronDown />
                </Button>
                {edgeMenu && (
                  <div
                    className="sm-edge-menu"
                    role="menu"
                    aria-label={
                      edgeMenu === 'line' ? 'Line style' : 'Arrow direction'
                    }
                  >
                    {(edgeMenu === 'line'
                      ? [
                          ['solid', 'Solid'],
                          ['dashed', 'Dashed'],
                        ]
                      : [
                          ['none', 'No arrow'],
                          ['forward', 'One-way →'],
                          ['both', 'Two-way ↔'],
                        ]
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        role="menuitemradio"
                        aria-checked={
                          (edgeMenu === 'line'
                            ? selectedEdge.line
                            : selectedEdge.direction) === value
                        }
                        onClick={() => {
                          const field = edgeMenu;
                          setEdgeMenu(null);
                          void save(
                            {
                              ...doc!,
                              edges: doc!.edges.map((e) =>
                                e.id === selectedEdge.id
                                  ? { ...e, [field]: value }
                                  : e,
                              ),
                            },
                            'Style connection',
                          );
                        }}
                      >
                        {label}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Delete ${selection.kind}`}
              onClick={() => void deleteSelection()}
            >
              <Trash2 className="text-destructive" />
            </Button>
          </div>
        )}
        {doc && (
          <>
            <div className="sm-controls">
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Zoom out"
                onClick={() => zoomBy(1 / 1.15)}
              >
                <Minus />
              </Button>
              <span>{Math.round(viewport.zoom * 100)}%</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Zoom in"
                onClick={() => zoomBy(1.15)}
              >
                <Plus />
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  fit(doc);
                  setSelection(null);
                }}
              >
                <Scan />
                Fit
              </Button>
            </div>
            <button
              type="button"
              className="sm-minimap"
              aria-label="Fit map from overview"
              onClick={() => {
                fit(doc);
                setSelection(null);
              }}
            >
              <svg
                viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
                aria-hidden="true"
              >
                {doc.groups.map((g) => (
                  <rect
                    key={g.id}
                    x={g.x}
                    y={g.y}
                    width={g.width}
                    height={g.collapsed ? GROUP_HEADER : g.height}
                    fill={g.color}
                    opacity=".12"
                  />
                ))}
                {shownNodes.map((n) => (
                  <rect
                    key={n.id}
                    x={n.x}
                    y={n.y}
                    width={NODE_WIDTH}
                    height={NODE_HEIGHT}
                    rx={8}
                    fill={n.color}
                  />
                ))}
                <rect
                  className="sm-minimap-view"
                  x={-viewport.x / viewport.zoom}
                  y={-viewport.y / viewport.zoom}
                  width={size.width / viewport.zoom}
                  height={size.height / viewport.zoom}
                />
              </svg>
            </button>
          </>
        )}
      </div>
      <footer className="sm-footer">
        <span>
          {doc
            ? `${doc.nodes.length} nodes · ${doc.groups.length} groups`
            : 'Independent maps'}
          {query ? ` · ${searchMatches.length} matches` : ''}
        </span>
        <span aria-live="polite">
          {busy ? (
            <>
              <LoaderCircle size={13} className="animate-spin" />
              Saving…
            </>
          ) : failed ? (
            'Changes not saved'
          ) : drawMode ? (
            'Drag to draw a group · Esc to cancel'
          ) : map ? (
            `Saved · v${map.version} · Right-click to add`
          ) : (
            'Right-click on the canvas to add content'
          )}
        </span>
      </footer>
      {map && (
        <div className="sm-map-delete">
          <Button
            variant="ghost"
            size="sm"
            disabled={!editable}
            onClick={() => void runAction('trash', map)}
          >
            <Trash2 />
            Move Map to Trash
          </Button>
        </div>
      )}
      <Dialog
        open={!!editor}
        onOpenChange={(open) => {
          if (!open && !busy) setEditor(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {editor?.id ? 'Edit' : 'New'} {editor?.kind}
            </DialogTitle>
            <DialogDescription>
              {editor?.kind === 'node'
                ? 'A freeform node in this map.'
                : editor?.kind === 'group'
                  ? 'Group related nodes in one area.'
                  : 'A separate canvas for your ideas and relationships.'}
            </DialogDescription>
          </DialogHeader>
          {editor && (
            <form
              className="sm-form"
              onSubmit={(e) => {
                e.preventDefault();
                void submitEditor();
              }}
            >
              <label>
                Name
                <input
                  required
                  maxLength={120}
                  value={editor.name}
                  onChange={(e) =>
                    setEditor({ ...editor, name: e.target.value })
                  }
                />
              </label>
              {editor.kind !== 'group' && (
                <label>
                  Description
                  <textarea
                    maxLength={4000}
                    value={editor.description}
                    onChange={(e) =>
                      setEditor({ ...editor, description: e.target.value })
                    }
                  />
                </label>
              )}
              {editor.kind === 'node' && (
                <>
                  <label>
                    External URL
                    <input
                      type="url"
                      maxLength={2000}
                      placeholder="https://…"
                      value={editor.url}
                      onChange={(e) =>
                        setEditor({ ...editor, url: e.target.value })
                      }
                    />
                  </label>
                  <label htmlFor={`${markerId}-node-group`}>Group</label>
                  <select
                    id={`${markerId}-node-group`}
                    value={editor.group_id}
                    onChange={(e) =>
                      setEditor({ ...editor, group_id: e.target.value })
                    }
                  >
                    <option value="">No group</option>
                    {doc?.groups.map((g) => (
                      <option key={g.id} value={g.id}>
                        {g.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {editor.kind !== 'map' && (
                <label>
                  Color
                  <span className="sm-colors">
                    {mapColors.map((color) => (
                      <button
                        type="button"
                        key={color}
                        aria-label={`Use ${color} color`}
                        aria-pressed={editor.color === color}
                        style={{ background: color }}
                        onClick={() => setEditor({ ...editor, color })}
                      />
                    ))}
                  </span>
                </label>
              )}
              <div className="sm-form-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setEditor(null)}
                >
                  Cancel
                </Button>
                <Button type="submit" disabled={busy || failed}>
                  {busy ? 'Saving…' : 'Save'}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Map History</DialogTitle>
            <DialogDescription>
              Last 50 snapshots. Layout changes within five minutes share one
              snapshot.
            </DialogDescription>
          </DialogHeader>
          <div className="sm-history">
            {revisions.map((revision) => (
              <div key={revision.version}>
                <span>
                  <strong>{revision.action}</strong>
                  <small>
                    {new Date(revision.created_at).toLocaleString()} · v
                    {revision.version} ·{' '}
                    {revision.changed_by === 'local' ? 'Local' : 'You'}
                  </small>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy || failed || revision.version === map?.version}
                  onClick={() =>
                    map &&
                    void runAction('restore_revision', map, revision.version)
                  }
                >
                  Restore
                </Button>
              </div>
            ))}
            {!revisions.length && <p>No snapshots.</p>}
          </div>
          <div className="sm-form-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={!historyPage || busy}
              onClick={() => void showHistory(historyPage - 1)}
            >
              Previous
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={revisions.length < 20 || busy || historyPage >= 2}
              onClick={() => void showHistory(historyPage + 1)}
            >
              Next
            </Button>
          </div>
        </DialogContent>
      </Dialog>
      <Dialog open={trashOpen} onOpenChange={setTrashOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Map Trash</DialogTitle>
            <DialogDescription>
              Deleted maps and their history are kept for 30 days.
            </DialogDescription>
          </DialogHeader>
          <div className="sm-history">
            {trash.map((item) => (
              <div key={item.id}>
                <span>
                  <strong>{item.name}</strong>
                  <small>
                    {new Date(item.deleted_at!).toLocaleDateString()}
                  </small>
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() => void runAction('restore', item)}
                >
                  Restore
                </Button>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`Permanently delete ${item.name}`}
                  disabled={busy}
                  onClick={() => void runAction('purge', item)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
            {!trash.length && <p>Trash is empty.</p>}
          </div>
        </DialogContent>
      </Dialog>
    </section>
  );
}
