# SQL Diagram

Import one or more `.sql` files (schema scripts or full database dumps) and get diagrams of their tables, fields and relationships. Everything is parsed locally in the browser.

- **Multiple files** are merged into one schema: foreign keys may point across files, and file order doesn't matter (all `CREATE TABLE`s are applied before `ALTER TABLE`s). Add, remove or paste extra files at any time.
- **Large dumps** are streamed in a Web Worker. A small state machine (`src/sql/scanner.ts`) skips `INSERT` statements and `COPY … FROM stdin` data without copying it, so memory stays flat and the UI stays responsive (roughly 150–200 MB/s on a laptop; a 300 MB dump takes about 1.5 s).
- The extracted DDL (not the raw dump) is remembered in `localStorage`, so a reload restores the diagram.

## Views

| Tab | What it shows |
|---|---|
| **ER diagram** | Interactive ERD (drag, zoom, auto-layout, find a table, click to highlight its relationships, PNG export). Crow's foot markers on every FK. |
| **Crow's foot** | Static Mermaid ER diagram. Solid = identifying, dashed = non-identifying. SVG export. |
| **UML class** | Tables as classes, columns as attributes, FKs as associations/compositions. |
| **Dependency graph** | Table-level "who references whom" graph; link tables shown as hexagons. |
| **Relationships** | Every FK with cardinality (1:1 / N:1), optionality, ON DELETE/UPDATE; detected many-to-many link tables; per-table connectivity. |
| **Data dictionary** | All fields with type, PK/FK/UQ/auto, nullability, default, reference and comment. Markdown export. |

## Supported SQL

A tolerant DDL parser (`src/sql/parser.ts`) understands MySQL/MariaDB, PostgreSQL (incl. `pg_dump`), SQL Server (incl. `GO` batches and `[bracket]` names) and SQLite:

- `CREATE TABLE` with inline or table-level `PRIMARY KEY`, `UNIQUE`, `REFERENCES`, `FOREIGN KEY`
- `ALTER TABLE … ADD CONSTRAINT / ADD COLUMN / MODIFY / ALTER COLUMN`
- `CREATE UNIQUE INDEX`, `COMMENT ON TABLE/COLUMN`, MySQL `COMMENT '…'`

Other statements (inserts, functions, views, …) are skipped. The scanner understands `'…'`/`"…"`/`` `…` ``/`[…]` quoting with doubled-quote and backslash escapes (backslashes are treated literally for PostgreSQL `standard_conforming_strings`, SQL Server and SQLite), `E'…'` and `$tag$…$tag$` strings, `--`/`#`/`/* */` comments, `GO` batches, `DELIMITER` and `COPY` blocks, and UTF-8 / UTF-16 files (with or without BOM). Anything that couldn't be resolved shows up under the warnings chip.

## Development

```bash
npm install
npm run dev
```

| Command | |
|---|---|
| `npm test` | All tests (Vitest): generic dialect tests, edge cases, performance budgets |
| `npm run test:perf` | Performance tests only, printing throughput |
| `npm run typecheck` | Type-check app and tests |
| `npm run lint` | oxlint |
| `npm run build` | Type-check and build to `dist/` |

Tests live in `tests/`:

- `generic.test.ts` — realistic MySQL, pg_dump, SQL Server and SQLite dumps; multi-file merging; diagram generators; layout.
- `edge.test.ts` — empty input, unterminated strings, semicolons/comment markers inside strings and identifiers, escape rules per dialect, dollar quoting, COPY, DELIMITER, GO, CRLF, encodings, and identical results for every chunk size (1 byte up).
- `perf.test.ts` — 40 MB INSERT and COPY dumps, a 30 MB string literal, quadratic-trap inputs, 3,000-table schemas and a 400-table layout. Budgets are generous so they hold on CI; set `PERF_SCALE=5` to run with 5× bigger inputs.

## Deployment

`.github/workflows/ci.yml` runs lint, type-check, tests and a build on every push and pull request. Pushes to `main` are then published to GitHub Pages.

One-time setup: in the repository on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**. The build sets Vite's `base` from `BASE_PATH`, which the workflow takes from `actions/configure-pages`, so it works for both `https://<user>.github.io/<repo>/` and a custom domain.
