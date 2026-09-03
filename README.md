# Organization Controller

A multi-tenant web app that models any organization (school, hospital,
university, ...) as an editable hierarchy of people, with task/duty logging,
profiles, AI-assisted CV import, and automatic payroll calculation.

## Stack

- **Frontend:** React (Vite) + React Router
- **Backend:** Node.js / Express
- **Database:** PostgreSQL 16 with the `ltree` extension
- **AI:** Google Gemini API (CV parsing)
- **File storage:** any S3-compatible store (AWS S3, MinIO, R2, ...)
- **Auth:** JWT, permissions computed live from hierarchy position

## Why these choices

### Hierarchy & subtree access control (the core design problem)

Every person row stores a materialized `path` using Postgres's `ltree`
extension (`org_head_id.vp_id.teacher_id`, etc.), alongside the normal
`parent_id` you edit through the UI. This means:

- **"What can this person see?"** is one indexed query:
  `WHERE path <@ '<their_path>'::ltree` (ltree's "descendant-of-or-equal"
  operator). No recursive CTEs, no N+1 queries, no loading a whole subtree
  into app memory to filter it.
- **Moving a person (and their whole subtree) to a new manager** is a
  single `UPDATE ... WHERE path <@ old_path` that rewrites every affected
  path in one statement — see `PATCH /people/:id/move` in
  `backend/src/routes/people.js`.
- All of this logic is centralized in `backend/src/utils/permissions.js`
  (`assertCanAccessPerson` / `assertCanManagePerson`) so there's exactly
  one place that can get the subtree rule wrong, and it's unit-testable
  in isolation from HTTP/route concerns.
- Permissions are **recomputed from the database on every request**
  (`middleware/auth.js` re-reads the person's current path/status), not
  baked into the JWT at login — so a demotion, reassignment, or
  suspension takes effect immediately, not after the token expires.

### Flexible pay rules

`pay_rules` supports three scopes — `organization`, `role`, `person` —
with a defined precedence (person > role > org default) resolved in
`backend/src/services/payrollService.js::resolvePayRule`. Each rule
carries `pay_type` (hourly/salary), overtime settings, and a JSON
`bonus_rules` array so new bonus types can be added without a schema
migration. `pay_rules` also has `effective_from`/`effective_to` so rate
changes don't rewrite payroll history.

### Multi-tenant isolation

Every tenant-owned table carries `organization_id`. Two layers enforce
isolation:

1. **Application layer:** every query goes through `withTenant()` /
   explicit `organization_id = $1` filters.
2. **Database layer (belt-and-braces):** Postgres Row Level Security
   policies on every tenant table check
   `organization_id = current_setting('app.current_org_id')`, which the
   app sets via `SET LOCAL` at the start of each transaction. Even a
   query that forgets its own `WHERE organization_id = ...` clause
   cannot leak data across tenants.

Subtree (hierarchy) visibility is deliberately **not** folded into RLS —
it depends on which person is asking, not just which org, so it's
enforced explicitly in the query layer (`visibleSubtreeClause`,
`assertCanAccessPerson`) where it's easier to reason about and test.

### CV import safety

Gemini output is **never** written directly into a real profile. It
lands in `cv_import_drafts` with `status='pending'`. A human (the person
or their manager) reviews/edits it, then `POST /cv/drafts/:id/confirm`
is the only code path that writes into `profiles`.

### Task log integrity

`task_entries.logged_at` has a `DEFAULT now()` and no route ever accepts
it from the client — the only editable fields are `description`,
`start_time`, `end_time` (the actual duty times). `duration_minutes` is
a generated column so hours are computed consistently everywhere.

## Getting started

### 1. Database

```bash
docker compose up -d postgres
```

This spins up Postgres 16 and auto-runs `schema.sql` then `seed.sql` on
first boot (via the `docker-entrypoint-initdb.d` mount).

If you're using an existing Postgres instance instead:

```bash
psql "$DATABASE_URL" -f backend/src/db/schema.sql
psql "$DATABASE_URL" -f backend/src/db/seed.sql   # optional demo data
```

> Note: `seed.sql` inserts a placeholder bcrypt hash for convenience —
> replace it or just register a fresh organization through the API/UI
> instead of relying on the seeded login.

### 2. Backend

```bash
cd backend
cp .env .env      # fill in DATABASE_URL, JWT_SECRET, GEMINI_API_KEY, S3_*
npm install
npm run dev                # http://localhost:4000
```

### 3. Frontend

```bash
cd frontend
npm install
npm run dev                # http://localhost:5173, proxies /api -> :4000
```

### 4. Try it

1. Go to `http://localhost:5173/register`, create an organization — this
   makes you the Head (root of the tree).
2. From the Hierarchy page, add subordinates under yourself; they can
   log in and add their own subordinates, forming the tree.
3. Log task entries from the Task Log page.
4. Set a pay rule via `POST /payroll/rules` (org/role scope requires
   Head; person scope requires being a manager of that person), then
   compute payroll from the Payroll page.
5. Upload a CV on a profile page to see the Gemini extraction → draft →
   confirm flow.

## Project layout

```
backend/
  src/
    db/            schema.sql, seed.sql, pool.js (tenant-scoped transactions)
    middleware/     auth.js (JWT verify + live hierarchy lookup)
    utils/          permissions.js (subtree access control — the core logic)
    services/       payrollService.js, geminiService.js, storageService.js
    routes/         auth.js, people.js, tasks.js, payroll.js, cv.js
    server.js
frontend/
  src/
    api/client.js   axios instance with JWT interceptor
    pages/          Login, Register, OrgTree, Profile, TaskLog, Payroll
    components/     TreeView.jsx (recursive hierarchy renderer)
docker-compose.yml  Postgres with ltree, auto-seeded
```

## What's stubbed / left for you

- **Refresh tokens / logout-everywhere** — currently a single JWT with
  an expiry; fine for an MVP, add a refresh-token table before real
  production use.
- **Rate limiting & audit log** — add `express-rate-limit` and a
  generic `audit_log` table (who did what, when) before production,
  especially for payroll and hierarchy-move actions.
- **Tests** — `utils/permissions.js` and `services/payrollService.js`
  are written to be trivially unit-testable (pure-ish functions taking
  a `client`); add a `tests/` folder with `jest` + a test database.
- **Frontend polish** — the UI here is intentionally minimal/functional
  so the architecture is easy to read; styling, loading states, and
  pagination are left for you to extend.
