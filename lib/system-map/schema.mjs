export const MAP_LIMITS = {
  nodes: 200,
  groups: 40,
  edges: 600,
  bytes: 262144,
  maps: 50,
  history: 50,
};
export const NODE_WIDTH = 180;
export const NODE_HEIGHT = 64;
export const GROUP_HEADER = 44;
// Match PostgreSQL jsonb::text spacing and numeric notation. This keeps the
// server and browser/SQLite byte limit identical, including Unicode text.
export function mapDocumentBytes(input) {
  const serialized = JSON.stringify(input).replace(
    /"(?:\\.|[^"\\])*"|[:,]|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi,
    (token) => {
      if (token === ':' || token === ',') return token + ' ';
      if (token[0] === '"' || !/[eE]/.test(token)) return token;
      const negative = token[0] === '-',
        [mantissa, exponent] = token.replace(/^-/, '').toLowerCase().split('e');
      const point =
          (mantissa.indexOf('.') < 0
            ? mantissa.length
            : mantissa.indexOf('.')) + Number(exponent),
        digits = mantissa.replace('.', '');
      return (
        (negative ? '-' : '') +
        (point <= 0
          ? '0.' + '0'.repeat(-point) + digits
          : point >= digits.length
            ? digits + '0'.repeat(point - digits.length)
            : digits.slice(0, point) + '.' + digits.slice(point))
      );
    },
  );
  return new TextEncoder().encode(serialized).length;
}
const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
function fail(message) {
  throw new Error(message);
}
function text(value, label, maximum, required = false) {
  if (
    typeof value !== 'string' ||
    value.length > maximum ||
    (required && !value.trim())
  )
    fail(`${label} is invalid.`);
  return value;
}
function coordinate(value) {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    Math.abs(value) > 20000
  )
    fail('Map coordinates must stay between -20,000 and 20,000.');
}
function identity(value, seen) {
  if (typeof value !== 'string' || !uuid.test(value) || seen.has(value))
    fail('Map IDs must be unique UUIDs.');
  seen.add(value);
}
export function validateMapDocument(input) {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    input.schema !== 1
  )
    fail('Unsupported map document.');
  text(input.name, 'Map name', 120, true);
  text(input.description, 'Map description', 4000);
  for (const key of ['nodes', 'groups', 'edges'])
    if (!Array.isArray(input[key]) || input[key].length > MAP_LIMITS[key])
      fail(`Too many ${key} in this map.`);
  const seen = new Set(),
    groups = new Map(),
    nodes = new Set(),
    pairs = new Set();
  for (const group of input.groups) {
    if (!group || typeof group !== 'object') fail('Invalid group.');
    identity(group.id, seen);
    text(group.name, 'Group name', 120, true);
    if (
      !/^#[0-9a-f]{6}$/i.test(group.color) ||
      typeof group.collapsed !== 'boolean'
    )
      fail('Invalid group appearance.');
    coordinate(group.x);
    coordinate(group.y);
    coordinate(group.width);
    coordinate(group.height);
    if (
      group.width < 220 ||
      group.height < 130 ||
      group.width > 8000 ||
      group.height > 8000
    )
      fail('Group dimensions are invalid.');
    groups.set(group.id, group);
  }
  for (const node of input.nodes) {
    if (!node || typeof node !== 'object') fail('Invalid node.');
    identity(node.id, seen);
    nodes.add(node.id);
    text(node.name, 'Node name', 120, true);
    text(node.description, 'Node description', 4000);
    if (!/^#[0-9a-f]{6}$/i.test(node.color)) fail('Invalid node color.');
    coordinate(node.x);
    coordinate(node.y);
    text(node.url, 'External URL', 2000);
    if (node.url) {
      let url;
      try {
        url = new URL(node.url);
      } catch {
        fail('Use a valid http:// or https:// URL.');
      }
      if (!['http:', 'https:'].includes(url.protocol))
        fail('Use an http:// or https:// URL.');
    }
    if (node.group_id !== null) {
      const group = groups.get(node.group_id);
      if (!group) fail('Node group does not exist.');
      if (
        node.x < group.x ||
        node.y < group.y + GROUP_HEADER ||
        node.x + NODE_WIDTH > group.x + group.width ||
        node.y + NODE_HEIGHT > group.y + group.height
      )
        fail('A group must contain all its nodes.');
    }
  }
  for (const edge of input.edges) {
    if (!edge || typeof edge !== 'object') fail('Invalid connection.');
    identity(edge.id, seen);
    if (
      !nodes.has(edge.source) ||
      !nodes.has(edge.target) ||
      edge.source === edge.target
    )
      fail('A connection needs two different existing nodes.');
    if (
      !['none', 'forward', 'both'].includes(edge.direction) ||
      !['solid', 'dashed'].includes(edge.line)
    )
      fail('Invalid connection style.');
    const pair = [edge.source, edge.target]
      .sort((a, b) => a.localeCompare(b))
      .join(':');
    if (pairs.has(pair)) fail('These nodes are already connected.');
    pairs.add(pair);
  }
  if (mapDocumentBytes(input) > MAP_LIMITS.bytes)
    fail('Map is too large (maximum 256 KiB).');
  return input;
}
