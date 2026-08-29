'use client';

import { useState } from 'react';
import { MAX_SELECTED_DATES } from '@/lib/selected-dates.mjs';

export function SelectedDates({
  value,
  onChange,
  initialDate,
}: {
  value: string[];
  onChange: (dates: string[]) => void;
  initialDate: string;
}) {
  const [day, setDay] = useState(initialDate);
  return (
    <fieldset className="space-y-2 sm:col-span-2">
      <legend className="text-xs font-semibold">
        Selected dates ({value.length})
      </legend>
      <div className="flex gap-2">
        <input
          aria-label="Date to add"
          type="date"
          min="2000-01-01"
          max="2200-12-31"
          value={day}
          onChange={(event) => setDay(event.target.value)}
          className="h-10 rounded-lg border bg-background px-3"
        />
        <button
          type="button"
          disabled={!day || value.length >= MAX_SELECTED_DATES}
          onClick={() => onChange([...new Set([...value, day])].sort())}
          className="rounded-lg border px-3 text-sm disabled:opacity-50"
        >
          Add date
        </button>
      </div>
      <div className="flex max-h-36 flex-wrap gap-2 overflow-y-auto">
        {value.map((date) => (
          <button
            key={date}
            type="button"
            aria-label={`Remove ${date}`}
            onClick={() => onChange(value.filter((item) => item !== date))}
            className="rounded-lg border bg-muted px-3 py-1 text-xs"
          >
            {date} ×
          </button>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Each date uses the same time range and has its own Done status. After an
        occurrence is edited or resolved, edit individual occurrences or create
        a new schedule to change the date list.
      </p>
    </fieldset>
  );
}
