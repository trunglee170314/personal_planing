import { NODE_WIDTH, NODE_HEIGHT, GROUP_HEADER } from './schema.mjs';
export type MapNode = {
  id: string;
  name: string;
  description: string;
  color: string;
  url: string;
  group_id: string | null;
  x: number;
  y: number;
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
  node: Pick<MapNode, 'x' | 'y'>,
) {
  return (
    [...doc.groups]
      .reverse()
      .find(
        (g) =>
          !g.collapsed &&
          node.x >= g.x &&
          node.y >= g.y + GROUP_HEADER &&
          node.x + NODE_WIDTH <= g.x + g.width &&
          node.y + NODE_HEIGHT <= g.y + g.height,
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
    right = Math.max(right, n.x + NODE_WIDTH);
    bottom = Math.max(bottom, n.y + NODE_HEIGHT);
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
  const nodes = doc.nodes.map((n, i) => {
    const angle = (i * 2 * Math.PI) / Math.max(1, doc.nodes.length),
      radius = Math.max(220, Math.min(3000, doc.nodes.length * 40));
    return {
      ...n,
      x:
        layout === 'grid' ? 60 + (i % 4) * 250 : 500 + Math.cos(angle) * radius,
      y:
        layout === 'grid'
          ? 100 + Math.floor(i / 4) * 150
          : 500 + Math.sin(angle) * radius,
    };
  });
  const groups = doc.groups.map((g) => {
    const children = nodes.filter((n) => n.group_id === g.id);
    if (!children.length) return g;
    const x = Math.min(...children.map((n) => n.x)) - 20,
      y = Math.min(...children.map((n) => n.y)) - 64;
    return {
      ...g,
      x,
      y,
      width: Math.max(
        220,
        Math.max(...children.map((n) => n.x)) + NODE_WIDTH + 20 - x,
      ),
      height: Math.max(
        130,
        Math.max(...children.map((n) => n.y)) + NODE_HEIGHT + 20 - y,
      ),
    };
  });
  return { ...doc, nodes, groups };
}
