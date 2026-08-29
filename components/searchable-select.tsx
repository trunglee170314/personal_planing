'use client';
import { useState } from 'react';
import { ChevronsUpDown, Check } from 'lucide-react';
import {
  Popover,
  PopoverTrigger,
  PopoverContent,
} from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandItem,
} from '@/components/ui/command';
import { matchesSearch } from '@/lib/workspace-view';

export type SearchOption = { value: string; label: string; group?: string };
export function SearchableSelect({
  value,
  onChange,
  options,
  placeholder = 'Choose…',
  disabled = false,
  'aria-label': label,
}: {
  value: string;
  onChange: (value: string) => void;
  options: SearchOption[];
  placeholder?: string;
  disabled?: boolean;
  'aria-label'?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const selected = options.find((item) => item.value === value);
  const groups = new Map<string, SearchOption[]>();
  for (const option of options.filter((item) =>
    matchesSearch(query, item.label, item.group),
  )) {
    const group = option.group ?? '';
    groups.set(group, [...(groups.get(group) ?? []), option]);
  }
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) setQuery('');
      }}
    >
      <PopoverTrigger
        type="button"
        disabled={disabled}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`${label ?? placeholder}: ${selected?.label ?? 'not selected'}`}
        className="flex min-h-10 w-full items-center justify-between gap-2 rounded-xl border bg-background px-3 py-2 text-left text-sm"
      >
        <span className="min-w-0 truncate" title={selected?.label}>
          {selected?.label ?? placeholder}
        </span>
        <ChevronsUpDown className="size-4 shrink-0" />
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-[min(560px,calc(100vw-32px))] p-0"
      >
        <Command shouldFilter={false}>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Search name or goal…"
          />
          <CommandList>
            <CommandEmpty>No matches.</CommandEmpty>
            {[...groups]
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([group, items]) => (
                <CommandGroup key={group} heading={group || undefined}>
                  {items.map((item) => (
                    <CommandItem
                      key={item.value}
                      value={item.value || '__none'}
                      onSelect={() => {
                        onChange(item.value);
                        setOpen(false);
                        setQuery('');
                      }}
                      className="items-start whitespace-normal break-words py-2"
                    >
                      <Check
                        className={`mt-0.5 size-4 shrink-0 ${value === item.value ? 'opacity-100' : 'opacity-0'}`}
                      />
                      <span>{item.label}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
