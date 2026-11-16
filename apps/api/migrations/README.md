# Migrations

Our own database tables, as numbered SQL files (ADR-0002). The API applies new
ones by itself when it starts (`src/migrations.ts`), after Better Auth has made
its tables, and records each one in the `schema_migrations` table.

- Name files with four digits, an underscore and a lowercase name, for example
  `0001_sessions.sql`. They run in name order.
- Each file runs in one transaction: if it fails, none of it is kept and the API
  doesn't start.
- Never edit a file that has already run anywhere. To change a table, add a new
  file, for example `0002_add_sessions_title.sql`.
- Better Auth's tables (`user`, `account`, `logins`, `verification`,
  `rateLimit`) aren't here: Better Auth creates them itself.
