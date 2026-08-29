'use client';
import { useState } from 'react';
import { matchesSearch } from '@/lib/workspace-view';
export function useWorkspaceList<T extends { id: string }>(
  items: T[],
  key: string,
  group: (item: T) => string,
  text: (item: T) => string,
  date: (item: T) => string,
  initialQuery = '',
) {
  const [query, setQuery] = useState(initialQuery);
  const [sort, setSort] = useState(() =>
    typeof window === 'undefined'
      ? 'group'
      : window.localStorage.getItem(`myplan-sort:${key}`) || 'group',
  );
  const [revision, setRevision] = useState(0);
  const [order, setOrder] = useState<{ key: string; ids: string[] }>({
    key: '',
    ids: [],
  });
  const next = [...items].sort((a, b) => {
    const aKey =
      sort === 'title' ? text(a) : sort === 'date' ? date(a) : group(a);
    const bKey =
      sort === 'title' ? text(b) : sort === 'date' ? date(b) : group(b);
    return aKey.localeCompare(bKey) || a.id.localeCompare(b.id);
  });
  const orderKey = `${key}:${sort}:${revision}`;
  const ids = new Set(order.ids);
  const live = new Set(items.map((item) => item.id));
  const orderedIds =
    order.key !== orderKey
      ? next.map((item) => item.id)
      : [
          ...order.ids.filter((id) => live.has(id)),
          ...next.filter((item) => !ids.has(item.id)).map((item) => item.id),
        ];
  if (
    order.key !== orderKey ||
    orderedIds.length !== order.ids.length ||
    orderedIds.some((id, index) => id !== order.ids[index])
  )
    setOrder({ key: orderKey, ids: orderedIds });
  const byId = new Map(items.map((item) => [item.id, item]));
  const visible = orderedIds.flatMap((id) => {
    const item = byId.get(id);
    return item && matchesSearch(query, text(item), group(item)) ? [item] : [];
  });
  return {
    visible,
    query,
    setQuery,
    sort,
    chooseSort: (value: string) => {
      setSort(value);
      window.localStorage.setItem(`myplan-sort:${key}`, value);
    },
    resort: () => setRevision((value) => value + 1),
  };
}
export function WorkspaceListTools({
  query,
  setQuery,
  sort,
  chooseSort,
  resort,
  groupLabel = 'Group',
}: {
  query: string;
  setQuery: (value: string) => void;
  sort: string;
  chooseSort: (value: string) => void;
  resort: () => void;
  groupLabel?: string;
}) {
  return (
    <div className="my-4 flex flex-wrap gap-2">
      <input
        type="search"
        aria-label="Search this section"
        placeholder="Search title, task or goal…"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        className="min-w-60 flex-1 rounded-lg border bg-background px-3 py-2 text-sm"
      />
      <select
        aria-label="Sort items"
        value={sort}
        onChange={(event) => chooseSort(event.target.value)}
        className="rounded-lg border bg-background px-3 text-sm"
      >
        <option value="group">{groupLabel}</option>
        <option value="title">Title</option>
        <option value="date">Date</option>
      </select>
      <button
        type="button"
        onClick={resort}
        className="rounded-lg border px-3 py-2 text-sm"
        title="Reapply sorting; edits otherwise keep their position"
      >
        Re-sort
      </button>
    </div>
  );
}
