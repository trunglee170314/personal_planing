'use client';
/* oxlint-disable jsx-a11y/no-noninteractive-element-interactions, jsx-a11y/no-noninteractive-tabindex, jsx-a11y/prefer-tag-over-role -- The interactive map is an ARIA application; SVG paths supply focusable connection controls, where HTML buttons are not valid SVG children. */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  memo,
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
  Pin,
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
import {
  useKeyboard,
  useShortcutActions,
} from '@/components/keyboard-shortcuts';
import {
  copyCluster,
  pasteCluster,
  moveNodes,
  nodesInArea,
  nextSpatialNode,
} from '@/lib/system-map/commands';
import { systemMaps } from '@/lib/data/system-maps';
import { getErrorMessage } from '@/lib/data/repository';
import { mapEdgeEmphasis } from '@/lib/planning-viewport';
import {
  validateMapDocument,
  nodeSize,
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
import {
  alignNodes,
  arrangeBranch,
  connectionPath,
  contentSize,
  findOpenPoint,
  highlightParts,
  materializeSizes,
  newNodePoint,
  refitGroups,
  searchNodes,
  createSnapIndex,
  snapIndexedNodes,
  nodesInViewport,
  viewportBox,
  intersectsBox,
  connectionBounds,
  MIN_MAP_ZOOM,
  visibleSelection,
  type Alignment,
} from '@/lib/system-map/geometry';

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
  kind: 'pan' | 'node' | 'group' | 'resize' | 'connect' | 'draw' | 'area';
  ids?: string[];
  start: Point;
  client: Point;
  doc: MapDocument;
  id?: string;
  handle?: string;
  pan: Point;
  moved: boolean;
  snapIndex?: ReturnType<typeof createSnapIndex>;
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
      ...nodeSize(n),
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
let nodeTextContext: CanvasRenderingContext2D | null = null;
function measureNodeText(text: string) {
  if (typeof document === 'undefined') return Array.from(text).length * 8;
  const context = (nodeTextContext ??= document
    .createElement('canvas')
    .getContext('2d'));
  if (!context) return Array.from(text).length * 8;
  context.font = `500 14px ${getComputedStyle(document.body).fontFamily}`;
  return context.measureText(text).width;
}
const OverviewShapes = memo(function OverviewShapes({
  nodes,
  groups,
}: {
  nodes: MapNode[];
  groups: MapGroup[];
}) {
  return (
    <>
      {groups.map((g) => (
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
      {nodes.map((n) => (
        <rect
          key={n.id}
          x={n.x}
          y={n.y}
          width={nodeSize(n).width}
          height={nodeSize(n).height}
          rx={8}
          fill={n.color}
        />
      ))}
    </>
  );
});

export function SystemMapPanel({
  initialMapId,
}: { initialMapId?: string } = {}) {
  'use no memo'; // Pointer gestures intentionally bridge mutable refs and state.
  const keyboard = useKeyboard();
  const [maps, setMaps] = useState<MapSummary[]>([]),
    [map, setMap] = useState<SystemMap | null>(null),
    [doc, setDoc] = useState<MapDocument | null>(null);
  const [busy, setBusy] = useState(false),
    [failed, setFailed] = useState(false),
    [message, setMessage] = useState(''),
    [selection, setSelectionValue] = useState<Selection>(null);
  const [nodeIds, setNodeIds] = useState<string[]>([]);
  const [areaMode, setAreaMode] = useState(false);
  const [inline, setInline] = useState<{
    id: string;
    name: string;
    node?: MapNode;
    source?: string;
    anchor?: string;
    nearby?: boolean;
  } | null>(null);
  const pointerWorld = useRef<Point | null>(null);
  const pointerClient = useRef<Point | null>(null);
  const panHeld = useRef(false);
  const undoStack = useRef<
    { before: MapDocument; after: MapDocument; label: string }[]
  >([]);
  const redoStack = useRef<
    { before: MapDocument; after: MapDocument; label: string }[]
  >([]);
  const [historyCount, setHistoryCount] = useState({ undo: 0, redo: 0 });
  const pasteCount = useRef(0);
  const [guides, setGuides] = useState<{ guideX?: number; guideY?: number }>(
    {},
  );
  const [searchIndex, setSearchIndex] = useState(-1);
  const setSelection = useCallback((value: Selection) => {
    setSelectionValue(value);
    setNodeIds(value?.kind === 'node' ? [value.id] : []);
  }, []);
  function selectNodes(ids: string[], anchor = ids.at(-1)) {
    setNodeIds(ids);
    setSelectionValue(anchor ? { kind: 'node', id: anchor } : null);
  }
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
  const [focusedNodeId, setFocusedNodeId] = useState<string | null>(null);
  const lastNodeDrag = useRef({ id: '', at: -Infinity });
  const nodeClickMoved = useRef(false);
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
  const previewFrame = useRef<number | null>(null),
    pendingPreview = useRef<MapDocument | null>(null),
    pendingGuides = useRef<{ guideX?: number; guideY?: number }>({});
  const cancelPreview = useCallback(() => {
    if (previewFrame.current !== null)
      cancelAnimationFrame(previewFrame.current);
    previewFrame.current = null;
    pendingPreview.current = null;
  }, []);
  function queuePreview(
    value: MapDocument,
    guide: { guideX?: number; guideY?: number } = {},
  ) {
    if (
      value.nodes.some((n) => Math.abs(n.x) > 20000 || Math.abs(n.y) > 20000) ||
      value.groups.some(
        (g) =>
          Math.abs(g.x) > 20000 ||
          Math.abs(g.y) > 20000 ||
          g.width > 8000 ||
          g.height > 8000,
      )
    )
      return;
    docRef.current = value;
    pendingPreview.current = value;
    pendingGuides.current = guide;
    if (previewFrame.current === null)
      previewFrame.current = requestAnimationFrame(() => {
        previewFrame.current = null;
        const next = pendingPreview.current;
        pendingPreview.current = null;
        if (next) {
          setDoc(next);
          setGuides(pendingGuides.current);
        }
      });
  }
  const editable = !!doc && !busy && !failed && !inline;
  const setDraft = useCallback((value: MapDocument) => {
    const sized = materializeSizes(value, measureNodeText);
    docRef.current = sized;
    // Render from an immutable snapshot; gesture refs own the working copy.
    setDoc(structuredClone(sized));
  }, []);
  const cancelHold = useCallback(() => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
  }, []);
  const dispose = useCallback(() => {
    mountedRef.current = false;
    ++loadRef.current;
    cancelHold();
    cancelPreview();
  }, [cancelHold, cancelPreview]);
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
            MIN_MAP_ZOOM,
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
      setHoveredNodeId(null);
      setFocusedNodeId(null);
      setInline(null);
      setAreaMode(false);
      pointerWorld.current = null;
      pointerClient.current = null;
      undoStack.current = [];
      redoStack.current = [];
      setHistoryCount({ undo: 0, redo: 0 });
      setMessage('');
      setQuery('');
      setSearchIndex(-1);
    },
    [setDraft, setSelection],
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
          requestAnimationFrame(() =>
            fit(materializeSizes(value.document, measureNodeText)),
          );
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
          void loadMap(
            items.find((item) => item.id === initialMapId)?.id ?? items[0].id,
          );
      })
      .catch((error) => {
        if (mountedRef.current) setMessage(getErrorMessage(error));
      });
    return dispose;
  }, [refreshList, loadMap, dispose, initialMapId]);
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
            Math.max(MIN_MAP_ZOOM, v.zoom * Math.exp(-event.deltaY * 0.003)),
          );
        changeViewport({
          zoom,
          x: x - ((x - v.x) * zoom) / v.zoom,
          y: y - ((y - v.y) * zoom) / v.zoom,
        });
      } else
        changeViewport({ ...v, x: v.x - event.deltaX, y: v.y - event.deltaY });
      setContext(null);
    };
    canvas.addEventListener('wheel', wheel, { passive: false });
    return () => {
      observer.disconnect();
      canvas.removeEventListener('wheel', wheel);
    };
  }, [changeViewport, setSelection]);
  async function save(next: MapDocument, label: string, record = true) {
    const current = mapRef.current;
    if (!current || savingRef.current || failedRef.current) return false;
    try {
      next = materializeSizes(next, measureNodeText);
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
      if (record) {
        undoStack.current = [
          ...undoStack.current.slice(-19),
          {
            before: structuredClone(current.document),
            after: structuredClone(result.document),
            label,
          },
        ];
        redoStack.current = [];
        setHistoryCount({ undo: undoStack.current.length, redo: 0 });
      }
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
      undoStack.current = [];
      redoStack.current = [];
      setHistoryCount({ undo: 0, redo: 0 });
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
        undoStack.current = [];
        redoStack.current = [];
        setHistoryCount({ undo: 0, redo: 0 });
        setInline(null);
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
        requestAnimationFrame(() => docRef.current && fit(docRef.current));
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
    if (!editor || busy || savingRef.current || failed) return;
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
          if (docRef.current) fit(docRef.current);
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
        ...old,
        id: editor.id ?? nextId(),
        name: editor.name.trim(),
        description: editor.description,
        url: editor.url.trim(),
        color: editor.color,
        group_id: editor.group_id || null,
        x: point.x,
        y: point.y,
        ...contentSize(
          editor.name.trim(),
          measureNodeText,
          !!editor.url.trim(),
        ),
      };
      if (!old) {
        try {
          Object.assign(node, newNodePoint(current, node));
        } catch (error) {
          setMessage(getErrorMessage(error));
          return;
        }
      }
      const group = current.groups.find((g) => g.id === node.group_id);
      if (
        group &&
        old?.group_id !== node.group_id &&
        containingGroup({ ...current, groups: [group] }, node) !== group.id
      ) {
        try {
          Object.assign(
            node,
            findOpenPoint(
              node,
              { x: group.x + 20, y: group.y + GROUP_HEADER + 16 },
              current.nodes,
            ),
          );
        } catch (error) {
          setMessage(getErrorMessage(error));
          return;
        }
      }
      next = {
        ...current,
        nodes: editor.id
          ? current.nodes.map((n) => (n.id === node.id ? node : n))
          : [...current.nodes, node],
      };
      next = refitGroups(next);
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
    if (panHeld.current) kind = 'pan';
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
      ids:
        kind === 'node' ? (nodeIds.includes(id!) ? nodeIds : [id!]) : undefined,
    };
    if (kind === 'node') nodeClickMoved.current = false;
    // Capture the initiating target so native click/double-click still reaches
    // node buttons and group headings; move/up events bubble to the canvas.
    event.currentTarget.setPointerCapture(event.pointerId);
    if (kind === 'connect') {
      setSelection(null);
      setConnector({ source: id!, point: start });
      setDragging(true);
    }
    if (kind === 'pan') {
      nodeClickMoved.current = true;
      if (!panHeld.current) setSelection(null);
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
    if (g.kind === 'node') {
      try {
        const snapped = event.altKey
          ? { dx, dy }
          : snapIndexedNodes(
              g.doc,
              g.ids ?? [g.id!],
              g.snapIndex ??
                createSnapIndex(
                  { ...g.doc, nodes: searchNodes(g.doc, '') },
                  g.ids ?? [g.id!],
                ),
              dx,
              dy,
              6 / viewportRef.current.zoom,
            );
        g.snapIndex ??= createSnapIndex(
          { ...g.doc, nodes: searchNodes(g.doc, '') },
          g.ids ?? [g.id!],
        );
        queuePreview(
          moveNodes(g.doc, g.ids ?? [g.id!], snapped.dx, snapped.dy, true),
          'guideX' in snapped ? snapped : {},
        );
      } catch {
        /* Keep the last valid pointer position at coordinate bounds. */
      }
    }
    if (g.kind === 'group') queuePreview(moveGroup(g.doc, g.id!, dx, dy));
    if (g.kind === 'resize') {
      const original = g.doc.groups.find((item) => item.id === g.id)!;
      const left = g.handle!.includes('w'),
        top = g.handle!.includes('n');
      queuePreview(
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
    if (g.kind === 'draw' || g.kind === 'area')
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
    if (pendingPreview.current) setDoc(pendingPreview.current);
    cancelPreview();
    setGuides({});
    gesture.current = null;
    setDragging(false);
    if (g.kind === 'node') {
      nodeClickMoved.current = g.moved;
      if (g.moved) lastNodeDrag.current = { id: g.id!, at: event.timeStamp };
    }
    if (holdTimer.current) clearTimeout(holdTimer.current);
    if (g.capture.hasPointerCapture(event.pointerId))
      g.capture.releasePointerCapture(event.pointerId);
    if (g.kind === 'pan') return;
    if (g.kind === 'area') {
      setAreaMode(false);
      setDrawRect(null);
      const end = worldPoint({ x: event.clientX, y: event.clientY });
      selectNodes(
        nodesInArea({ ...g.doc, nodes: searchNodes(g.doc, '') }, g.start, end),
      );
      return;
    }
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
    if (g.kind === 'node') selectNodes(g.ids ?? [g.id!], g.id);
    else setSelection({ kind: 'group', id: g.id! });
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
    setGuides({});
    const g = gesture.current;
    if (event && g && event.pointerId !== g.pointerId) return;
    cancelPreview();
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
    pointerClient.current = { x: event.clientX, y: event.clientY };
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
    if (!editable || savingRef.current || !selection || !docRef.current) return;
    if (
      !window.confirm(
        selection.kind === 'group'
          ? 'Delete this group? Its nodes stay in the map.'
          : selection.kind === 'node'
            ? `Delete ${nodeIds.length || 1} selected node(s) and their connections? You can undo this or recover from History.`
            : 'Delete this connection?',
      )
    )
      return;
    const current = docRef.current,
      next =
        selection.kind === 'node'
          ? (nodeIds.length ? nodeIds : [selection.id]).reduce(
              (value, id) => removeNode(value, id),
              current,
            )
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
            (selectedItem.y +
              (selectedNode ? nodeSize(selectedNode).height : GROUP_HEADER)) *
              viewport.zoom +
              viewport.y +
              8,
          ),
        ),
      }
    : { x: Math.max(8, size.width / 2 - 130), y: 15 };
  const shownNodes = useMemo(
    () =>
      doc
        ? [
            ...searchNodes(doc, ''),
            ...(inline?.node && !doc.nodes.some((n) => n.id === inline.id)
              ? [inline.node]
              : []),
          ]
        : [],
    [doc, inline],
  );
  const bounds = useMemo(
    () => (doc ? documentBounds(doc) : { x: 0, y: 0, width: 800, height: 480 }),
    [doc],
  );
  const searchMatches = useMemo(
    () => (doc && query.trim() ? searchNodes(doc, query) : []),
    [doc, query],
  );
  const matchingIds = useMemo(
    () => new Set(searchMatches.map((node) => node.id)),
    [searchMatches],
  );
  const searching = !!query.trim();
  const shownById = useMemo(
    () => new Map(shownNodes.map((n) => [n.id, n])),
    [shownNodes],
  );
  const selectedIds = useMemo(() => new Set(nodeIds), [nodeIds]);
  const visibleBox = viewportBox(viewport, size);
  const renderedNodes = nodesInViewport(
    shownNodes,
    visibleBox,
    new Set([selection?.id ?? '', inline?.id ?? '', focusedNodeId ?? '']),
  );
  const overviewGroups = useMemo(() => doc?.groups ?? [], [doc]);
  const edgePaths = useMemo(() => {
    if (!doc) return new Map<string, string>();
    const nodes = searchNodes(doc, ''),
      byId = new Map(nodes.map((n) => [n.id, n]));
    return new Map(
      doc.edges.flatMap((edge) => {
        const a = byId.get(edge.source),
          b = byId.get(edge.target);
        return a && b ? [[edge.id, connectionPath(a, b)] as const] : [];
      }),
    );
  }, [doc]);
  const edgeBoxes = useMemo(
    () =>
      new Map([...edgePaths].map(([id, path]) => [id, connectionBounds(path)])),
    [edgePaths],
  );
  useEffect(() => {
    if (!doc) return;
    const next = visibleSelection(doc, '', nodeIds, selection);
    if (next.nodeIds.length !== nodeIds.length) setNodeIds(next.nodeIds);
    if (
      next.selection?.kind !== selection?.kind ||
      next.selection?.id !== selection?.id
    ) {
      setSelectionValue(next.selection);
      setSearchIndex(-1);
    }
    if (
      connector &&
      !searchNodes(doc, '').some((n) => n.id === connector.source)
    )
      setConnector(null);
  }, [doc, query, nodeIds, selection, connector]);
  function updateQuery(value: string) {
    setQuery(value);
    setSearchIndex(-1);
    setSelection(null);
    setConnector(null);
  }
  function jumpResult(back = false) {
    if (!searchMatches.length) return;
    const at =
      searchIndex < 0 || searchIndex >= searchMatches.length
        ? back
          ? searchMatches.length - 1
          : 0
        : (searchIndex + (back ? -1 : 1) + searchMatches.length) %
          searchMatches.length;
    const node = searchMatches[at],
      s = nodeSize(node),
      v = viewportRef.current;
    setSearchIndex(at);
    setSelection({ kind: 'node', id: node.id });
    changeViewport({
      ...v,
      x: size.width / 2 - (node.x + s.width / 2) * v.zoom,
      y: size.height / 2 - (node.y + s.height / 2) * v.zoom,
    });
  }
  function fitResults() {
    if (doc && searchMatches.length)
      fit({ ...doc, nodes: searchMatches, groups: [] });
  }
  function arrangeSelection(kind: Alignment | 'branch') {
    if (!docRef.current || !editable) return;
    try {
      const next =
        kind === 'branch'
          ? arrangeBranch(docRef.current, selectedNode!.id)
          : alignNodes(docRef.current, nodeIds, kind);
      void save(
        next,
        kind === 'branch' ? 'Arrange branch Right' : `Align ${kind}`,
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  function toggleKeepPosition() {
    if (!docRef.current || !editable || !nodeIds.length) return;
    const keep = !docRef.current.nodes
      .filter((n) => nodeIds.includes(n.id))
      .every((n) => n.keep_position);
    void save(
      {
        ...docRef.current,
        nodes: docRef.current.nodes.map((n) =>
          nodeIds.includes(n.id) ? { ...n, keep_position: keep } : n,
        ),
      },
      keep ? 'Keep node positions' : 'Release node positions',
    );
  }
  function arrangeWhole(layout: 'grid' | 'circle') {
    if (!docRef.current || !editable) return;
    try {
      void save(arrangeMap(docRef.current, layout), 'Auto layout').then(
        (ok) => {
          if (ok && docRef.current) fit(docRef.current);
        },
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  const activeNodeId = renderedNodes.some((n) => n.id === hoveredNodeId)
    ? hoveredNodeId
    : renderedNodes.some((n) => n.id === focusedNodeId)
      ? focusedNodeId
      : null;
  function zoomBy(factor: number) {
    const v = viewportRef.current,
      zoom = Math.min(2, Math.max(MIN_MAP_ZOOM, v.zoom * factor));
    changeViewport({
      zoom,
      x: size.width / 2 - ((size.width / 2 - v.x) * zoom) / v.zoom,
      y: size.height / 2 - ((size.height / 2 - v.y) * zoom) / v.zoom,
    });
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

  function insertionPoint(): Point {
    const v = viewportRef.current;
    if (pointerClient.current && canvasRef.current)
      return worldPoint(pointerClient.current);
    return (
      pointerWorld.current ?? {
        x: (size.width / 2 - v.x) / v.zoom,
        y: (size.height / 2 - v.y) / v.zoom,
      }
    );
  }
  function revealNode(node: Pick<MapNode, 'x' | 'y' | 'width' | 'height'>) {
    const v = viewportRef.current;
    const x = node.x * v.zoom + v.x,
      y = node.y * v.zoom + v.y;
    if (
      x < 12 ||
      x + nodeSize(node).width * v.zoom > size.width - 12 ||
      y < 12 ||
      y + nodeSize(node).height * v.zoom > size.height - 12
    )
      changeViewport({
        ...v,
        x: size.width / 2 - (node.x + nodeSize(node).width / 2) * v.zoom,
        y: size.height / 2 - (node.y + nodeSize(node).height / 2) * v.zoom,
      });
  }
  function quickCreate(connected = false, nearby = false) {
    const current = docRef.current;
    if (
      !current ||
      savingRef.current ||
      failedRef.current ||
      inline ||
      gesture.current
    )
      return;
    const source =
      selection?.kind === 'node'
        ? current.nodes.find((n) => n.id === selection.id)
        : undefined;
    if ((connected || nearby) && !source) return;
    const point =
      source && (connected || nearby)
        ? {
            x: source.x + (nearby ? 0 : nodeSize(source).width + 70),
            y: source.y + (nearby ? nodeSize(source).height + 24 : 0),
          }
        : insertionPoint();
    const node: MapNode = {
      id: nextId(),
      name: 'New node',
      description: '',
      url: '',
      color: source?.color ?? mapColors[0],
      group_id: containingGroup(current, point),
      x: clamp(point.x),
      y: clamp(point.y),
      ...contentSize('New node', measureNodeText),
    };
    try {
      Object.assign(
        node,
        newNodePoint(
          current,
          node,
          connected || nearby ? source : undefined,
          nearby,
        ),
      );
      node.group_id =
        source && (connected || nearby)
          ? source.group_id
          : containingGroup(current, node);
      validateMapDocument(
        refitGroups({ ...current, nodes: [...current.nodes, node] }),
      );
    } catch (error) {
      setMessage(getErrorMessage(error));
      return;
    }
    setInline({
      id: node.id,
      name: node.name,
      node,
      source: connected ? source?.id : undefined,
      anchor: connected || nearby ? source?.id : undefined,
      nearby,
    });
    revealNode(node);
    unsavedRef.current = true;
    setContext(null);
  }
  function cancelInline() {
    if (savingRef.current) return;
    setInline(null);
    if (!failedRef.current) unsavedRef.current = false;
    canvasRef.current?.focus({ preventScroll: true });
  }
  async function commitInline() {
    if (!inline || savingRef.current || failedRef.current || !docRef.current)
      return;
    if (!inline.name.trim()) {
      setMessage('Node name is required.');
      return;
    }
    const current = docRef.current;
    const named = inline.node
      ? {
          ...inline.node,
          name: inline.name.trim(),
          ...contentSize(
            inline.name.trim(),
            measureNodeText,
            !!inline.node.url,
          ),
        }
      : undefined;
    if (named) {
      try {
        Object.assign(
          named,
          newNodePoint(
            current,
            named,
            current.nodes.find((n) => n.id === inline.anchor),
            inline.nearby,
          ),
        );
      } catch (error) {
        setMessage(getErrorMessage(error));
        return;
      }
    }
    const next = {
      ...current,
      nodes: inline.node
        ? [...current.nodes, named!]
        : current.nodes.map((n) =>
            n.id === inline.id
              ? {
                  ...n,
                  name: inline.name.trim(),
                  ...contentSize(inline.name.trim(), measureNodeText, !!n.url),
                }
              : n,
          ),
      edges: inline.source
        ? [
            ...current.edges,
            {
              id: nextId(),
              source: inline.source,
              target: inline.id,
              line: 'solid' as const,
              direction: 'forward' as const,
            },
          ]
        : current.edges,
    };
    if (
      await save(
        refitGroups(next),
        inline.node ? 'Quick add node' : 'Rename node',
      )
    ) {
      const id = inline.id;
      setInline(null);
      setSelection({ kind: 'node', id });
      const savedNode = docRef.current?.nodes.find((n) => n.id === id);
      if (savedNode) revealNode(savedNode);
      canvasRef.current?.focus({ preventScroll: true });
    }
  }
  function copySelection() {
    if (!keyboard || !docRef.current || !selection) return;
    const cluster = copyCluster(
      docRef.current,
      nodeIds,
      selection.kind === 'group' ? selection.id : undefined,
    );
    keyboard.setClipboard(cluster);
    pasteCount.current = 0;
    setMessage(
      `Copied ${cluster.nodes.length} node(s). Internal connections only; partial group membership is detached.`,
    );
  }
  async function pasteSelection(duplicate = false) {
    if (!editable || savingRef.current || gesture.current || !docRef.current)
      return;
    const current = docRef.current;
    const cluster = duplicate
      ? copyCluster(
          current,
          nodeIds,
          selection?.kind === 'group' ? selection.id : undefined,
        )
      : keyboard?.getClipboard();
    if (!cluster || (!cluster.nodes.length && !cluster.groups.length)) return;
    const items = [...cluster.nodes, ...cluster.groups];
    const point = insertionPoint();
    const offset = duplicate
      ? { x: 40, y: 40 }
      : {
          x:
            point.x -
            Math.min(...items.map((n) => n.x)) +
            pasteCount.current * 24,
          y:
            point.y -
            Math.min(...items.map((n) => n.y)) +
            pasteCount.current * 24,
        };
    try {
      const pasted = pasteCluster(current, cluster, offset);
      if (
        await save(
          pasted.document,
          duplicate ? 'Duplicate cluster' : 'Paste cluster',
        )
      ) {
        ++pasteCount.current;
        if (pasted.groupId) setSelection({ kind: 'group', id: pasted.groupId });
        else selectNodes(pasted.ids);
        const node = pasted.document.nodes.find((n) => n.id === pasted.ids[0]);
        if (node) revealNode(node);
      }
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  async function replay(redo = false) {
    if (!editable || savingRef.current || gesture.current) return;
    const from = redo ? redoStack : undoStack,
      to = redo ? undoStack : redoStack,
      entry = from.current.at(-1);
    if (!entry) return;
    if (
      await save(
        structuredClone(redo ? entry.after : entry.before),
        `${redo ? 'Redo' : 'Undo'} ${entry.label}`,
        false,
      )
    ) {
      from.current.pop();
      to.current.push(entry);
      setHistoryCount({
        undo: undoStack.current.length,
        redo: redoStack.current.length,
      });
      setSelection(null);
    }
  }
  function confirmConnection(target = selectedNode?.id) {
    if (
      !connector ||
      !target ||
      connector.source === target ||
      !docRef.current ||
      savingRef.current
    )
      return;
    const current = docRef.current;
    const existing = current.edges.find(
      (e) =>
        [e.source, e.target].includes(target) &&
        [e.source, e.target].includes(connector.source),
    );
    setConnector(null);
    if (existing) {
      setSelection({ kind: 'edge', id: existing.id });
      return;
    }
    const edge: MapEdge = {
      id: nextId(),
      source: connector.source,
      target,
      line: 'solid',
      direction: 'forward',
    };
    void save(
      { ...current, edges: [...current.edges, edge] },
      'Add connection',
    ).then((ok) => {
      if (ok) setSelection({ kind: 'edge', id: edge.id });
    });
  }
  function chooseNode(id: string, toggle = false) {
    if (toggle)
      selectNodes(
        nodeIds.includes(id)
          ? nodeIds.filter((n) => n !== id)
          : [...nodeIds, id],
      );
    else if (!nodeIds.includes(id)) setSelection({ kind: 'node', id });
    else setSelectionValue({ kind: 'node', id });
  }
  function spatial(
    direction: 'Left' | 'Right' | 'Up' | 'Down',
    extend = false,
  ) {
    if (!docRef.current) return;
    const id = nextSpatialNode(
      { ...docRef.current, nodes: searchNodes(docRef.current, '') },
      selection?.kind === 'node' ? selection.id : undefined,
      direction,
    );
    if (!id) return;
    selectNodes(extend ? [...new Set([...nodeIds, id])] : [id], id);
    const node = docRef.current.nodes.find((n) => n.id === id)!;
    revealNode(node);
  }
  function nudge(dx: number, dy: number) {
    if (!docRef.current || savingRef.current) return;
    try {
      void save(moveNodes(docRef.current, nodeIds, dx, dy), 'Move layout');
    } catch (error) {
      setMessage(getErrorMessage(error));
    }
  }
  const canEdit = () => editable && !savingRef.current && !gesture.current;
  const canSelect = () =>
    !!docRef.current && !inline && !gesture.current && !savingRef.current;
  useShortcutActions({
    'map.branch': {
      run: () => arrangeSelection('branch'),
      enabled: () => canEdit() && !!selectedNode,
    },
    'map.keep': {
      run: toggleKeepPosition,
      enabled: () => canEdit() && !!nodeIds.length,
    },
    'map.fitResults': {
      run: fitResults,
      enabled: () => !!searchMatches.length,
    },
    'map.nextResult': {
      run: () => jumpResult(),
      enabled: () => !!searchMatches.length && !inline,
    },
    'map.previousResult': {
      run: () => jumpResult(true),
      enabled: () => !!searchMatches.length && !inline,
    },
    ...Object.fromEntries(
      (
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
      ).map((kind) => [
        `map.align.${kind}`,
        {
          run: () => arrangeSelection(kind),
          enabled: () => canEdit() && nodeIds.length > 1,
        },
      ]),
    ),
    undo: {
      run: () => {
        void replay();
      },
      enabled: () => canEdit() && !!undoStack.current.length,
    },
    redo: {
      run: () => {
        void replay(true);
      },
      enabled: () => canEdit() && !!redoStack.current.length,
    },
    cancel: {
      run: () => {
        const transient =
          !!gesture.current ||
          !!connector ||
          !!context ||
          drawMode ||
          areaMode ||
          layoutMenu ||
          !!edgeMenu;
        cancelGesture();
        if (!transient) setSelection(null);
        setContext(null);
        setDrawMode(false);
        setAreaMode(false);
        setLayoutMenu(false);
        setEdgeMenu(null);
      },
    },
    'map.create': { run: () => quickCreate(), enabled: canEdit },
    'map.child': {
      run: () => quickCreate(true),
      enabled: () => canEdit() && !!selectedNode,
    },
    'map.sibling': {
      run: () => quickCreate(false, true),
      enabled: () => canEdit() && !!selectedNode,
    },
    'map.edit': {
      run: () =>
        selectedItem &&
        openEditor(selectedNode ? 'node' : 'group', selectedItem.id),
      enabled: () => canEdit() && !!selectedItem,
    },
    'map.rename': {
      run: () => {
        if (selectedNode) {
          unsavedRef.current = true;
          setInline({ id: selectedNode.id, name: selectedNode.name });
        }
      },
      enabled: () => canEdit() && !!selectedNode,
    },
    'map.area': {
      run: () => {
        setAreaMode(true);
        setDrawMode(false);
        setSelection(null);
      },
      enabled: canSelect,
    },
    'map.all': {
      run: () => selectNodes(shownNodes.map((n) => n.id)),
      enabled: canSelect,
    },
    'map.copy': {
      run: copySelection,
      enabled: () => canSelect() && (!!nodeIds.length || !!selectedGroup),
    },
    'map.paste': {
      run: () => {
        void pasteSelection();
      },
      enabled: () => canEdit() && !!keyboard?.getClipboard(),
    },
    'map.duplicate': {
      run: () => {
        void pasteSelection(true);
      },
      enabled: () => canEdit() && (!!nodeIds.length || !!selectedGroup),
    },
    'map.delete': {
      run: () => {
        void deleteSelection();
      },
      enabled: () => canEdit() && !!selection,
    },
    'map.group': {
      run: () => {
        setDrawMode(true);
        setAreaMode(false);
        setSelection(null);
      },
      enabled: canEdit,
    },
    'map.collapse': {
      run: () => {
        if (selectedGroup && docRef.current)
          void save(
            {
              ...docRef.current,
              groups: docRef.current.groups.map((g) =>
                g.id === selectedGroup.id
                  ? { ...g, collapsed: !g.collapsed }
                  : g,
              ),
            },
            'Toggle group',
          );
      },
      enabled: () => canEdit() && !!selectedGroup,
    },
    'map.connect': {
      run: () => {
        if (selectedNode)
          setConnector({
            source: selectedNode.id,
            point: {
              x: selectedNode.x + nodeSize(selectedNode).width,
              y: selectedNode.y + nodeSize(selectedNode).height / 2,
            },
          });
      },
      enabled: () => canEdit() && !!selectedNode,
    },
    'map.confirm': {
      run: () => confirmConnection(),
      enabled: () =>
        canEdit() &&
        !!connector &&
        !!selectedNode &&
        selectedNode.id !== connector.source,
    },
    'map.line': {
      run: () => {
        if (selectedEdge && docRef.current)
          void save(
            {
              ...docRef.current,
              edges: docRef.current.edges.map((e) =>
                e.id === selectedEdge.id
                  ? { ...e, line: e.line === 'solid' ? 'dashed' : 'solid' }
                  : e,
              ),
            },
            'Change line',
          );
      },
      enabled: () => canEdit() && !!selectedEdge,
    },
    'map.arrow': {
      run: () => {
        if (selectedEdge && docRef.current)
          void save(
            {
              ...docRef.current,
              edges: docRef.current.edges.map((e) =>
                e.id === selectedEdge.id
                  ? {
                      ...e,
                      direction:
                        e.direction === 'none'
                          ? 'forward'
                          : e.direction === 'forward'
                            ? 'both'
                            : 'none',
                    }
                  : e,
              ),
            },
            'Change arrow',
          );
      },
      enabled: () => canEdit() && !!selectedEdge,
    },
    'map.link': {
      run: () => {
        if (selectedNode?.url)
          window.open(selectedNode.url, '_blank', 'noopener,noreferrer');
      },
      enabled: () => !!selectedNode?.url,
    },
    'map.pan': {
      run: () => {
        panHeld.current = true;
      },
      release: () => {
        panHeld.current = false;
      },
      enabled: canSelect,
    },
    'map.zoomIn': { run: () => zoomBy(1.2), enabled: canSelect },
    'map.zoomOut': { run: () => zoomBy(1 / 1.2), enabled: canSelect },
    'map.resetZoom': {
      run: () => zoomBy(1 / viewportRef.current.zoom),
      enabled: canSelect,
    },
    'map.fit': {
      run: () => docRef.current && fit(docRef.current),
      enabled: canSelect,
    },
    'map.find': {
      run: () =>
        canvasRef.current
          ?.closest('section')
          ?.querySelector<HTMLInputElement>('[data-shortcut-search]')
          ?.focus(),
    },
    'map.layout': {
      run: () => {
        setLayoutMenu(true);
        requestAnimationFrame(() =>
          canvasRef.current
            ?.closest('section')
            ?.querySelector<HTMLButtonElement>(
              '.sm-layout-menu button:not(:disabled)',
            )
            ?.focus(),
        );
      },
      enabled: canEdit,
    },
    'map.new': {
      run: () => openEditor('map'),
      enabled: () => !busy && !failed && !inline,
    },
    'map.settings': {
      run: () => map && openEditor('map', map.id),
      enabled: canEdit,
    },
    'map.history': {
      run: () => {
        void showHistory();
      },
      enabled: () => !!map && !busy && !inline,
    },
    'map.trash': {
      run: () => {
        setTrashOpen(true);
        void systemMaps
          .list(true)
          .then(setTrash)
          .catch((e) => setMessage(getErrorMessage(e)));
      },
      enabled: () => !busy && !inline,
    },
    'map.trashMap': {
      run: () => {
        if (map) void runAction('trash', map);
      },
      enabled: canEdit,
    },
    'map.shortcuts': { run: () => keyboard?.openSettings() },
    ...Object.fromEntries(
      (['Left', 'Right', 'Up', 'Down'] as const).flatMap((d) => [
        [`map.select${d}`, { run: () => spatial(d), enabled: canSelect }],
        [`map.extend${d}`, { run: () => spatial(d, true), enabled: canSelect }],
        [
          `map.move${d}`,
          {
            run: () =>
              nudge(
                d === 'Left' ? -10 : d === 'Right' ? 10 : 0,
                d === 'Up' ? -10 : d === 'Down' ? 10 : 0,
              ),
            enabled: () => canEdit() && !!nodeIds.length,
          },
        ],
      ]),
    ),
  });

  return (
    <section className="system-map" aria-label="System Map" role="application">
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
            variant="ghost"
            size="sm"
            disabled={!editable || !historyCount.undo}
            onClick={() => void replay()}
          >
            Undo
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={!editable || !historyCount.redo}
            onClick={() => void replay(true)}
          >
            Redo
          </Button>
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
            data-shortcut-search
            placeholder="Find a node…"
            value={query}
            disabled={!!inline}
            onChange={(e) => updateQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.nativeEvent.isComposing || e.repeat) return;
              if (e.key === 'Enter') {
                e.preventDefault();
                e.stopPropagation();
                jumpResult(e.shiftKey);
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                updateQuery('');
              }
            }}
          />
          {query && (
            <button
              type="button"
              aria-label="Clear search"
              onClick={() => updateQuery('')}
            >
              <X size={14} />
            </button>
          )}
        </label>
        {query.trim() && (
          <div className="sm-search-actions">
            <span role="status">
              {searchIndex >= 0 && searchMatches[searchIndex]
                ? searchIndex + 1
                : 0}{' '}
              / {searchMatches.length}
            </span>
            <Button
              size="sm"
              variant="ghost"
              disabled={!searchMatches.length}
              onClick={() => jumpResult(true)}
              aria-label="Previous search result"
            >
              ↑
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={!searchMatches.length}
              onClick={() => jumpResult()}
              aria-label="Next search result"
            >
              ↓
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!searchMatches.length}
              onClick={fitResults}
            >
              Fit results
            </Button>
          </div>
        )}
        <Button
          size="sm"
          variant="ghost"
          disabled={!editable || !nodeIds.length}
          aria-pressed={!!selectedNode?.keep_position}
          onClick={toggleKeepPosition}
          title="Automatic layouts keep pinned nodes in place. Manual dragging remains available."
        >
          <Pin />
          Keep position
        </Button>
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
            <div
              role="group"
              aria-label="Auto layout choices"
              data-shortcut-menu
              className="sm-layout-menu"
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setLayoutMenu(false);
                  canvasRef.current?.focus({ preventScroll: true });
                }
                if (['ArrowDown', 'ArrowUp'].includes(e.key)) {
                  e.preventDefault();
                  e.stopPropagation();
                  const buttons = Array.from(
                    e.currentTarget.querySelectorAll<HTMLButtonElement>(
                      'button:not(:disabled)',
                    ),
                  );
                  const index = buttons.indexOf(
                    document.activeElement as HTMLButtonElement,
                  );
                  buttons[
                    (index + (e.key === 'ArrowDown' ? 1 : buttons.length - 1)) %
                      buttons.length
                  ]?.focus();
                }
              }}
            >
              <button
                type="button"
                disabled={!selectedNode}
                onClick={() => {
                  setLayoutMenu(false);
                  arrangeSelection('branch');
                }}
              >
                Arrange branch → Right
              </button>
              <span className="sm-menu-label">Selected nodes (unpinned)</span>
              {(
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
              ).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={
                    nodeIds.length <
                    (kind === 'horizontal' || kind === 'vertical' ? 3 : 2)
                  }
                  onClick={() => {
                    setLayoutMenu(false);
                    arrangeSelection(kind);
                  }}
                >
                  {kind === 'horizontal'
                    ? 'Distribute horizontally'
                    : kind === 'vertical'
                      ? 'Distribute vertically'
                      : `Align ${kind}`}
                </button>
              ))}
              <span className="sm-menu-label">Whole map</span>
              <button
                type="button"
                onClick={() => {
                  setLayoutMenu(false);
                  arrangeWhole('grid');
                }}
              >
                Grid
              </button>
              <button
                type="button"
                onClick={() => {
                  setLayoutMenu(false);
                  arrangeWhole('circle');
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
      {doc?.nodes.some(
        (n) => n.width === undefined || n.height === undefined,
      ) && (
        <p className="sm-message" role="status">
          Some legacy nodes retain their old bounds because this map is at a
          size limit. Free space in their group or remove unused content, then
          edit their title to resize.
        </p>
      )}
      <div className="sm-workspace">
        <div
          ref={canvasRef}
          className={`sm-canvas ${drawMode || areaMode ? 'sm-drawing' : ''}`}
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
            begin(
              e,
              drawMode ? 'draw' : areaMode || e.shiftKey ? 'area' : 'pan',
            );
          }}
          onPointerMove={(e) => {
            pointerClient.current = { x: e.clientX, y: e.clientY };
            move(e);
          }}
          onPointerLeave={() => {
            if (!gesture.current) pointerClient.current = null;
          }}
          onPointerUp={finish}
          onPointerCancel={cancelGesture}
        >
          {!doc && (
            <div className="sm-empty">
              <Group size={28} />
              <h2>{busy ? 'Loading map…' : 'Your ideas, connected'}</h2>
              <p>Create a Map for systems, projects or relationships.</p>
              <Button
                disabled={busy || failed}
                onClick={() => openEditor('map')}
              >
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
                      <span
                        className="sm-dot"
                        style={{ background: g.color }}
                      />
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
                  {(['normal', 'selected', 'hover'] as const).map((tone) => (
                    <marker
                      key={tone}
                      id={`${markerId}-${tone}`}
                      markerWidth="7"
                      markerHeight="7"
                      refX="6"
                      refY="3.5"
                      orient="auto-start-reverse"
                    >
                      <path
                        d="M0 0 L7 3.5 L0 7"
                        fill={
                          tone === 'hover'
                            ? '#FF1744'
                            : tone === 'selected'
                              ? 'var(--primary)'
                              : 'var(--muted-foreground)'
                        }
                      />
                    </marker>
                  ))}
                </defs>
                {doc.edges.map((edge) => {
                  const a = shownById.get(edge.source),
                    b = shownById.get(edge.target);
                  if (!a || !b) return null;
                  if (
                    selection?.id !== edge.id &&
                    !intersectsBox(edgeBoxes.get(edge.id)!, visibleBox)
                  )
                    return null;
                  const path = edgePaths.get(edge.id)!;
                  const emphasis = mapEdgeEmphasis(
                    edge.source,
                    edge.target,
                    activeNodeId,
                    selection?.kind === 'edge' && selection.id === edge.id,
                  );
                  const arrowMarker = `${markerId}-${emphasis === 'dim' ? 'normal' : emphasis}`;
                  return (
                    <g key={edge.id}>
                      <path
                        d={path}
                        className={`sm-edge sm-edge-${emphasis} ${searching && !matchingIds.has(edge.source) && !matchingIds.has(edge.target) && emphasis === 'normal' ? 'sm-search-dim' : ''}`}
                        strokeDasharray={
                          edge.line === 'dashed' ? '6 5' : undefined
                        }
                        markerEnd={
                          edge.direction === 'none'
                            ? undefined
                            : `url(#${arrowMarker})`
                        }
                        markerStart={
                          edge.direction === 'both'
                            ? `url(#${arrowMarker})`
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
                        d={`M${a.x + nodeSize(a).width} ${a.y + nodeSize(a).height / 2} L${connector.point.x} ${connector.point.y}`}
                      />
                    );
                  })()}
              </svg>
              <div className="sm-nodes">
                {renderedNodes.map((node) => {
                  const match = matchingIds.has(node.id);
                  const lowDetail =
                    viewport.zoom < 0.35 &&
                    selection?.id !== node.id &&
                    inline?.id !== node.id;
                  return (
                    <div
                      key={node.id}
                      data-node-id={node.id}
                      className={`sm-node ${selectedIds.has(node.id) || inline?.id === node.id ? 'sm-selected' : ''} ${match ? 'sm-search-match' : searching ? 'sm-search-dim' : ''} ${match && searchMatches[searchIndex]?.id === node.id ? 'sm-search-current' : ''}`}
                      style={{ left: node.x, top: node.y, ...nodeSize(node) }}
                      onPointerEnter={(e) => {
                        if (e.pointerType !== 'touch')
                          setHoveredNodeId(node.id);
                      }}
                      onPointerLeave={() => setHoveredNodeId(null)}
                      onFocus={(e) => {
                        if (
                          e.target instanceof Element &&
                          e.target.matches(':focus-visible')
                        )
                          setFocusedNodeId(node.id);
                      }}
                      onBlur={(e) => {
                        if (
                          !e.currentTarget.contains(
                            e.relatedTarget as Node | null,
                          )
                        )
                          setFocusedNodeId(null);
                      }}
                    >
                      <button
                        type="button"
                        className="sm-node-body"
                        style={
                          lowDetail ? { background: node.color } : undefined
                        }
                        aria-label={`Select node ${node.name}`}
                        title={node.name}
                        onPointerDown={(e) => {
                          if (e.shiftKey) {
                            nodeClickMoved.current = false;
                            e.stopPropagation();
                          } else begin(e, 'node', node.id);
                        }}
                        onClick={(e) => {
                          if (
                            !inline &&
                            (e.detail === 0 || !nodeClickMoved.current)
                          )
                            chooseNode(node.id, e.shiftKey);
                        }}
                        onDoubleClick={(e) => {
                          e.stopPropagation();
                          if (
                            editable &&
                            !(
                              lastNodeDrag.current.id === node.id &&
                              e.timeStamp - lastNodeDrag.current.at < 500
                            )
                          )
                            openEditor('node', node.id);
                        }}
                      >
                        {!lowDetail && (
                          <>
                            <span
                              className="sm-node-symbol"
                              style={{
                                color: node.color,
                                background: `color-mix(in srgb, ${node.color} 12%, var(--card))`,
                              }}
                            >
                              <Group size={16} />
                            </span>
                            <span className="sm-node-name">
                              {highlightParts(node.name, query).map(
                                (part, i) =>
                                  part.match ? (
                                    <mark key={i}>{part.text}</mark>
                                  ) : (
                                    part.text
                                  ),
                              )}
                            </span>
                            {node.keep_position && (
                              <Pin
                                size={12}
                                className="sm-pin-mark"
                                aria-label="Position kept"
                              />
                            )}
                            {node.url && (
                              <ExternalLink
                                className="sm-link-mark"
                                size={12}
                              />
                            )}
                          </>
                        )}
                      </button>
                      {inline?.id === node.id && (
                        <input
                          ref={(element) => {
                            if (element && document.activeElement !== element) {
                              element.focus({ preventScroll: true });
                              element.select();
                            }
                          }}
                          aria-label="Node name"
                          className="sm-inline-name"
                          value={inline.name}
                          maxLength={120}
                          disabled={busy || failed}
                          onFocus={(e) => e.currentTarget.select()}
                          onChange={(e) =>
                            setInline({ ...inline, name: e.target.value })
                          }
                          onPointerDown={(e) => e.stopPropagation()}
                          onKeyDown={(e) => {
                            if (
                              e.nativeEvent.isComposing ||
                              Reflect.get(e.nativeEvent, 'keyCode') === 229 ||
                              e.repeat
                            )
                              return;
                            if (e.key === 'Enter') {
                              e.preventDefault();
                              e.stopPropagation();
                              void commitInline();
                            }
                            if (e.key === 'Escape') {
                              e.preventDefault();
                              e.stopPropagation();
                              cancelInline();
                            }
                          }}
                        />
                      )}
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
                                point: {
                                  x: node.x + nodeSize(node).width,
                                  y: node.y + nodeSize(node).height / 2,
                                },
                              });
                              setSelection({ kind: 'node', id: node.id });
                            }
                          }}
                        />
                      )}
                      {connector &&
                        !dragging &&
                        connector.source !== node.id && (
                          <button
                            type="button"
                            className="sm-connect-target"
                            aria-label={`Connect to ${node.name}`}
                            onClick={() => confirmConnection(node.id)}
                          >
                            Connect here
                          </button>
                        )}
                    </div>
                  );
                })}
              </div>
              {guides.guideX !== undefined && (
                <div
                  className="sm-guide sm-guide-x"
                  style={{ left: guides.guideX, top: -20000, height: 40000 }}
                />
              )}
              {guides.guideY !== undefined && (
                <div
                  className="sm-guide sm-guide-y"
                  style={{ top: guides.guideY, left: -20000, width: 40000 }}
                />
              )}
              {drawRect && (
                <div
                  className={`sm-draw-preview ${!drawMode ? 'sm-area-preview' : ''}`}
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
                onClick={() => {
                  pointerWorld.current = context.world;
                  quickCreate();
                }}
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
                      openEditor(
                        selectedNode ? 'node' : 'group',
                        selectedItem.id,
                      )
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
                  <Button variant="ghost" size="sm" onClick={copySelection}>
                    Copy
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void pasteSelection(true)}
                  >
                    Duplicate
                  </Button>
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
                  if (query.trim()) fitResults();
                  else fit(doc);
                  setSelection(null);
                }}
              >
                <svg
                  viewBox={`${bounds.x} ${bounds.y} ${bounds.width} ${bounds.height}`}
                  aria-hidden="true"
                >
                  <OverviewShapes nodes={shownNodes} groups={overviewGroups} />
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
        {selectedNode && (
          <aside className="sm-node-details" aria-label="Node details">
            <div className="sm-details-heading">
              <h2>Node details</h2>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close node details"
                onClick={() => {
                  setSelection(null);
                  canvasRef.current?.focus();
                }}
              >
                <X />
              </Button>
            </div>
            <div
              className="sm-details-content"
              tabIndex={0}
              role="region"
              aria-label="Full node name and description"
            >
              <h3>{selectedNode.name}</h3>
              {selectedNode.description ? (
                <p>{selectedNode.description}</p>
              ) : (
                <p className="sm-details-empty">
                  No description yet. Edit this node to add notes or a list.
                </p>
              )}
            </div>
            <div className="sm-details-actions">
              <Button
                variant="outline"
                size="sm"
                disabled={!editable}
                onClick={() => openEditor('node', selectedNode.id)}
              >
                <Pencil />
                Edit node
              </Button>
              {selectedNode.url && (
                <a
                  href={selectedNode.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <ExternalLink size={14} />
                  Open link
                </a>
              )}
            </div>
          </aside>
        )}
        {!selectedNode && (
          <aside
            className="sm-node-details sm-details-placeholder"
            aria-label="Node details"
          >
            <div className="sm-details-heading">
              <h2>Node details</h2>
            </div>
            <div className="sm-details-content">
              <p className="sm-details-empty">
                Select a node to read its full name and notes. Double-click a
                node to edit it.
              </p>
            </div>
          </aside>
        )}
      </div>
      <footer className="sm-footer">
        <span>
          {doc
            ? `${doc.nodes.length} nodes · ${doc.groups.length} groups`
            : 'Independent maps'}
          {query ? ` · ${searchMatches.length} matches` : ''}
          {nodeIds.length ? ` · ${nodeIds.length} selected` : ''}
        </span>
        <span aria-live="polite">
          {busy ? (
            <>
              <LoaderCircle size={13} className="animate-spin" />
              Saving…
            </>
          ) : failed ? (
            'Changes not saved'
          ) : inline ? (
            'Enter to confirm name · Esc to cancel'
          ) : areaMode ? (
            'Drag to select nodes · Esc to cancel'
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
        <DialogContent className="max-h-[90dvh] overflow-y-auto">
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
