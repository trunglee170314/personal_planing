'use client';
import {
  Children,
  isValidElement,
  type ChangeEvent,
  type ReactNode,
  type SelectHTMLAttributes,
} from 'react';
import { SearchableSelect, type SearchOption } from './searchable-select';

function text(value: ReactNode): string {
  return Children.toArray(value)
    .map((child) =>
      isValidElement<{ children?: ReactNode }>(child)
        ? text(child.props.children)
        : typeof child === 'string' || typeof child === 'number'
          ? String(child)
          : '',
    )
    .join('');
}
// Compatibility wrapper for existing form handlers; only their value is changed.
export function RelationSelect({
  children,
  value,
  onChange,
  disabled,
  required,
  name,
  id,
  className,
  'aria-label': label,
}: SelectHTMLAttributes<HTMLSelectElement>) {
  const options: SearchOption[] = [];
  Children.forEach(children, (child) => {
    if (
      isValidElement<{
        value?: string;
        children?: ReactNode;
        'data-group'?: string;
      }>(child)
    )
      options.push({
        value: String(child.props.value ?? ''),
        label: text(child.props.children),
        group: child.props['data-group'],
      });
  });
  return (
    <span
      className={`relative block ${className?.includes('mt-1') ? 'mt-1' : ''}`}
    >
      <select
        id={id}
        name={name}
        value={String(value ?? '')}
        required={required}
        disabled={disabled}
        onChange={onChange}
        tabIndex={-1}
        aria-label={label ?? 'Selected option'}
        className="sr-only"
        onInvalid={(event) => {
          event.preventDefault();
          event.currentTarget.parentElement
            ?.querySelector<HTMLButtonElement>('button')
            ?.focus();
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      <SearchableSelect
        aria-label={label ?? 'Choose or search'}
        value={String(value ?? '')}
        options={options}
        disabled={disabled}
        placeholder={label ?? 'Choose or search…'}
        onChange={(next) =>
          onChange?.({
            target: { value: next },
            currentTarget: { value: next },
          } as ChangeEvent<HTMLSelectElement>)
        }
      />
    </span>
  );
}
