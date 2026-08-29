import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  copyCluster,
  pasteCluster,
  moveNodes,
  nodesInArea,
  nextSpatialNode,
} from '../lib/system-map/commands';
import {
  emptyMap,
  type MapDocument,
  type MapNode,
} from '../lib/system-map/model';
import { validateMapDocument, MAP_LIMITS } from '../lib/system-map/schema.mjs';
const node = (x = 100, y = 140): MapNode => ({
  id: randomUUID(),
  name: 'Name',
  description: 'Full description',
  color: '#28745b',
  url: 'https://example.com',
  group_id: null,
  x,
  y,
});
function graph(): MapDocument {
  const nodes = [node(100), node(400), node(700)];
  return {
    ...emptyMap('Source'),
    nodes,
    edges: [
      {
        id: randomUUID(),
        source: nodes[0].id,
        target: nodes[1].id,
        line: 'dashed',
        direction: 'both',
      },
      {
        id: randomUUID(),
        source: nodes[1].id,
        target: nodes[2].id,
        line: 'solid',
        direction: 'forward',
      },
    ],
  };
}
describe('System Map cluster commands', () => {
  it('copies only selected nodes and their internal edges', () => {
    const doc = graph(),
      cluster = copyCluster(
        doc,
        doc.nodes.slice(0, 2).map((n) => n.id),
      );
    expect(cluster.nodes).toHaveLength(2);
    expect(cluster.edges).toHaveLength(1);
    cluster.nodes[0].name = 'Clipboard change';
    expect(doc.nodes[0].name).toBe('Name');
  });
  it('pastes fresh independent IDs with attributes and relative positions intact', () => {
    const doc = graph(),
      cluster = copyCluster(
        doc,
        doc.nodes.slice(0, 2).map((n) => n.id),
      ),
      result = pasteCluster(emptyMap('Destination'), cluster, { x: 40, y: 60 });
    validateMapDocument(result.document);
    expect(result.ids.every((id) => !doc.nodes.some((n) => n.id === id))).toBe(
      true,
    );
    expect(result.document.nodes[0]).toMatchObject({
      name: 'Name',
      description: 'Full description',
      color: '#28745b',
      url: 'https://example.com',
      x: 140,
      y: 200,
    });
    expect(result.document.edges[0]).toMatchObject({
      source: result.ids[0],
      target: result.ids[1],
      line: 'dashed',
      direction: 'both',
    });
    expect(result.document.edges[0].id).not.toBe(cluster.edges[0].id);
  });
  it('detaches partial group membership; whole-group copy includes hidden children', () => {
    const doc = graph(),
      id = randomUUID();
    doc.groups = [
      {
        id,
        name: 'Group',
        color: '#28745b',
        x: 50,
        y: 50,
        width: 1000,
        height: 400,
        collapsed: true,
      },
    ];
    doc.nodes = doc.nodes.map((n) => ({ ...n, group_id: id }));
    expect(copyCluster(doc, [doc.nodes[0].id]).nodes[0].group_id).toBeNull();
    const pasted = pasteCluster(emptyMap('Copy'), copyCluster(doc, [], id), {
      x: 50,
      y: 50,
    });
    expect(pasted.document.nodes).toHaveLength(3);
    expect(pasted.document.groups[0].collapsed).toBe(true);
    expect(
      pasted.document.nodes.every((n) => n.group_id === pasted.groupId),
    ).toBe(true);
    validateMapDocument(pasted.document);
  });
  it('rejects node/byte/coordinate limits atomically without mutating target', () => {
    const doc = {
        ...emptyMap('Limit'),
        nodes: Array.from({ length: MAP_LIMITS.nodes }, () => node()),
      },
      original = structuredClone(doc),
      cluster = { nodes: [node()], groups: [], edges: [] };
    expect(() => pasteCluster(doc, cluster, { x: 0, y: 0 })).toThrow(
      /Too many nodes/,
    );
    expect(doc).toEqual(original);
    expect(() =>
      pasteCluster(emptyMap('Bounds'), cluster, { x: 30000, y: 0 }),
    ).toThrow(/coordinates/);
    const large = {
      nodes: Array.from({ length: MAP_LIMITS.nodes }, () => ({
        ...node(),
        description: 'a'.repeat(4000),
        url: `https://example.com/${'a'.repeat(1000)}`,
      })),
      groups: [],
      edges: [],
    };
    expect(() =>
      pasteCluster(emptyMap('Bytes'), large, { x: 0, y: 0 }),
    ).toThrow(/4 MiB/);
  });
  it('rejects dangling connections and colliding generated IDs atomically', () => {
    const doc = graph(),
      original = structuredClone(doc),
      cluster = copyCluster(
        doc,
        doc.nodes.map((n) => n.id),
      );
    expect(() =>
      pasteCluster(doc, cluster, { x: 10, y: 10 }, () => doc.nodes[0].id),
    ).toThrow(/IDs/);
    cluster.edges[0].source = randomUUID();
    expect(() =>
      pasteCluster(emptyMap('Invalid'), cluster, { x: 0, y: 0 }),
    ).toThrow(/existing nodes/);
    expect(doc).toEqual(original);
  });
  it('moves the complete selection and recomputes group containment', () => {
    const doc = graph(),
      id = randomUUID();
    doc.groups = [
      {
        id,
        name: 'Group',
        color: '#28745b',
        x: 50,
        y: 50,
        width: 550,
        height: 400,
        collapsed: false,
      },
    ];
    doc.nodes[0].group_id = id;
    doc.nodes[1].group_id = id;
    const moved = moveNodes(
      doc,
      doc.nodes.slice(0, 2).map((n) => n.id),
      600,
      10,
    );
    expect(moved.nodes[0].x).toBe(700);
    expect(moved.nodes[1].x).toBe(1000);
    expect(moved.nodes[2]).toEqual(doc.nodes[2]);
    expect(moved.nodes[0].group_id).toBeNull();
    validateMapDocument(moved);
  });
  it('selects intersecting visible nodes for reverse area drags', () => {
    const doc = graph();
    expect(
      nodesInArea(doc, { x: 600, y: 300 }, { x: 90, y: 130 }).sort(),
    ).toEqual(
      doc.nodes
        .slice(0, 2)
        .map((n) => n.id)
        .sort(),
    );
  });
  it('navigates spatially and handles missing selection', () => {
    const doc = graph();
    expect(nextSpatialNode(doc, doc.nodes[0].id, 'Right')).toBe(
      doc.nodes[1].id,
    );
    expect(nextSpatialNode(doc, doc.nodes[0].id, 'Left')).toBeUndefined();
    expect(nextSpatialNode(doc, undefined, 'Down')).toBe(doc.nodes[0].id);
  });
});
