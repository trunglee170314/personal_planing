'use client';

export const MYPLAN_DATA_CHANGED = 'myplan:data-changed';

export type MyplanDataChangedDetail = {
  source: string;
};

export function announceDataChanged(source: string) {
  window.dispatchEvent(
    new CustomEvent<MyplanDataChangedDetail>(MYPLAN_DATA_CHANGED, {
      detail: { source },
    }),
  );
}

export function dataChangeSource(event: Event) {
  return (event as CustomEvent<MyplanDataChangedDetail>).detail?.source;
}
