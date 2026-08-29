import { nodeSize, GROUP_HEADER } from './schema.mjs';
import { findOpenPoint, refitGroups, NodeObstacles } from './geometry';
export type MapNode = {
  id: string;
  name: string;
  description: string;
  color: string;
  url: string;
  group_id: string | null;
  x: number;
  y: number;
  width?: number;
  height?: number;
  keep_position?: boolean;
};
export type MapGroup = {
  id: string;
  name: string;
  color: string;
  x: number;
  y: number;
  width: number;
  height: number;
  collapsed: boolean;
};
export type MapEdge = {
  id: string;
  source: string;
  target: string;
  line: 'solid' | 'dashed';
  direction: 'none' | 'forward' | 'both';
};
export type MapDocument = {
  schema: 1;
  name: string;
  description: string;
  nodes: MapNode[];
  groups: MapGroup[];
  edges: MapEdge[];
};
export type SystemMap = {
  id: string;
  document: MapDocument;
  version: number;
  name: string;
  updated_at: string;
  deleted_at: string | null;
};
export type MapSummary = Omit<SystemMap, 'document'>;
export type MapRevision = {
  version: number;
  action: string;
  created_at: string;
  changed_by: string;
};
export type MapCommand = {
  action:
    | 'create'
    | 'save'
    | 'trash'
    | 'restore'
    | 'restore_revision'
    | 'purge';
  id: string;
  expected_version: number;
  document?: MapDocument;
  label?: string;
  revision?: number;
};
export const mapColors = [
  '#28745b',
  '#5b82a9',
  '#b98449',
  '#9470ab',
  '#b76e79',
  '#697b78',
];
export const emptyMap = (name: string): MapDocument => ({
  schema: 1,
  name,
  description: '',
  nodes: [],
  groups: [],
  edges: [],
});
export function removeNode(doc: MapDocument, id: string): MapDocument {
  return {
    ...doc,
    nodes: doc.nodes.filter((n) => n.id !== id),
    edges: doc.edges.filter((e) => e.source !== id && e.target !== id),
  };
}
export function removeGroup(doc: MapDocument, id: string): MapDocument {
  return {
    ...doc,
    groups: doc.groups.filter((g) => g.id !== id),
    nodes: doc.nodes.map((n) =>
      n.group_id === id ? { ...n, group_id: null } : n,
    ),
  };
}
export function containingGroup(
  doc: MapDocument,
  node: Pick<MapNode, 'x' | 'y' | 'width' | 'height'>,
) {
  return (
    [...doc.groups]
      .reverse()
      .find(
        (g) =>
          !g.collapsed &&
          node.x >= g.x &&
          node.y >= g.y + GROUP_HEADER &&
          node.x + nodeSize(node).width <= g.x + g.width &&
          node.y + nodeSize(node).height <= g.y + g.height,
      )?.id ?? null
  );
}
export function moveGroup(
  doc: MapDocument,
  id: string,
  dx: number,
  dy: number,
): MapDocument {
  return {
    ...doc,
    groups: doc.groups.map((g) =>
      g.id === id ? { ...g, x: g.x + dx, y: g.y + dy } : g,
    ),
    nodes: doc.nodes.map((n) =>
      n.group_id === id ? { ...n, x: n.x + dx, y: n.y + dy } : n,
    ),
  };
}
export function resizeGroup(
  doc: MapDocument,
  id: string,
  rect: Pick<MapGroup, 'x' | 'y' | 'width' | 'height'>,
): MapDocument {
  const children = doc.nodes.filter((n) => n.group_id === id);
  let x = rect.x,
    y = rect.y,
    right = rect.x + Math.max(220, rect.width),
    bottom = rect.y + Math.max(130, rect.height);
  for (const n of children) {
    x = Math.min(x, n.x);
    y = Math.min(y, n.y - GROUP_HEADER);
    right = Math.max(right, n.x + nodeSize(n).width);
    bottom = Math.max(bottom, n.y + nodeSize(n).height);
  }
  return {
    ...doc,
    groups: doc.groups.map((g) =>
      g.id === id ? { ...g, x, y, width: right - x, height: bottom - y } : g,
    ),
  };
}
export function arrangeMap(
  doc: MapDocument,
  layout: 'grid' | 'circle',
): MapDocument {
  const placed = new NodeObstacles(doc.nodes.filter((n) => n.keep_position));
  const cellWidth =
    Math.max(180, ...doc.nodes.map((n) => nodeSize(n).width)) + 70;
  const cellHeight =
    Math.max(64, ...doc.nodes.map((n) => nodeSize(n).height)) + 50;
  const columns = Math.max(
    4,
    Math.min(
      Math.ceil(Math.sqrt(doc.nodes.length)),
      doc.groups.length ? Math.floor(7800 / cellWidth) : 1000,
    ),
  );
  const nodes = doc.nodes.map((n, i) => {
    if (n.keep_position) return n;
    const angle = (i * 2 * Math.PI) / Math.max(1, doc.nodes.length),
      radius = Math.max(220, Math.min(3000, doc.nodes.length * 40));
    const preferred = {
      x:
        layout === 'grid'
          ? 60 + (i % columns) * cellWidth
          : 500 + Math.cos(angle) * radius,
      y:
        layout === 'grid'
          ? 100 + Math.floor(i / columns) * cellHeight
          : 500 + Math.sin(angle) * radius,
    };
    const node = {
      ...n,
      ...findOpenPoint(n, preferred, placed),
    };
    placed.add(node);
    return node;
  });
  return refitGroups({ ...doc, nodes }, true);
}
