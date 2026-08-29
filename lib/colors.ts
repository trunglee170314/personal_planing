import type { GoalColor } from '@/lib/data/repository';

export const goalColors: { id: GoalColor; name: string; value: string }[] = [
  { id: 'jade', name: 'Jade', value: '#5F8A72' },
  { id: 'teal', name: 'Teal', value: '#4F8C88' },
  { id: 'sky', name: 'Sky', value: '#5E91B8' },
  { id: 'sapphire', name: 'Sapphire', value: '#5478B7' },
  { id: 'indigo', name: 'Indigo', value: '#696FB0' },
  { id: 'plum', name: 'Plum', value: '#8A6BA6' },
  { id: 'amber', name: 'Amber', value: '#B88945' },
  { id: 'terracotta', name: 'Terracotta', value: '#B66F52' },
  { id: 'rose', name: 'Rose', value: '#B85583' },
  { id: 'coral', name: 'Coral', value: '#C65D48' },
  { id: 'lime', name: 'Lime', value: '#75852F' },
  { id: 'slate', name: 'Slate', value: '#60738B' },
];

// Milestones deliberately use a smaller, high-contrast palette. `null` means
// inherit from the Goal/Task so existing milestones never snapshot a color.
export const milestoneColors = goalColors.slice(0, 8);

export const reminderColor = '#D85C5C';
export const neutralChecklistColor = '#64748B';

export function goalColorValue(id?: GoalColor | null) {
  return (
    goalColors.find((color) => color.id === id)?.value ?? goalColors[0].value
  );
}

export function milestoneColorValue(
  id: GoalColor | null | undefined,
  inherited: string,
) {
  return id ? goalColorValue(id) : inherited;
}
