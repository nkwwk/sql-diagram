# SQL Diagram

[![CI & Pages](https://github.com/nkwwk/sql-diagram/actions/workflows/ci.yml/badge.svg)](https://github.com/nkwwk/sql-diagram/actions/workflows/ci.yml)

Turn `.sql` files into ER diagrams, relationship lists and a data dictionary — right in your browser.

**[Open the app →](https://nkwwk.github.io/sql-diagram/)**

- Works with schema scripts **and** full database dumps, even multi-GB ones
- Reads compressed files and archives (`.gz`, `.zip`, `.tar.gz`, `.bz2`, `.xz`, `.zst`)
- MySQL / MariaDB, PostgreSQL, SQL Server and SQLite
- Nothing is uploaded: files are parsed locally, on desktop or phone

## How to use it

1. **Open** one or more files — click **Open .sql files**, drag them onto the page, or **Paste SQL**.
   No file handy? Click **Load sample**.
2. **Explore** the tabs:

   | Tab | What you get |
   |---|---|
   | **ER diagram** | Interactive diagram: drag tables, zoom, search, switch layout. Click a table to highlight its relationships and see its columns. Export as PNG. |
   | **Crow's foot** | Classic ER notation. Solid lines = the foreign key is part of the primary key. Export as SVG. |
   | **UML class** | Tables as classes, columns as attributes, foreign keys as associations. |
   | **Dependency graph** | Which table references which, at a glance. |
   | **Relationships** | Every foreign key with its type (1:1 or N:1), whether it's optional, and ON DELETE / ON UPDATE rules. Also many-to-many links through junction tables. |
   | **Data dictionary** | Every column with type, keys, nullability, default, reference and comment. Export as Markdown. |

3. **Add more files** at any time. Tables from all files are merged into one schema, and foreign keys can point across files — the order you add them in doesn't matter.

Problems — like a foreign key to a table that isn't in any file — appear under the **warnings** badge in the header.

## Supported files

### SQL dialects

| Dialect | Notes |
|---|---|
| MySQL / MariaDB | `mysqldump` output, backticks, `AUTO_INCREMENT`, `COMMENT '…'`, `DELIMITER` blocks |
| PostgreSQL | `pg_dump` output, schemas, `ALTER TABLE ONLY …`, `COPY … FROM stdin`, `COMMENT ON`, `$$` function bodies |
| SQL Server | SSMS scripts, `[bracketed]` names, `GO` batches, `IDENTITY` |
| SQLite | `.dump` output |

The app reads table structure — `CREATE TABLE`, `ALTER TABLE`, `CREATE UNIQUE INDEX` and comments. Everything else (inserts, views, functions…) is skipped quickly, so data-heavy dumps are fine. UTF-8 and UTF-16 files both work.

### Compressed files and archives

| Format | Notes |
|---|---|
| `.gz` | Including multi-part files from `pigz` / `bgzip` |
| `.bz2` | Including `pbzip2` output |
| `.xz`, `.zst` | |
| `.zip` | Including large (ZIP64) archives. **Password-protected zips prompt for the password.** |
| `.tar`, `.tar.gz`, `.tgz`, … | |

- Formats are recognised from the file contents, not the name, and can be nested (e.g. a `.sql.gz` inside a `.zip`).
- Inside archives, only `.sql`-type files are read; other files are skipped with a note.
- 7-Zip, RAR, PostgreSQL custom-format dumps and SQLite database files aren't supported, but the app tells you how to convert them (e.g. `pg_restore -f out.sql`).

## Privacy

- Files never leave your device; all parsing happens in your browser.
- To restore your diagram after a reload, the app keeps only the extracted table definitions (not the data) in your browser's local storage. **Clear** removes them.
- Passwords are never stored, and schemas from password-protected files are not saved for the next visit.

## Performance

| Task | Typical time (laptop) |
|---|---|
| Parse a 300 MB dump full of `INSERT`s | ~1.5 s |
| Decompress and parse 150 MB of gzipped SQL | ~1.2 s |
| Drag a table in a 500-table diagram | 2–7 ms per frame |

Large files are read as a stream in a background worker, so memory stays low and the page stays responsive.

---

## Development

Requires Node.js 20.19+ (22 recommended).

```bash
npm install
npm run dev
```

| Command | Purpose |
|---|---|
| `npm run dev` | Start the dev server |
| `npm test` | Run all tests (Vitest) |
| `npm run test:perf` | Run only the performance tests, printing timings |
| `npm run typecheck` | Type-check the app and tests |
| `npm run lint` | Lint with oxlint |
| `npm run build` | Type-check and build to `dist/` |

### Project layout

```
src/
  sql/
    scanner.ts         streaming statement splitter (skips INSERT/COPY data)
    parser.ts          DDL parser → tables, columns, relationships
    import.ts          reads files: decompression, encodings, per-file reports
    import.worker.ts   runs imports off the main thread
    archive/           gzip / bzip2 / xz / zstd / zip / tar readers, zip decryption
  erd/                 interactive ER diagram (React Flow + dagre layout)
  diagrams/mermaid.ts  crow's foot, UML class and dependency graph generators
  views/               Mermaid, relationships, data dictionary and files views
  components/          menus and the password dialog
tests/                 Vitest suites and archive fixtures
```

### Tests

| File | Covers |
|---|---|
| `generic.test.ts` | Realistic dumps for each dialect, multi-file merging, diagram generators, layout |
| `edge.test.ts` | Tricky quoting and comments, escape rules per dialect, `GO` / `DELIMITER` / `COPY`, encodings, identical results at every chunk size |
| `archive.test.ts` | Every compression and archive format, nesting, password-protected zips, truncated and corrupt files |
| `perf.test.ts` | Large dumps, worst-case inputs, 3,000-table schemas. Set `PERF_SCALE=5` for 5× bigger inputs |

Some archive tests use the `bzip2`, `xz` and `zstd` command-line tools when they're installed, and are skipped otherwise.

## Deployment

Every push and pull request runs lint, type-check, tests and a build in GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)). Pushes to `main` are then published to GitHub Pages.

**One-time setup:** on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**.

The workflow sets the site's base path automatically, so it works both at `https://<user>.github.io/<repo>/` and on a custom domain.
