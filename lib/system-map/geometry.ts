import type { MapDocument, MapNode } from './model';
import { GROUP_HEADER, nodeSize, validateMapDocument } from './schema.mjs';

type Point = { x: number; y: number };
type Box = Point & { width: number; height: number };
export type TextMeasure = (text: string) => number;
export type Alignment =
  | 'left'
  | 'center'
  | 'right'
  | 'top'
  | 'middle'
  | 'bottom'
  | 'horizontal'
  | 'vertical';
export const nodeBox = (node: MapNode): Box => ({
  x: node.x,
  y: node.y,
  ...nodeSize(node),
});

// The browser supplies canvas font metrics. The pure fallback is for non-DOM
// callers only; geometry after sizing always uses the persisted explicit bounds.
export function contentSize(
  name: string,
  measure: TextMeasure = (s) => Array.from(s).length * 8,
  link = false,
) {
  const padding = link ? 98 : 76;
  const width = Math.ceil(
    Math.max(140, Math.min(380, measure(name) + padding + 4)),
  );
  const available = width - padding - 4;
  let lines = 1,
    line = '';
  for (const word of name.split(/(\s+)/u)) {
    if (word.includes('\n')) {
      lines += word.split('\n').length - 1;
      line = '';
      continue;
    }
    if (measure(line + word) <= available) {
      line += word;
      continue;
    }
    if (line.trim()) {
      ++lines;
      line = '';
    }
    // Split unbroken text by Unicode codepoints, never by UTF-16 halves.
    for (const char of Array.from(word.trimStart())) {
      if (line && measure(line + char) > available) {
        ++lines;
        line = '';
      }
      line += char;
    }
  }
  return { width, height: Math.max(64, Math.min(1024, lines * 20 + 30)) };
}
export function refitGroups(doc: MapDocument, tight = false): MapDocument {
  return {
    ...doc,
    groups: doc.groups.map((g) => {
      const children = doc.nodes.filter((n) => n.group_id === g.id);
      if (!children.length) return g;
      const left = Math.min(...children.map((n) => n.x));
      const top = Math.min(...children.map((n) => n.y - GROUP_HEADER));
      const right = Math.max(...children.map((n) => n.x + nodeSize(n).width));
      const bottom = Math.max(...children.map((n) => n.y + nodeSize(n).height));
      if (
        !tight &&
        left >= g.x &&
        top >= g.y &&
        right <= g.x + g.width &&
        bottom <= g.y + g.height
      )
        return g;
      const x = tight ? left : Math.min(g.x, left);
      const y = tight ? top : Math.min(g.y, top);
      const endX = tight ? right : Math.max(g.x + g.width, right);
      const endY = tight ? bottom : Math.max(g.y + g.height, bottom);
      const paddedX = Math.max(-20000, x - 20),
        paddedY = Math.max(-20000, y - 20);
      const width = Math.max(220, endX + 20 - paddedX),
        height = Math.max(130, endY + 20 - paddedY);
      // Padding is optional; containment is not. Never break a legal boundary
      // group just to add breathing room. Tight refits are for whole-map layouts.
      return width <= 8000 && height <= 8000
        ? { ...g, x: paddedX, y: paddedY, width, height }
        : {
            ...g,
            x,
            y,
            width: Math.max(220, endX - x),
            height: Math.max(130, endY - y),
          };
    }),
  };
}
export function materializeSizes(
  doc: MapDocument,
  measure: TextMeasure,
): MapDocument {
  if (doc.nodes.every((n) => n.width !== undefined && n.height !== undefined))
    return doc;
  const sized = refitGroups({
    ...doc,
    nodes: doc.nodes.map((n) =>
      n.width !== undefined && n.height !== undefined
        ? n
        : { ...n, ...contentSize(n.name, measure, !!n.url) },
    ),
  });
  try {
    validateMapDocument(sized);
    return sized;
  } catch {
    // Never silently detach members or make a valid legacy map unsaveable when
    // its group is already at the 8,000px/coordinate limit.
    let safe = doc;
    for (const n of doc.nodes.filter(
      (n) => n.width === undefined || n.height === undefined,
    )) {
      const candidate = refitGroups({
        ...safe,
        nodes: safe.nodes.map((item) =>
          item.id === n.id
            ? { ...item, ...contentSize(item.name, measure, !!item.url) }
            : item,
        ),
      });
      try {
        validateMapDocument(candidate);
        safe = candidate;
      } catch {
        /* Keep legacy bounds until space is available. */
      }
    }
    return safe;
  }
}
export function overlaps(a: Box, b: Box, gap = 24) {
  return (
    a.x < b.x + b.width + gap &&
    a.x + a.width + gap > b.x &&
    a.y < b.y + b.height + gap &&
    a.y + a.height + gap > b.y
  );
}
export class NodeObstacles {
  private cells = new Map<string, MapNode[]>();
  length = 0;
  constructor(nodes: MapNode[] = []) {
    for (const n of nodes) this.add(n);
  }
  add(node: MapNode) {
    const box = nodeBox(node);
    for (
      let x = Math.floor(box.x / 512);
      x <= Math.floor((box.x + box.width) / 512);
      ++x
    )
      for (
        let y = Math.floor(box.y / 512);
        y <= Math.floor((box.y + box.height) / 512);
        ++y
      ) {
        const key = `${x}:${y}`,
          list = this.cells.get(key) ?? [];
        list.push(node);
        this.cells.set(key, list);
      }
    ++this.length;
  }
  hits(box: Box, gap: number) {
    const candidates = new Set<MapNode>();
    for (
      let x = Math.floor((box.x - gap) / 512);
      x <= Math.floor((box.x + box.width + gap) / 512);
      ++x
    )
      for (
        let y = Math.floor((box.y - gap) / 512);
        y <= Math.floor((box.y + box.height + gap) / 512);
        ++y
      )
        for (const n of this.cells.get(`${x}:${y}`) ?? []) candidates.add(n);
    return [...candidates].filter((n) => overlaps(box, nodeBox(n), gap));
  }
}
export function findOpenPoint(
  node: MapNode,
  point: Point,
  obstacles: MapNode[] | NodeObstacles,
  gap = 24,
): Point {
  let y = point.y;
  const box = nodeSize(node);
  const x = point.x;
  if (Math.abs(x) > 20000)
    throw new Error(
      'No free space here. Move the branch away from the coordinate limit.',
    );
  for (let i = 0; i <= obstacles.length; ++i) {
    const hits = (
      obstacles instanceof NodeObstacles
        ? obstacles.hits({ x, y, ...box }, gap)
        : obstacles
    ).filter(
      (n) => n.id !== node.id && overlaps({ x, y, ...box }, nodeBox(n), gap),
    );
    if (!hits.length) {
      if (y > 20000 || y < -20000)
        throw new Error(
          'No free space here. Move the branch away from the coordinate limit.',
        );
      return { x, y };
    }
    y = Math.max(...hits.map((n) => n.y + nodeSize(n).height + gap));
  }
  throw new Error('No free space for this node.');
}
export function newNodePoint(
  doc: MapDocument,
  node: MapNode,
  anchor?: MapNode,
  nearby = false,
): Point {
  let point = { x: node.x, y: node.y };
  if (anchor) {
    point = nearby
      ? { x: anchor.x, y: anchor.y + nodeSize(anchor).height + 24 }
      : { x: anchor.x + nodeSize(anchor).width + 70, y: anchor.y };
    // Children from a common source occupy one column even with different widths.
    if (!nearby) {
      const ids = doc.edges
        .filter((e) => e.source === anchor.id && e.direction === 'forward')
        .map((e) => e.target);
      const siblings = doc.nodes.filter((n) => ids.includes(n.id));
      if (siblings.length)
        point.x = Math.max(point.x, ...siblings.map((n) => n.x));
    }
  }
  if (!anchor || nearby)
    return findOpenPoint(node, point, new NodeObstacles(doc.nodes));
  const obstacles = new NodeObstacles(doc.nodes),
    step =
      Math.max(
        nodeSize(node).width,
        ...doc.nodes
          .filter((n) => n.x === point.x)
          .map((n) => nodeSize(n).width),
      ) + 24;
  for (let lane = 0; lane <= doc.nodes.length; ++lane) {
    try {
      const p = findOpenPoint(node, point, obstacles);
      if (p.y + nodeSize(node).height <= anchor.y + 7600) return p;
    } catch (error) {
      if (Math.abs(point.x) > 20000) throw error;
    }
    point = { x: point.x + step, y: anchor.y };
  }
  throw new Error('No free space for this branch.');
}
export function alignNodes(
  doc: MapDocument,
  ids: readonly string[],
  kind: Alignment,
): MapDocument {
  const selected = doc.nodes.filter(
    (n) => ids.includes(n.id) && !n.keep_position,
  );
  if (selected.length < 2)
    throw new Error('Select at least two unpinned nodes.');
  const left = Math.min(...selected.map((n) => n.x)),
    right = Math.max(...selected.map((n) => n.x + nodeSize(n).width));
  const top = Math.min(...selected.map((n) => n.y)),
    bottom = Math.max(...selected.map((n) => n.y + nodeSize(n).height));
  const positions = new Map<string, Point>();
  if (kind === 'horizontal' || kind === 'vertical') {
    if (selected.length < 3)
      throw new Error('Select at least three unpinned nodes to distribute.');
    const horizontal = kind === 'horizontal';
    const sorted = [...selected].sort(
      (a, b) =>
        (horizontal ? a.x - b.x : a.y - b.y) || a.id.localeCompare(b.id),
    );
    const total = sorted.reduce(
      (sum, n) => sum + (horizontal ? nodeSize(n).width : nodeSize(n).height),
      0,
    );
    const gap = Math.max(
      24,
      ((horizontal ? right - left : bottom - top) - total) /
        (sorted.length - 1),
    );
    let cursor = horizontal ? left : top;
    for (const n of sorted) {
      positions.set(
        n.id,
        horizontal ? { x: cursor, y: n.y } : { x: n.x, y: cursor },
      );
      cursor += (horizontal ? nodeSize(n).width : nodeSize(n).height) + gap;
    }
  } else
    for (const n of selected) {
      const s = nodeSize(n);
      positions.set(n.id, {
        x:
          kind === 'left'
            ? left
            : kind === 'center'
              ? (left + right - s.width) / 2
              : kind === 'right'
                ? right - s.width
                : n.x,
        y:
          kind === 'top'
            ? top
            : kind === 'middle'
              ? (top + bottom - s.height) / 2
              : kind === 'bottom'
                ? bottom - s.height
                : n.y,
      });
    }
  const obstacles = doc.nodes.filter((n) => !positions.has(n.id));
  const placed: MapNode[] = [];
  for (const n of selected) {
    const candidate = { ...n, ...positions.get(n.id)! };
    if (
      [...obstacles, ...placed].some((other) =>
        overlaps(nodeBox(candidate), nodeBox(other), 0),
      )
    )
      throw new Error(
        'This alignment would overlap nodes. Distribute them or move nearby nodes first.',
      );
    placed.push(candidate);
  }
  const next = refitGroups({
    ...doc,
    nodes: doc.nodes.map((n) =>
      positions.has(n.id) ? { ...n, ...positions.get(n.id)! } : n,
    ),
  });
  validateMapDocument(next);
  return next;
}
export function arrangeBranch(doc: MapDocument, rootId: string): MapDocument {
  const root = doc.nodes.find((n) => n.id === rootId);
  if (!root) throw new Error('Select a branch root.');
  const forward = doc.edges.filter((e) => e.direction === 'forward');
  const reachable = new Set([rootId]);
  const pending = [rootId];
  for (let i = 0; i < pending.length; ++i)
    for (const edge of forward.filter((e) => e.source === pending[i])) {
      if (!reachable.has(edge.target)) {
        reachable.add(edge.target);
        pending.push(edge.target);
      }
    }
  // Shared nodes, and everything only accessible through them, stay stationary.
  const blocked = new Set(
    doc.nodes
      .filter(
        (n) =>
          n.id !== rootId &&
          forward.some((e) => e.target === n.id && !reachable.has(e.source)),
      )
      .map((n) => n.id),
  );
  const depths = new Map([[rootId, 0]]),
    queue = [rootId];
  for (let i = 0; i < queue.length; ++i)
    for (const edge of forward.filter((e) => e.source === queue[i])) {
      if (!blocked.has(edge.target) && !depths.has(edge.target)) {
        depths.set(edge.target, depths.get(queue[i])! + 1);
        queue.push(edge.target);
      }
    }
  const moving = doc.nodes.filter(
    (n) => n.id !== rootId && depths.has(n.id) && !n.keep_position,
  );
  const movingIds = new Set(moving.map((n) => n.id));
  const obstacles = new NodeObstacles(
    doc.nodes.filter((n) => !movingIds.has(n.id)),
  );
  const positions = new Map<string, Point>();
  let x = root.x + nodeSize(root).width + 70;
  for (let depth = 1; depth <= Math.max(0, ...depths.values()); ++depth) {
    const column = doc.nodes
      .filter((n) => depths.get(n.id) === depth)
      .sort((a, b) => a.y - b.y || a.id.localeCompare(b.id));
    let y = root.y;
    let laneX = x;
    const laneStep =
      Math.max(140, ...column.map((n) => nodeSize(n).width)) + 24;
    for (const n of column) {
      if (n.keep_position) continue;
      let placed = false;
      for (let lane = 0; lane <= doc.nodes.length; ++lane) {
        if (y + nodeSize(n).height > root.y + 7600) {
          laneX += laneStep;
          y = root.y;
        }
        try {
          const p = findOpenPoint(n, { x: laneX, y }, obstacles);
          if (p.y + nodeSize(n).height > root.y + 7600) {
            laneX += laneStep;
            y = root.y;
            continue;
          }
          positions.set(n.id, p);
          obstacles.add({ ...n, ...p });
          y = p.y + nodeSize(n).height + 24;
          placed = true;
          break;
        } catch (error) {
          if (Math.abs(laneX) > 20000) throw error;
          laneX += laneStep;
          y = root.y;
        }
      }
      if (!placed) throw new Error('No free space for this branch.');
    }
    x = Math.max(
      laneX + Math.max(140, ...column.map((n) => nodeSize(n).width)) + 70,
      ...column
        .filter((n) => n.keep_position)
        .map((n) => n.x + nodeSize(n).width + 70),
    );
  }
  const next = refitGroups({
    ...doc,
    nodes: doc.nodes.map((n) =>
      positions.has(n.id) ? { ...n, ...positions.get(n.id)! } : n,
    ),
  });
  validateMapDocument(next);
  return next;
}
export function snapNodeMove(
  doc: MapDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
  tolerance: number,
) {
  return snapIndexedNodes(
    doc,
    ids,
    createSnapIndex(doc, ids),
    dx,
    dy,
    tolerance,
  );
}
export function createSnapIndex(doc: MapDocument, ids: readonly string[]) {
  const selected = new Set(ids);
  const others = doc.nodes.filter(
    (n) =>
      !selected.has(n.id) &&
      !doc.groups.find((g) => g.id === n.group_id)?.collapsed,
  );
  return {
    x: [0, 0.5, 1].map((f) =>
      others.map((n) => n.x + nodeSize(n).width * f).sort((a, b) => a - b),
    ),
    y: [0, 0.5, 1].map((f) =>
      others.map((n) => n.y + nodeSize(n).height * f).sort((a, b) => a - b),
    ),
  };
}
export function snapIndexedNodes(
  doc: MapDocument,
  ids: readonly string[],
  index: ReturnType<typeof createSnapIndex>,
  dx: number,
  dy: number,
  tolerance: number,
) {
  const selected = new Set(ids),
    moving = doc.nodes.filter((n) => selected.has(n.id));
  let sx = 0,
    sy = 0,
    bestX = tolerance,
    bestY = tolerance;
  let guideX: number | undefined, guideY: number | undefined;
  function nearest(values: number[], point: number) {
    let low = 0,
      high = values.length;
    while (low < high) {
      const mid = (low + high) >>> 1;
      if (values[mid] < point) low = mid + 1;
      else high = mid;
    }
    const a = values[low],
      b = values[low - 1];
    return a === undefined
      ? b
      : b === undefined
        ? a
        : Math.abs(a - point) < Math.abs(b - point)
          ? a
          : b;
  }
  for (const n of moving) {
    const ns = nodeSize(n);
    const aX = [n.x + dx, n.x + dx + ns.width / 2, n.x + dx + ns.width],
      aY = [n.y + dy, n.y + dy + ns.height / 2, n.y + dy + ns.height];
    for (let i = 0; i < 3; ++i) {
      const x = nearest(index.x[i], aX[i]),
        y = nearest(index.y[i], aY[i]);
      const cx = x === undefined ? Infinity : x - aX[i],
        cy = y === undefined ? Infinity : y - aY[i];
      if (Math.abs(cx) < bestX) {
        bestX = Math.abs(cx);
        sx = cx;
        guideX = x;
      }
      if (Math.abs(cy) < bestY) {
        bestY = Math.abs(cy);
        sy = cy;
        guideY = y;
      }
    }
  }
  return { dx: dx + sx, dy: dy + sy, guideX, guideY };
}
export type MapBox = { x: number; y: number; width: number; height: number };
export const MIN_MAP_ZOOM = 0.005;
export function viewportBox(
  viewport: { x: number; y: number; zoom: number },
  size: { width: number; height: number },
  padding = 100,
): MapBox {
  return {
    x: (-viewport.x - padding) / viewport.zoom,
    y: (-viewport.y - padding) / viewport.zoom,
    width: (size.width + padding * 2) / viewport.zoom,
    height: (size.height + padding * 2) / viewport.zoom,
  };
}
export function intersectsBox(a: MapBox, b: MapBox) {
  return (
    a.x <= b.x + b.width &&
    a.x + a.width >= b.x &&
    a.y <= b.y + b.height &&
    a.y + a.height >= b.y
  );
}
export function nodesInViewport(
  nodes: MapNode[],
  box: MapBox,
  keep: ReadonlySet<string> = new Set(),
) {
  return nodes.filter((n) => keep.has(n.id) || intersectsBox(nodeBox(n), box));
}
export function connectionBounds(path: string): MapBox {
  const values = [...path.matchAll(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi)].map(
      (m) => Number(m[0]),
    ),
    x = values.filter((_, i) => i % 2 === 0),
    y = values.filter((_, i) => i % 2 === 1);
  const left = Math.min(...x),
    top = Math.min(...y);
  return {
    x: left,
    y: top,
    width: Math.max(...x) - left,
    height: Math.max(...y) - top,
  };
}
export function searchNodes(doc: MapDocument, query: string) {
  const text = query.trim().toLocaleLowerCase();
  return doc.nodes.filter(
    (n) =>
      !doc.groups.find((g) => g.id === n.group_id)?.collapsed &&
      (!text ||
        `${n.name} ${n.description}`.toLocaleLowerCase().includes(text)),
  );
}
export function visibleSelection(
  doc: MapDocument,
  query: string,
  ids: readonly string[],
  selection: { kind: 'node' | 'group' | 'edge'; id: string } | null,
) {
  const visible = new Set(searchNodes(doc, query).map((n) => n.id));
  const nodeIds = ids.filter((id) => visible.has(id));
  if (!selection) return { nodeIds, selection };
  if (selection.kind === 'node' && !visible.has(selection.id))
    return {
      nodeIds,
      selection: nodeIds.length
        ? { kind: 'node' as const, id: nodeIds.at(-1)! }
        : null,
    };
  if (
    selection.kind === 'group' &&
    (query.trim() || !doc.groups.some((g) => g.id === selection.id))
  )
    return { nodeIds, selection: null };
  if (
    selection.kind === 'edge' &&
    !doc.edges.some(
      (e) =>
        e.id === selection.id && visible.has(e.source) && visible.has(e.target),
    )
  )
    return { nodeIds, selection: null };
  return { nodeIds, selection };
}
export function highlightParts(name: string, query: string) {
  const text = query.trim().toLocaleLowerCase();
  if (!text) return [{ text: name, match: false }];
  const result: { text: string; match: boolean }[] = [];
  const lower = name.toLocaleLowerCase();
  let start = 0;
  for (
    let at = lower.indexOf(text, start);
    at >= 0;
    at = lower.indexOf(text, start)
  ) {
    if (at > start) result.push({ text: name.slice(start, at), match: false });
    result.push({ text: name.slice(at, at + text.length), match: true });
    start = at + text.length;
  }
  if (start < name.length)
    result.push({ text: name.slice(start), match: false });
  return result;
}
// Preserve the original smooth Bézier style, with ports on the actual-sized
// card boundaries. Arbitrary freeform layouts may still cross other cards.
export function connectionPath(a: MapNode, b: MapNode) {
  const aa = nodeBox(a),
    bb = nodeBox(b);
  const overlapX = aa.x < bb.x + bb.width && aa.x + aa.width > bb.x;
  if (overlapX && (aa.y + aa.height <= bb.y || bb.y + bb.height <= aa.y)) {
    const down = bb.y > aa.y,
      x1 = aa.x + aa.width / 2,
      y1 = aa.y + (down ? aa.height : 0),
      x2 = bb.x + bb.width / 2,
      y2 = bb.y + (down ? 0 : bb.height),
      mid = (y1 + y2) / 2;
    return `M ${x1} ${y1} C ${x1} ${mid}, ${x2} ${mid}, ${x2} ${y2}`;
  }
  const right = bb.x > aa.x,
    x1 = aa.x + (right ? aa.width : 0),
    y1 = aa.y + aa.height / 2,
    x2 = bb.x + (right ? 0 : bb.width),
    y2 = bb.y + bb.height / 2,
    bend = Math.max(50, Math.abs(x2 - x1) / 2) * (right ? 1 : -1);
  return `M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`;
}
