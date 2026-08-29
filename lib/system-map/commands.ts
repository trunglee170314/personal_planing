import { containingGroup, type MapDocument } from './model';
import { nodeSize, validateMapDocument } from './schema.mjs';
export type MapCluster = Pick<MapDocument, 'nodes' | 'groups' | 'edges'>;
export function copyCluster(
  doc: MapDocument,
  ids: readonly string[],
  groupId?: string,
): MapCluster {
  const selected = new Set(ids);
  if (groupId)
    doc.nodes
      .filter((n) => n.group_id === groupId)
      .forEach((n) => selected.add(n.id));
  const groups = doc.groups.filter((g) => g.id === groupId);
  return structuredClone({
    groups,
    nodes: doc.nodes
      .filter((n) => selected.has(n.id))
      .map((n) => ({
        ...n,
        group_id: groups.some((g) => g.id === n.group_id) ? n.group_id : null,
      })),
    edges: doc.edges.filter(
      (e) => selected.has(e.source) && selected.has(e.target),
    ),
  });
}
export function pasteCluster(
  doc: MapDocument,
  cluster: MapCluster,
  offset: { x: number; y: number },
  id = () => crypto.randomUUID(),
) {
  const remap = new Map(
    [...cluster.nodes, ...cluster.groups].map((item) => [item.id, id()]),
  );
  const groups = cluster.groups.map((g) => ({
    ...g,
    id: remap.get(g.id)!,
    x: g.x + offset.x,
    y: g.y + offset.y,
  }));
  const nodes = cluster.nodes.map((n) => ({
    ...n,
    id: remap.get(n.id)!,
    group_id: n.group_id ? (remap.get(n.group_id) ?? null) : null,
    x: n.x + offset.x,
    y: n.y + offset.y,
  }));
  const edges = cluster.edges.map((e) => ({
    ...e,
    id: id(),
    source: remap.get(e.source)!,
    target: remap.get(e.target)!,
  }));
  const next = {
    ...doc,
    nodes: [...doc.nodes, ...nodes],
    groups: [...doc.groups, ...groups],
    edges: [...doc.edges, ...edges],
  };
  validateMapDocument(next); // Atomic: do not return a partially pasted or invalid graph.
  return {
    document: next,
    ids: nodes.map((n) => n.id),
    groupId: groups[0]?.id,
  };
}
export function moveNodes(
  doc: MapDocument,
  ids: readonly string[],
  dx: number,
  dy: number,
  preview = false,
): MapDocument {
  const selected = new Set(ids);
  const next = {
    ...doc,
    nodes: doc.nodes.map((n) =>
      selected.has(n.id) ? { ...n, x: n.x + dx, y: n.y + dy } : n,
    ),
  };
  next.nodes = next.nodes.map((n) =>
    selected.has(n.id) ? { ...n, group_id: containingGroup(next, n) } : n,
  );
  if (preview) {
    for (const node of next.nodes)
      if (
        selected.has(node.id) &&
        (Math.abs(node.x) > 20000 || Math.abs(node.y) > 20000)
      )
        throw new Error(
          'Map coordinates must stay between -20,000 and 20,000.',
        );
  } else validateMapDocument(next);
  return next;
}
export function nodesInArea(
  doc: MapDocument,
  a: { x: number; y: number },
  b: { x: number; y: number },
) {
  const left = Math.min(a.x, b.x),
    right = Math.max(a.x, b.x),
    top = Math.min(a.y, b.y),
    bottom = Math.max(a.y, b.y);
  return doc.nodes
    .filter(
      (n) =>
        !doc.groups.find((g) => g.id === n.group_id)?.collapsed &&
        n.x < right &&
        n.x + nodeSize(n).width > left &&
        n.y < bottom &&
        n.y + nodeSize(n).height > top,
    )
    .map((n) => n.id);
}
export function nextSpatialNode(
  doc: MapDocument,
  currentId: string | undefined,
  direction: 'Left' | 'Right' | 'Up' | 'Down',
) {
  const visible = doc.nodes.filter(
    (n) => !doc.groups.find((g) => g.id === n.group_id)?.collapsed,
  );
  const current = visible.find((n) => n.id === currentId);
  if (!current) return visible[0]?.id;
  return visible
    .filter((n) => n.id !== current.id)
    .map((n) => {
      const dx = n.x - current.x,
        dy = n.y - current.y;
      const forward =
        direction === 'Left'
          ? -dx
          : direction === 'Right'
            ? dx
            : direction === 'Up'
              ? -dy
              : dy;
      const side =
        direction === 'Left' || direction === 'Right'
          ? Math.abs(dy)
          : Math.abs(dx);
      return { id: n.id, forward, score: Math.hypot(dx, dy) + side * 2 };
    })
    .filter((n) => n.forward > 0)
    .sort((a, b) => a.score - b.score)[0]?.id;
}
