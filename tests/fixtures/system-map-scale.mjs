import { randomUUID } from 'node:crypto';

// Synthetic, non-personal data. Never import this into the application bundle.
export function scaleMap(
  count,
  descriptionLength = 240,
  topology = 'clusters',
) {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: randomUUID(),
    name: `Topic ${String(i + 1).padStart(4, '0')} — Decision and next action`,
    description: 'Context, alternatives, evidence and next steps. '
      .repeat(Math.ceil(descriptionLength / 47))
      .slice(0, descriptionLength),
    url: '',
    color: '#28745b',
    group_id: null,
    x: (i % 40) * 390,
    y: Math.floor(i / 40) * 120,
    width: 320,
    height: 70,
  }));
  const edges = nodes.flatMap((n, i) => {
    if (!i || (topology === 'clusters' && i % 50 === 0)) return [];
    const source =
      topology === 'star'
        ? 0
        : topology === 'tree'
          ? Math.floor((i - 1) / 3)
          : i - 1;
    return [
      {
        id: randomUUID(),
        source: nodes[source].id,
        target: n.id,
        direction: 'forward',
        line: 'solid',
      },
    ];
  });
  return {
    schema: 1,
    name: `Benchmark ${count} nodes`,
    description: 'Synthetic scale benchmark only.',
    nodes,
    groups: [],
    edges,
  };
}
