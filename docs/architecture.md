# myplan architecture

## Data modes

The interface depends on one `PlanningRepository` contract. Startup selects exactly one implementation; it never silently falls back between databases.

```text
localhost (NEXT_PUBLIC_APP_MODE=local)
└── browser → loopback API (127.0.0.1:4318) → laptop SQLite file

hosted site (NEXT_PUBLIC_APP_MODE=cloud or omitted)
└── browser → Supabase API/Auth → managed Postgres
```

Local mode is single-user, skips sign-in, and stores its database under the WSL user's home directory. The local API binds only to loopback and accepts browser requests only from localhost origins. Cloud mode remains fail-closed when Supabase configuration is missing.

Local and cloud data are intentionally independent. No automatic synchronization, import, conflict resolution, or failover exists yet.

## Cloud deployment boundary

The repository and database migrations are shared, but every owner receives a separate application deployment and Supabase project. Each deployment has fixed Supabase configuration and never chooses a database from browser-supplied identity data.

```text
shared repository
├── owner deployment A → Supabase project A
├── owner deployment B → Supabase project B
└── owner deployment C → Supabase project C
```

This preserves the approved physical database and Auth isolation model. Row Level Security remains enabled as defense in depth inside every instance.

## Current slice

- Authenticated Supabase cloud mode for multiple invited users.
- Laptop-only SQLite mode with the same Goals, Tasks, Today, Calendar, Timeline, and Reviews behavior.
- Responsive Today dashboard with task completion and reopening behavior.
- Four user-selectable color schemes persisted as a device preference.
- Independent, timestamp-based Pomodoro timer with device-local active-session recovery.
- Supabase migrations for profiles, goals, workflows, tasks, links, checklist items, and weekly reviews.
- SQLite schema bootstrap with a default workflow and durable file storage outside the repository.
