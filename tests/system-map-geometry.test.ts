import { randomUUID } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  emptyMap,
  arrangeMap,
  type MapNode,
  type MapDocument,
} from '../lib/system-map/model';
import { nodeSize, validateMapDocument } from '../lib/system-map/schema.mjs';
import {
  alignNodes,
  arrangeBranch,
  connectionPath,
  contentSize,
  highlightParts,
  materializeSizes,
  newNodePoint,
  nodeBox,
  overlaps,
  refitGroups,
  searchNodes,
  snapNodeMove,
  visibleSelection,
} from '../lib/system-map/geometry';
import {
  copyCluster,
  pasteCluster,
  moveNodes,
  nodesInArea,
} from '../lib/system-map/commands';
const node = (x = 0, y = 0, name = 'Node'): MapNode => ({
  id: randomUUID(),
  name,
  x,
  y,
  color: '#28745b',
  description: '',
  url: '',
  group_id: null,
});
const edge = (
  a: MapNode,
  b: MapNode,
  direction: 'forward' | 'none' | 'both' = 'forward',
) => ({
  id: randomUUID(),
  source: a.id,
  target: b.id,
  direction,
  line: 'solid' as const,
});
const map = (nodes: MapNode[]): MapDocument => ({
  ...emptyMap('Geometry'),
  nodes,
});
describe('System Map geometry', () => {
  it('sizes titles, wraps unbroken text, retains explicit dimensions across fonts', () => {
    expect(contentSize('Short').width).toBeLessThan(
      contentSize('A longer title').width,
    );
    const full = contentSize('x'.repeat(120));
    expect(full.width).toBe(380);
    expect(full.height).toBeGreaterThan(64);
    expect(
      contentSize('漢'.repeat(120), (text) => Array.from(text).length * 14)
        .height,
    ).toBeLessThanOrEqual(1024);
    const sized = materializeSizes(
      map([node(0, 0, 'Long '.repeat(20))]),
      (text) => text.length * 9,
    );
    expect(materializeSizes(sized, () => 3000)).toEqual(sized);
    expect(nodeSize(node())).toEqual({ width: 180, height: 64 });
  });
  it('keeps old History valid, expands groups without moving nodes, validates bounds/pins', () => {
    const n = node(20, 60, 'Long '.repeat(20)),
      id = randomUUID();
    n.group_id = id;
    const doc = {
      ...map([n]),
      groups: [
        {
          id,
          name: 'Group',
          color: '#28745b',
          x: 0,
          y: 0,
          width: 220,
          height: 130,
          collapsed: false,
        },
      ],
    };
    validateMapDocument(doc);
    const sized = materializeSizes(doc, (s) => s.length * 8);
    validateMapDocument(sized);
    expect(sized.nodes[0].x).toBe(n.x);
    expect(sized.nodes[0].y).toBe(n.y);
    expect(sized.groups[0].width).toBeGreaterThan(220);
    expect(() =>
      validateMapDocument({
        ...doc,
        nodes: [{ ...n, width: 380, height: 100 }],
      }),
    ).toThrow(/contain/);
    for (const bad of [
      { width: 381 },
      { height: 63 },
      { keep_position: 'yes' },
      { width: NaN },
    ])
      expect(() =>
        validateMapDocument(map([{ ...node(), ...bad } as MapNode])),
      ).toThrow();
  });
  it('does not trap valid legacy maps at group/coordinate limits', () => {
    const n = node(7820, 60, 'W'.repeat(120)),
      id = randomUUID();
    n.group_id = id;
    const doc = {
      ...map([n]),
      groups: [
        {
          id,
          name: 'Max',
          color: '#28745b',
          x: 0,
          y: 0,
          width: 8000,
          height: 130,
          collapsed: false,
        },
      ],
    };
    validateMapDocument(doc);
    const sized = materializeSizes(doc, (s) => s.length * 12);
    validateMapDocument(sized);
    expect(sized.nodes[0]).toEqual(n);
  });
  it('repeated children use the same right column without overlap, nearby uses same left edge', () => {
    const a = { ...node(), width: 300, height: 110 },
      b = { ...node(370), width: 200, height: 100 };
    const doc = { ...map([a, b]), edges: [edge(a, b)] };
    const n = { ...node(), ...contentSize('x'.repeat(120)) },
      point = newNodePoint(doc, n, a);
    expect(point.x).toBe(b.x);
    expect(overlaps(nodeBox({ ...n, ...point }), nodeBox(b))).toBe(false);
    expect(newNodePoint(doc, n, a, true).x).toBe(a.x);
    expect(newNodePoint(doc, n, a, true).y).toBe(134);
    expect(() => newNodePoint(map([node(19990)]), node(), node(19990))).toThrow(
      /coordinate limit/,
    );
  });
  it('preserves contained limit groups and tight-refits relocated whole-map groups', () => {
    const id = randomUUID(),
      n = { ...node(7820, 60), group_id: id, width: 180, height: 64 };
    const doc = {
      ...map([n]),
      groups: [
        {
          id,
          name: 'Limit',
          color: '#28745b',
          x: 0,
          y: 0,
          width: 8000,
          height: 130,
          collapsed: false,
        },
      ],
    };
    expect(refitGroups(doc)).toEqual(doc);
    const a = node(10000, 100),
      b = node(11000, 300);
    validateMapDocument(
      alignNodes({ ...doc, nodes: [n, a, b] }, [a.id, b.id], 'left'),
    );
    const far = {
      ...doc,
      nodes: [{ ...n, x: 10100 }],
      groups: [{ ...doc.groups[0], x: 10000, width: 500 }],
    };
    for (const layout of ['grid', 'circle'] as const) {
      const next = arrangeMap(far, layout);
      validateMapDocument(next);
      expect(next.groups[0].width).toBeLessThan(8000);
    }
  });
  it('arranges only directed reachable branch members with cycle/shared/pin safety', () => {
    const [a, b, c, d, e, f] = [
      node(0),
      node(60, 200),
      node(100, 300),
      node(-400, 400),
      node(900, 200),
      node(1000, 300),
    ];
    c.keep_position = true;
    const doc = {
      ...map([a, b, c, d, e, f]),
      edges: [
        edge(a, b),
        edge(b, c),
        edge(c, a),
        edge(a, e),
        edge(d, e),
        edge(e, f),
      ],
    };
    const next = arrangeBranch(doc, a.id);
    validateMapDocument(next);
    expect(next.nodes.find((n) => n.id === a.id)).toEqual(a);
    expect(next.nodes.find((n) => n.id === b.id)!.x).toBe(250);
    for (const n of [c, d, e, f])
      expect(next.nodes.find((item) => item.id === n.id)).toEqual(n);
    const none = { ...map([a, b]), edges: [edge(a, b, 'both')] };
    expect(arrangeBranch(none, a.id).nodes).toEqual(none.nodes);
  });
  it('pins survive automatic layout/copy/paste but allow manual dragging', () => {
    const fixed = {
      ...node(300, 500),
      width: 320,
      height: 110,
      keep_position: true,
    };
    const doc = map([fixed, node()]);
    for (const layout of ['grid', 'circle'] as const)
      expect(arrangeMap(doc, layout).nodes[0]).toEqual(fixed);
    const copied = pasteCluster(
      emptyMap('Copy'),
      copyCluster(doc, [fixed.id]),
      { x: 10, y: 10 },
    ).document.nodes[0];
    expect(copied).toMatchObject({
      width: 320,
      height: 110,
      keep_position: true,
    });
    expect(moveNodes(doc, [fixed.id], 20, 10).nodes[0].x).toBe(320);
  });
  it('aligns actual-sized selections and distributes nonoverlapping gaps atomically', () => {
    const doc = map([
      { ...node(10, 0), width: 140 },
      { ...node(300, 150), width: 200 },
      { ...node(700, 300), width: 300 },
    ]);
    const ids = doc.nodes.map((n) => n.id),
      aligned = alignNodes(doc, ids, 'left');
    expect(aligned.nodes.map((n) => n.x)).toEqual([10, 10, 10]);
    const next = alignNodes(doc, ids, 'horizontal'),
      [a, b, c] = next.nodes;
    expect(b.x - (a.x + nodeSize(a).width)).toBe(
      c.x - (b.x + nodeSize(b).width),
    );
    expect(() =>
      alignNodes(map([node(0, 0), node(0, 10)]), [], 'left'),
    ).toThrow();
    expect(doc.nodes[1].x).toBe(300);
  });
  it('area selection uses full variable bounds and snapping keeps the cluster shape', () => {
    const a = { ...node(), width: 380, height: 200 },
      b = node(500, 300),
      doc = map([a, b]);
    expect(nodesInArea(doc, { x: 350, y: 150 }, { x: 390, y: 210 })).toContain(
      a.id,
    );
    expect(snapNodeMove(doc, [a.id], 497, 297, 6)).toMatchObject({
      dx: 500,
      dy: 300,
      guideX: 500,
      guideY: 300,
    });
  });
  it('search keeps only visible matches, description matches highlight the border, text safely splits literals', () => {
    const a = node(0, 0, 'Node [a] [a]'),
      b = node(300);
    b.description = '[a] details';
    const c = node(600);
    const doc = map([a, b, c]);
    expect(searchNodes(doc, '[A]').map((n) => n.id)).toEqual([a.id, b.id]);
    expect(highlightParts(a.name, '[a]').filter((p) => p.match)).toHaveLength(
      2,
    );
    expect(
      highlightParts('<script>', 'script')
        .map((p) => p.text)
        .join(''),
    ).toBe('<script>');
    expect(searchNodes(doc, '')).toHaveLength(3);
  });
  it('preserves smooth curves and attaches to actual-sized horizontal/vertical ports', () => {
    const a = { ...node(), width: 300, height: 100 },
      b = { ...node(700, 150), width: 200, height: 120 };
    expect(connectionPath(a, b)).toBe('M 300 50 C 500 50, 500 210, 700 210');
    expect(connectionPath(b, a)).toBe('M 700 210 C 500 210, 500 50, 300 50');
    const below = { ...b, x: 50, y: 300 };
    expect(connectionPath(a, below)).toBe(
      'M 150 100 C 150 200, 150 200, 150 300',
    );
    expect(connectionPath(below, a)).toBe(
      'M 150 300 C 150 200, 150 200, 150 100',
    );
    expect(connectionPath(node(), node(300, 100))).toBe(
      'M 180 32 C 240 32, 240 132, 300 132',
    );
  });
  it('drops hidden selections after rename/collapse/delete without losing visible selected nodes', () => {
    const a = node(0, 0, 'Alpha'),
      b = node(300, 0, 'Alpha sibling'),
      doc = map([a, b]);
    const renamed = { ...doc, nodes: [{ ...a, name: 'Beta' }, b] };
    expect(
      visibleSelection(renamed, 'alpha', [a.id, b.id], {
        kind: 'node',
        id: a.id,
      }),
    ).toEqual({ nodeIds: [b.id], selection: { kind: 'node', id: b.id } });
    expect(
      visibleSelection(renamed, 'alpha', [a.id], { kind: 'node', id: a.id }),
    ).toEqual({ nodeIds: [], selection: null });
    const e = edge(a, b);
    expect(
      visibleSelection({ ...renamed, edges: [e] }, 'alpha', [], {
        kind: 'edge',
        id: e.id,
      }).selection,
    ).toBeNull();
    const group = {
      id: randomUUID(),
      name: 'Group',
      color: '#28745b',
      x: 0,
      y: 0,
      width: 600,
      height: 200,
      collapsed: true,
    };
    expect(
      visibleSelection(
        {
          ...doc,
          groups: [group],
          nodes: doc.nodes.map((n) => ({ ...n, group_id: group.id })),
        },
        '',
        [a.id, b.id],
        { kind: 'node', id: a.id },
      ),
    ).toEqual({ nodeIds: [], selection: null });
  });
});
