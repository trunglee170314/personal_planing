'use client';

import { useMemo, useRef, useState } from 'react';
import { Download, FileSpreadsheet, LoaderCircle, Upload } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import {
  parseDelimited,
  parseWorkbook,
  templateSheets,
  validateBulkRelationships,
  type BulkConflictMode,
  type BulkImportResult,
  type ParsedBulkImport,
} from '@/lib/bulk-import';
import { readXlsx, writeXlsx } from '@/lib/xlsx-lite';
import { announceDataChanged } from '@/lib/data/data-events';
import { getErrorMessage, getPlanningRepository } from '@/lib/data/repository';

const total = (values: Record<string, number>) =>
  Object.values(values).reduce((sum, value) => sum + value, 0);

export function BulkImportPanel() {
  const repository = getPlanningRepository();
  const inputRef = useRef<HTMLInputElement>(null);
  const [parsed, setParsed] = useState<ParsedBulkImport | null>(null);
  const [paste, setPaste] = useState('');
  const [sourceName, setSourceName] = useState('');
  const [mode, setMode] = useState<BulkConflictMode>('skip');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<BulkImportResult | null>(null);
  const counts = useMemo(
    () =>
      parsed
        ? {
            Goals: parsed.plan.goals.length,
            Tasks: parsed.plan.tasks.length,
            Checklists: parsed.plan.calendar.filter(
              (item) => item.item_type === 'checklist',
            ).length,
            Reminders: parsed.plan.calendar.filter(
              (item) => item.item_type === 'reminder',
            ).length,
            Milestones: parsed.plan.milestones.length,
            'Links & comments': parsed.plan.annotations.length,
          }
        : null,
    [parsed],
  );
  const preview = useMemo(() => {
    if (!parsed) return [];
    return [
      ...parsed.plan.goals.map((item) => ({ type: 'Goal', key: item.key, title: item.title, when: item.ends_on ?? '' })),
      ...parsed.plan.tasks.map((item) => ({ type: 'Task', key: item.key, title: item.title, when: item.due_at ?? '' })),
      ...parsed.plan.calendar.map((item) => ({ type: item.item_type === 'checklist' ? 'Checklist' : 'Reminder', key: item.key, title: item.title, when: new Date(item.starts_at).toLocaleString('en-GB', { timeZone: 'Asia/Ho_Chi_Minh' }) })),
      ...parsed.plan.milestones.map((item) => ({ type: 'Milestone', key: item.key, title: item.title, when: item.milestone_on })),
    ].slice(0, 80);
  }, [parsed]);

  async function acceptParsed(next: ParsedBulkImport, name: string) {
    const issues = [...next.issues];
    if (next.sourceRows > 300)
      issues.push({ sheet: 'Workbook', row: 0, message: 'Import at most 300 rows at a time so the whole batch remains undoable.' });
    if (JSON.stringify(next.plan).length > 400_000)
      issues.push({ sheet: 'Workbook', row: 0, message: 'This import is too large. Split it into smaller files.' });
    if (!issues.length && repository) {
      const [timeline, calendar] = await Promise.all([
        repository.getTimelineWorkspace(),
        repository.getCalendarWorkspace(),
      ]);
      issues.push(...validateBulkRelationships(next, timeline, calendar));
    }
    setParsed({ ...next, issues });
    setSourceName(name);
    setError('');
    setResult(null);
  }

  async function readFile(file: File) {
    setBusy(true);
    setError('');
    try {
      const lower = file.name.toLowerCase();
      const sheets = lower.endsWith('.xlsx')
        ? readXlsx(await file.arrayBuffer())
        : [parseDelimited(await file.text())];
      await acceptParsed(parseWorkbook(sheets), file.name);
    } catch (cause) {
      setParsed(null);
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  function downloadTemplate() {
    const bytes = writeXlsx(templateSheets);
    const content = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    ) as ArrayBuffer;
    const blob = new Blob([content], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'myplan-bulk-import-template.xlsx';
    link.click();
    URL.revokeObjectURL(url);
  }

  async function applyImport() {
    if (!repository || !parsed || parsed.issues.length) return;
    setBusy(true);
    setError('');
    try {
      const next = await repository.bulkImport(parsed.plan, mode);
      setResult(next);
      announceDataChanged('bulk-import');
    } catch (cause) {
      setError(getErrorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="mx-auto w-full max-w-[1500px] space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-bold uppercase tracking-[.14em] text-primary">Data tools</p>
          <h1 className="mt-2 text-4xl font-bold tracking-[-.045em] sm:text-5xl">Bulk import</h1>
          <p className="mt-3 max-w-3xl text-sm text-muted-foreground sm:text-base">
            Import Goals, Tasks, Checklists, Reminders, Milestones, links and comments in one undoable batch.
          </p>
        </div>
        <Button variant="outline" onClick={downloadTemplate}>
          <Download /> Download Excel template
        </Button>
      </div>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.4fr)]">
        <div className="space-y-6">
          <Card>
            <CardHeader><CardTitle>1. Choose data</CardTitle></CardHeader>
            <CardContent className="space-y-4">
              <input
                ref={inputRef}
                type="file"
                className="hidden"
                accept=".xlsx,.csv,.tsv,text/csv,text/tab-separated-values"
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void readFile(file);
                  event.target.value = '';
                }}
              />
              <Button className="w-full" onClick={() => inputRef.current?.click()} disabled={busy}>
                {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
                Upload XLSX, CSV or TSV
              </Button>
              <div className="flex items-center gap-3 text-xs text-muted-foreground before:h-px before:flex-1 before:bg-border after:h-px after:flex-1 after:bg-border">or paste a table</div>
              <Textarea
                value={paste}
                onChange={(event) => setPaste(event.target.value)}
                placeholder={'Type\tKey\tTitle\t...\nGoal\twork\tWork goals\t...'}
                className="min-h-40 font-mono text-xs"
              />
              <Button
                variant="outline"
                className="w-full"
                disabled={!paste.trim() || busy}
                onClick={() => {
                  setBusy(true);
                  void acceptParsed(parseWorkbook([parseDelimited(paste)]), 'Pasted table')
                    .catch((cause) => setError(getErrorMessage(cause)))
                    .finally(() => setBusy(false));
                }}
              >
                <FileSpreadsheet /> Preview pasted data
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader><CardTitle>2. Duplicate handling</CardTitle></CardHeader>
            <CardContent>
              <label className="text-sm font-medium" htmlFor="bulk-conflict-mode">When a matching item already exists</label>
              <select
                id="bulk-conflict-mode"
                value={mode}
                onChange={(event) => setMode(event.target.value as BulkConflictMode)}
                className="mt-2 h-11 w-full rounded-xl border bg-background px-3 text-sm"
              >
                <option value="skip">Skip it and reuse it for relations</option>
                <option value="update">Update it with imported values</option>
                <option value="create">Create another item</option>
              </select>
              <p className="mt-3 text-xs leading-5 text-muted-foreground">
                Matching uses title within its Goal; calendar items also include type, start time and Task.
              </p>
            </CardContent>
          </Card>
        </div>

        <Card className="min-w-0">
          <CardHeader>
            <CardTitle>3. Review and import</CardTitle>
            {sourceName ? <p className="break-all text-xs text-muted-foreground">{sourceName}</p> : null}
          </CardHeader>
          <CardContent className="space-y-5">
            {!parsed ? (
              <div className="grid min-h-72 place-items-center rounded-2xl border border-dashed p-8 text-center text-sm text-muted-foreground">
                Upload the template or paste a table to preview every row before saving.
              </div>
            ) : (
              <>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                  {Object.entries(counts ?? {}).map(([label, value]) => (
                    <div key={label} className="rounded-xl border bg-muted/30 p-3">
                      <strong className="block text-xl">{value}</strong>
                      <span className="text-xs text-muted-foreground">{label}</span>
                    </div>
                  ))}
                </div>
                {parsed.issues.length ? (
                  <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4" role="alert">
                    <p className="font-semibold text-destructive">Fix {parsed.issues.length} issue{parsed.issues.length === 1 ? '' : 's'} before importing</p>
                    <ul className="mt-2 max-h-48 space-y-1 overflow-auto text-sm">
                      {parsed.issues.map((issue, index) => (
                        <li key={`${issue.sheet}:${issue.row}:${index}`}>
                          {issue.sheet}{issue.row ? `, row ${issue.row}` : ''}: {issue.message}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : (
                  <div className="overflow-auto rounded-xl border">
                    <table className="w-full min-w-[620px] text-left text-sm">
                      <thead className="sticky top-0 bg-muted"><tr><th className="p-3">Type</th><th className="p-3">Key</th><th className="p-3">Title</th><th className="p-3">Date / time</th></tr></thead>
                      <tbody>
                        {preview.map((item, index) => (
                          <tr key={`${item.type}:${item.key}:${index}`} className="border-t">
                            <td className="p-3 text-xs font-semibold">{item.type}</td>
                            <td className="p-3 font-mono text-xs">{item.key}</td>
                            <td className="p-3">{item.title}</td>
                            <td className="p-3 text-xs text-muted-foreground">{item.when}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    {preview.length < parsed.sourceRows ? <p className="border-t p-3 text-xs text-muted-foreground">Showing the first {preview.length} items.</p> : null}
                  </div>
                )}
                <Button className="w-full" size="lg" disabled={busy || Boolean(parsed.issues.length)} onClick={() => void applyImport()}>
                  {busy ? <LoaderCircle className="animate-spin" /> : <Upload />}
                  Import {counts ? total(counts) : 0} items
                </Button>
              </>
            )}
            {error ? <p className="rounded-xl border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
            {result ? (
              <output className="block rounded-xl border border-primary/30 bg-primary/5 p-4">
                <strong>Import complete.</strong>{' '}
                {total(result.created)} created, {total(result.updated)} updated, {result.skipped} skipped. Press Ctrl+Z to undo this batch.
              </output>
            ) : null}
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
