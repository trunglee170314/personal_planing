import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TaskLink } from '../components/task-link';
import { safeTaskLink, type TaskLinkSource } from '../lib/task-links';

describe('quick Task links', () => {
  it('renders an accessible native link and hides unavailable or unsafe targets', () => {
    expect(TaskLink({})).toBeNull();
    expect(
      TaskLink({ task: { title: 'Bad', link_url: 'javascript:alert(1)' } }),
    ).toBeNull();
    const link = TaskLink({
      task: {
        title: 'Project',
        link_url: 'https://example.com/docs',
        link_label: 'Reference',
      },
    })!;
    expect(link.type).toBe('a');
    expect(link.props).toMatchObject({
      href: 'https://example.com/docs',
      target: '_blank',
      rel: 'noopener noreferrer',
      'aria-label': 'Open task link: Project',
      'data-shortcut-action': 'openLink',
      title: 'Reference — https://example.com/docs',
    });
  });
  it('isolates pointer and edit gestures without cancelling native navigation', () => {
    const link = TaskLink({
      task: { title: 'Project', link_url: 'https://example.com' },
    })!;
    const event = { stopPropagation: vi.fn(), preventDefault: vi.fn() };
    for (const handler of ['onPointerDown', 'onClick', 'onDoubleClick'])
      link.props[handler](event);
    expect(event.stopPropagation).toHaveBeenCalledTimes(3);
    expect(event.preventDefault).not.toHaveBeenCalled();
    link.props.onKeyDown({ ...event, key: 'Enter' });
    link.props.onKeyDown({ ...event, key: ' ' });
    link.props.onKeyDown({ ...event, key: 'o' });
    expect(event.stopPropagation).toHaveBeenCalledTimes(5);
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
  it('escapes imported titles and supports the full-label editor action', () => {
    const html = renderToStaticMarkup(
      createElement(TaskLink, {
        task: {
          title: '<script>"Task"</script>',
          link_url: 'https://example.com',
        },
        compact: false,
      }),
    );
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('Open task link</a>');
  });
  const task = (link_url: string | null): TaskLinkSource => ({
    title: 'Task',
    link_url,
  });
  it('only exposes absolute HTTP or HTTPS URLs', () => {
    for (const value of [
      null,
      '',
      ' ',
      '/relative',
      '//example.com',
      'example.com',
      'javascript:alert(1)',
      'data:text/html,test',
      'file:///tmp/test',
      'mailto:a@example.com',
      'ftp://example.com',
    ])
      expect(safeTaskLink(task(value)), String(value)).toBeNull();
    expect(safeTaskLink()).toBeNull();
    expect(safeTaskLink(null)).toBeNull();
    expect(safeTaskLink(task('https://example.com/docs?q=hello#section'))).toBe(
      'https://example.com/docs?q=hello#section',
    );
    expect(safeTaskLink(task('http://localhost:3000/'))).toBe(
      'http://localhost:3000/',
    );
  });
  it('normalizes a URL without mutating the Task or storing a Checklist copy', () => {
    const source = Object.freeze({
      title: 'Project',
      link_url: '  HTTPS://EXAMPLE.COM  ',
      link_label: 'Docs',
    });
    expect(safeTaskLink(source)).toBe('https://example.com/');
    expect(source.link_url).toBe('  HTTPS://EXAMPLE.COM  ');
  });
});
