import { describe, expect, it } from 'vitest';
import {
  parseDelimited,
  parseWorkbook,
  templateSheets,
  validateBulkRelationships,
} from '../lib/bulk-import';
import { readXlsx, writeXlsx } from '../lib/xlsx-lite';

describe('bulk import', () => {
  it('creates a readable multi-sheet Excel template', () => {
    const bytes = writeXlsx(templateSheets);
    const workbook = readXlsx(
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
    );
    expect(workbook.map((sheet) => sheet.name)).toEqual([
      'Instructions',
      'Goals',
      'Tasks',
      'Checklists',
      'Reminders',
      'Milestones',
      'Links & Comments',
    ]);
    expect(workbook.find((sheet) => sheet.name === 'Checklists')?.rows[0]).toContain(
      'Start time',
    );
  });

  it('normalizes hierarchy, calendar details and annotations', () => {
    const parsed = parseWorkbook([
      { name: 'Goals', rows: [['Key', 'Title', 'Start date', 'End date', 'Color'], ['g1', 'Health', '01/09/2026', '2026-12-31', 'teal']] },
      { name: 'Tasks', rows: [['Key', 'Goal key', 'Title', 'Priority', 'Status', 'Deadline'], ['t1', 'g1', 'Exercise', 'high', 'planned', '30/09/2026']] },
      { name: 'Checklists', rows: [['Key', 'Goal key', 'Task key', 'Title', 'Date', 'Start time', 'End time', 'Recurrence', 'Repeat every', 'Repeat until', 'Notify minutes'], ['c1', 'g1', 't1', 'Run', '2026-09-07', '06:30', '07:15', 'weekly', '1', '2026-12-31', '0|15']] },
      { name: 'Reminders', rows: [['Key', 'Title', 'Date', 'Start time', 'End time', 'State'], ['r1', 'Drink water', '2026-09-07', '08:00', '08:05', 'open']] },
      { name: 'Milestones', rows: [['Key', 'Task key', 'Title', 'Date'], ['m1', 't1', 'First 5K', '2026-10-01']] },
      { name: 'Links & Comments', rows: [['Target type', 'Target key', 'Kind', 'Body', 'URL'], ['calendar', 'c1', 'comment', 'Bring water', ''], ['task', 't1', 'link', 'Training plan', 'https://example.com']] },
    ]);
    expect(parsed.issues).toEqual([]);
    expect(parsed.plan.goals[0]).toMatchObject({ key: 'g1', starts_on: '2026-09-01' });
    expect(parsed.plan.tasks[0]).toMatchObject({ goal_key: 'g1', due_at: '2026-09-30' });
    expect(parsed.plan.calendar[0]).toMatchObject({
      item_type: 'checklist',
      task_key: 't1',
      recurrence: 'weekly',
      notification_offsets: [0, 15],
    });
    expect(parsed.plan.calendar[0].starts_at).toBe('2026-09-06T23:30:00.000Z');
    expect(parsed.plan.annotations).toHaveLength(2);
  });

  it('parses quoted CSV and reports invalid rows before import', () => {
    const sheet = parseDelimited(
      'Type,Key,Title,Date,Start time,End time,Task key\nChecklist,c1,"Review, carefully",2026-09-08,09:00,09:30,',
    );
    const parsed = parseWorkbook([sheet]);
    expect(parsed.plan.calendar).toEqual([]);
    expect(parsed.issues[0].message).toContain('Task key');
  });

  it('reports missing relations during preview before saving', () => {
    const parsed = parseWorkbook([
      {
        name: 'Checklists',
        rows: [
          ['Key', 'Task key', 'Title', 'Date', 'Start time', 'End time'],
          ['c1', 'missing-task', 'Review', '2026-09-08', '09:00', '09:30'],
        ],
      },
    ]);
    const issues = validateBulkRelationships(
      parsed,
      { goals: [], tasks: [], links: [], milestones: [] },
      { sessions: [] },
    );
    expect(issues).toEqual([
      expect.objectContaining({
        sheet: 'Checklists',
        message: expect.stringContaining('missing-task'),
      }),
    ]);
  });

  it('accepts relations to items included in the same workbook', () => {
    const parsed = parseWorkbook([
      { name: 'Goals', rows: [['Key', 'Title'], ['g1', 'Work']] },
      { name: 'Tasks', rows: [['Key', 'Goal key', 'Title'], ['t1', 'g1', 'Review']] },
      { name: 'Checklists', rows: [['Key', 'Goal key', 'Task key', 'Title', 'Date'], ['c1', 'g1', 't1', 'Send', '2026-09-08']] },
      { name: 'Links & Comments', rows: [['Target type', 'Target key', 'Kind', 'Body'], ['calendar', 'c1', 'comment', 'Check details']] },
    ]);
    expect(
      validateBulkRelationships(
        parsed,
        { goals: [], tasks: [], links: [], milestones: [] },
        { sessions: [] },
      ),
    ).toEqual([]);
  });
});
