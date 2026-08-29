'use client';

import { useEffect, useState } from 'react';
import {
  BarChart3,
  BellRing,
  CalendarDays,
  Check,
  CheckCircle2,
  ChevronDown,
  LayoutDashboard,
  ListTodo,
  ListChecks,
  LogOut,
  Menu,
  GitBranch,
  Settings,
  Target,
  Users,
  TimerReset,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { PlannerCalendar } from './planner-calendar';
import { CalendarItemsManager } from './calendar-items-manager';
import { GoalsPanel } from './goals-manager';
import { PomodoroPanel } from './pomodoro-panel';
import { ReviewsPanel } from './reviews-panel';
import { TasksPanel } from './tasks-manager';
import { TimelinePanelV2 } from './timeline-panel-v2';
import { TodayPanelV2 } from './today-panel-v2';
import { NotificationSettings } from './notification-settings';
import { AdminUsers } from './admin-users';
import { HolidaySettings } from '@/components/holiday-settings';
import { PlanningEditor } from '@/components/planning-editor';
import { CalendarEditorHost } from '@/components/calendar-editor-host';
import { MindmapPanel } from './mindmap-panel';
import { UndoControl } from '@/components/undo-control';
import {
  WorkspaceSearch,
  type SearchFocus,
} from '@/components/workspace-search';
import { getPlanningRepository, type ThemeId } from '@/lib/data/repository';

const themes: { id: ThemeId; name: string; color: string }[] = [
  { id: 'jade', name: 'Jade Pebble Morning', color: '#7B9669' },
  { id: 'sapphire', name: 'Sapphire Nightfall Whisper', color: '#0474C4' },
  { id: 'ink', name: 'Ink Wash', color: '#545454' },
  { id: 'paper', name: 'Paper White', color: '#2563EB' },
];
const navigation = [
  { label: 'Today', icon: LayoutDashboard },
  { label: 'Goals', icon: Target },
  { label: 'Tasks', icon: ListTodo },
  { label: 'Checklists', icon: ListChecks },
  { label: 'Reminders', icon: BellRing },
  { label: 'Calendar', icon: CalendarDays },
  { label: 'Timeline', icon: BarChart3 },
  { label: 'Mindmap', icon: GitBranch },
  { label: 'Pomodoro', icon: TimerReset },
  { label: 'Reviews', icon: CheckCircle2 },
  { label: 'Settings', icon: Settings },
];

export function TodayDashboard({
  firstName,
  accountKey,
  dataMode = 'cloud',
  onSignOut,
  isAdmin = false,
}: {
  firstName: string;
  accountKey: string;
  dataMode?: 'local' | 'cloud';
  onSignOut?: () => void;
  isAdmin?: boolean;
}) {
  const visibleNavigation =
    isAdmin && dataMode === 'cloud'
      ? [...navigation, { label: 'Users', icon: Users }]
      : navigation;
  const repository = getPlanningRepository();
  const themeCacheKey = `myplan-theme:${dataMode}:${accountKey}`;
  const [theme, setTheme] = useState<ThemeId>(() => {
    if (typeof window === 'undefined') return 'jade';
    const saved = window.localStorage.getItem(themeCacheKey) as ThemeId | null;
    return saved && themes.some((item) => item.id === saved) ? saved : 'jade';
  });
  const [activeView, setActiveView] = useState(() => {
    if (typeof window === 'undefined') return 'Today';
    const requested = new URLSearchParams(window.location.search).get('view');
    return navigation.some((item) => item.label === requested)
      ? requested!
      : 'Today';
  });
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [searchFocus, setSearchFocus] = useState<SearchFocus | null>(null);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme =
      theme === 'sapphire' ? 'dark' : 'light';
    window.localStorage.setItem(themeCacheKey, theme);
  }, [theme, themeCacheKey]);
  useEffect(() => {
    if ('serviceWorker' in navigator)
      void navigator.serviceWorker.register('/service-worker.js');
  }, []);
  useEffect(() => {
    if (!repository) return;
    void repository
      .getTheme()
      .then((saved) => setTheme(saved))
      .catch(() => undefined);
  }, [repository]);
  async function chooseTheme(next: ThemeId) {
    setTheme(next);
    try {
      await repository?.saveTheme(next);
    } catch {
      /* cache remains a safe visual fallback */
    }
  }
  function openView(label: string, focus?: SearchFocus) {
    setSearchFocus((previous) =>
      focus ? { ...focus, key: (previous?.key ?? 0) + 1 } : null,
    );
    setActiveView(label);
    setMobileMenuOpen(false);
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <PlanningEditor />
      <CalendarEditorHost />
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <aside
        className="fixed inset-y-0 left-0 z-20 hidden w-[252px] flex-col border-r bg-card/95 p-[22px] md:flex"
        aria-label="Primary navigation"
      >
        <div className="flex items-center gap-3 text-xl font-bold tracking-[-0.04em]">
          <span className="grid size-9 place-items-center rounded-[12px_12px_12px_4px] bg-primary text-primary-foreground shadow-lg shadow-primary/15">
            <Check className="size-4" />
          </span>
          myplan
        </div>
        <nav className="mt-10 flex flex-col gap-1">
          <p className="mb-2 px-3 text-[10px] font-bold uppercase tracking-[.14em] text-muted-foreground">
            Workspace
          </p>
          {visibleNavigation.map(({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() => openView(label)}
              aria-current={label === activeView ? 'page' : undefined}
              className={`grid min-h-11 grid-cols-[20px_1fr] items-center gap-3 rounded-xl px-3 text-left text-sm transition ${label === activeView ? 'bg-secondary font-semibold text-secondary-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground'}`}
            >
              <Icon className="size-[18px]" />
              <span>{label}</span>
            </button>
          ))}
        </nav>
        {dataMode === 'cloud' ? (
          <button
            className="mt-auto flex items-center gap-3 rounded-xl p-2 text-left"
            type="button"
            aria-label="Open profile menu"
          >
            <span className="grid size-9 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">
              {firstName.slice(0, 1).toUpperCase()}
            </span>
            <span className="flex min-w-0 flex-1 flex-col">
              <strong className="text-xs">{firstName}</strong>
              <small className="truncate text-[10px] text-muted-foreground">
                Online workspace
              </small>
            </span>
            <ChevronDown className="size-3.5" />
          </button>
        ) : null}
      </aside>
      <main
        id="main-content"
        className="min-h-screen pb-24 md:ml-[252px] md:pb-0"
      >
        <header className="sticky top-0 z-40 flex h-16 items-center justify-between border-b bg-background/85 px-4 backdrop-blur-xl md:h-[74px] md:px-8 lg:px-12">
          <div className="flex items-center gap-2 font-bold md:hidden">
            <Button
              variant="ghost"
              size="icon"
              aria-label="Open navigation"
              aria-expanded={mobileMenuOpen}
              onClick={() => setMobileMenuOpen((open) => !open)}
            >
              <Menu />
            </Button>
            <span>myplan</span>
          </div>
          <div className="ml-auto flex items-center gap-1">
            <span className="mr-2 rounded-full border bg-card px-2.5 py-1 text-[10px] font-semibold text-muted-foreground">
              {dataMode === 'local' ? 'Local' : 'Online'}
            </span>
            <div
              className="mr-2 hidden items-center gap-2 border-r pr-4 sm:flex"
              aria-label="Choose color scheme"
            >
              {themes.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  aria-label={`Use ${item.name} theme`}
                  aria-pressed={theme === item.id}
                  onClick={() => void chooseTheme(item.id)}
                  className={`grid size-11 place-items-center rounded-full ${theme === item.id ? 'ring-2 ring-ring ring-offset-1 ring-offset-background' : ''}`}
                >
                  <span
                    className="size-[18px] rounded-full border-[3px] border-card outline outline-1 outline-border"
                    style={{ backgroundColor: item.color }}
                  />
                </button>
              ))}
            </div>
            {onSignOut ? (
              <Button
                variant="ghost"
                size="icon"
                aria-label="Sign out"
                onClick={onSignOut}
              >
                <LogOut />
              </Button>
            ) : null}
          </div>
        </header>
        {mobileMenuOpen ? (
          <div className="fixed inset-x-3 top-[68px] z-30 rounded-2xl border bg-card p-2 shadow-xl md:hidden">
            {visibleNavigation.map(({ label, icon: Icon }) => (
              <button
                key={label}
                type="button"
                onClick={() => openView(label)}
                className={`flex min-h-11 w-full items-center gap-3 rounded-xl px-3 text-sm ${label === activeView ? 'bg-secondary font-semibold text-secondary-foreground' : 'text-muted-foreground'}`}
              >
                <Icon className="size-[18px]" />
                {label}
              </button>
            ))}
          </div>
        ) : null}
        <div className="workspace-content w-full min-w-0 px-4 py-6 md:px-6 lg:px-8">
          <UndoControl scope={`${dataMode}:${accountKey}`} />
          <WorkspaceSearch navigate={openView} />
          {activeView === 'Users' && isAdmin && dataMode === 'cloud' ? (
            <AdminUsers />
          ) : activeView === 'Today' ? (
            <TodayPanelV2
              firstName={firstName}
              onOpenCalendar={() => openView('Calendar')}
            />
          ) : activeView === 'Goals' ? (
            <GoalsPanel
              key={searchFocus?.key}
              initialView={searchFocus?.view}
              initialQuery={searchFocus?.query}
            />
          ) : activeView === 'Tasks' ? (
            <TasksPanel
              key={searchFocus?.key}
              initialView={searchFocus?.view}
              initialQuery={searchFocus?.query}
            />
          ) : activeView === 'Checklists' ? (
            <CalendarItemsManager type="checklist" />
          ) : activeView === 'Reminders' ? (
            <CalendarItemsManager type="reminder" />
          ) : activeView === 'Calendar' ? (
            <PlannerCalendar />
          ) : activeView === 'Timeline' ? (
            <TimelinePanelV2 />
          ) : activeView === 'Mindmap' ? (
            <MindmapPanel />
          ) : activeView === 'Pomodoro' ? (
            <PomodoroPanel
              key={searchFocus?.key}
              initialQuery={searchFocus?.query}
            />
          ) : activeView === 'Settings' ? (
            <div className="space-y-8">
              <NotificationSettings dataMode={dataMode} />
              <HolidaySettings />
            </div>
          ) : (
            <ReviewsPanel
              key={searchFocus?.key}
              initialWeek={searchFocus?.week}
            />
          )}
        </div>
      </main>
      <nav
        className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-4 border-t bg-card/95 px-2 pb-[max(8px,env(safe-area-inset-bottom))] pt-2 backdrop-blur-xl md:hidden"
        aria-label="Mobile navigation"
      >
        {[navigation[0], navigation[2], navigation[3], navigation[5]].map(
          ({ label, icon: Icon }) => (
            <button
              key={label}
              type="button"
              onClick={() => openView(label)}
              aria-current={label === activeView ? 'page' : undefined}
              className={`flex min-h-12 flex-col items-center justify-center gap-1 text-[9px] ${label === activeView ? 'font-bold text-primary' : 'text-muted-foreground'}`}
            >
              <Icon className="size-[18px]" />
              {label}
            </button>
          ),
        )}
      </nav>
    </div>
  );
}
