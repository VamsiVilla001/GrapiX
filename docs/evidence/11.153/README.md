# 11.153, Data panel: the strict CSV table reader (Panchayati task 121, slice 1)

Built by claude-grapix-f1 on 25 Nov 2026. This is the first backend slice of the Data panel's local CSV source (Figma B4): a pure reader from bytes to a table. It is **not** the whole of task 121 and it does not finish row 11.153.

## What was built

`Shared/contracts/src/csv_table.rs` (new, plus one `pub mod csv_table;` line in `Shared/contracts/src/lib.rs`). The table type is `TextTable` (every cell is text), not `DataTable`: plan row 19.2 reserves `DataTable`, `DataRecord` and `DataField` for the typed Data Hub contract, and a second `DataTable` would collide in Rust and as `DataTable.ts` in the generated TypeScript. No dependency beyond `serde` and `ts-rs`, which the crate already has, so the Data Hub connectors (19.4) and the run-order exchange (6.9, also CSV) can reuse it.

```
parse_csv(bytes, Delimiter::{Comma|Semicolon|Tab}, &CsvLimits) -> Result<TextTable { columns, rows }, CsvFault>
```

The rules were put to Jev and Laya before the build (`csv-input.json`, `jev-laya-csv.json`); Jev chose option A on all six questions:

| Question | Rule built |
|---|---|
| Delimiter | The caller states it. Never detected. If the header is one column as stated and its first line plainly uses another delimiter, the refusal says which (`WrongDelimiter`). |
| Encoding | UTF-8 only; one leading byte order mark removed. UTF-16 (with or without a mark) and a Windows code page are refused by name, with what they look like and the offset. Nothing is decoded by guessing. |
| Blank lines | Allowed only at the end of the file. Anywhere else: `BlankLine { line }`. A one-column file writes an empty cell as `""`. |
| Shape | Empty or blank column name, repeated column name, a row with more or fewer cells than the header, a stray quote, an unterminated quote: each refused by name with its line (physical lines from 1; a quoted cell that spans lines moves the count). Nothing padded, cut or renamed. |
| Limits | File 16 MiB, 100,000 rows, 256 columns, 64 KiB per cell (bytes of UTF-8), all stated in `CsvLimits`. Over a limit is `TooLarge { limit, allowed, found }`; nothing is read in part. |
| Cells | Exactly the text after unquoting: no trimming, case change, normalisation or number parsing. A Devanagari name and a leading zero come back as written. Types come from the graphic's own fields (row 11.54), not from the cells. |

Quotes are RFC 4180 (`""` is a quote; a cell may hold the delimiter and line breaks, kept exactly as written). Line ends are CRLF, LF or CR, mixed if need be.

Every `CsvFault` has a `Display` sentence an operator can act on ("line 17 has 2 cells and the header has 3", "save it as \"CSV UTF-8\" and try again", "choose semicolon as the delimiter, or quote the header") and serialises as `{ "fault": "raggedRow", "line": 4, "expected": 3, "found": 2 }` for the page.

## What was found while building it

* UTF-16 text with no byte order mark is *valid UTF-8* (ASCII in UTF-16 is a zero in every other byte, and a zero is legal UTF-8). The first version read it as text with NUL characters and failed later as a ragged row. The reader now recognises the zero-every-other-byte pattern first and refuses it as UTF-16.
* A first column name that begins with U+FEFF cannot round-trip: a file beginning with that character begins with a byte order mark. Exactly one is removed (tested), and the property test avoids it.
* A one-column header that holds another delimiter must be quoted, or the reader takes the file for the wrong delimiter. That is the designed behaviour; the property test's writer quotes such headers.

## Verified

* `cargo test --locked -p gx-contracts --lib csv_table` (private target dir, under LOCK gate): **26 passed**: table-driven cases for every rule above, Devanagari exact, line numbers across multi-line quoted cells (LF and CRLF), each limit at and over its edge (bytes, not characters), UTF-16 and code-page detection and offsets, the default limits, the fault wording, the serde shape, and two properties: a deterministic random writer (4,000 tables of 1 to 6 columns, up to 24 rows, 30 awkward cells, three delimiters, three line endings, optional trailing blank lines) is read back exactly; and 100,000 rows are read and one more refused.
* The whole `gx-contracts` suite: **417 passed**, 0 failed (the module sits beside others' uncommitted changes in the crate).
* `rustfmt --check` on my file: clean.
* Mutation check (`tools/mutate-csv-table.mjs`, my own new file mutated in place with a backup restored byte for byte): **55 of 55 mutants caught** (`mutation-log.txt`). The first run left four survivors, all real test gaps: a UTF-16 mark with no zero byte in the text (M3, M4: a Hindi header in UTF-16 now tests both ends), an unterminated quote that opens on a later line of the same record (M34), and the wording of each limit (M53). The tests were added, the four mutants re-run and caught (`mutation-log-rerun.txt`); the tests only grew, so the 51 already caught stay caught. The mutation runs were made before the rename of `DataTable` to `TextTable` and of the module to `csv_table` (a mechanical rename; the 26 tests and the whole crate, 417, pass after it).

## Not verified, not built (slices that follow)

* No service read of a file or a published sheet, no persistence of a data source in the `.gpx` project, no shell command, no `Refusal` variant (the conformance refusal audit couples to that list, so it needs its own slice), no codegen of the types to TypeScript. `CsvFault` already derives `TS`, so the codegen slice is a list entry.
* Nothing yet shows a CSV in the Data panel: the Test records table, FITS / OVERFLOWS / EMPTY, and the Publish screen's Test row wait for tasks 121's later slices and 122. Row 11.153 stays active.
* Not run: the rest of `npm run check` (others' Rust work is in flight in the shared tree).

---

# Slice 2: the read path of a CSV source (25 Nov 2026)

## The design, asked of Jev and Laya before the build

`source-input.json` and `jev-laya-source.json`. Jev's answers (confidence in brackets); Laya's dissents are recorded and not followed (she is uncalibrated; her two dissents had confidence 0.04 and 0.001):

| Question | Jev | What it means for the build |
|---|---|---|
| Where the data lives | A (1.00): a **copy in the project** (e.g. `Data/Players.csv`, filed like an asset: streamed, hash-checked, a different file at the same name refused by name), read from the copy; the original path is only a label and a place for "Update from file". | A project stays portable and a take stays reproducible. Needs a `Data/` folder in the `.gpx` layout and a data-source record: that is **slice 3, in codex's `project.rs`, not started**. |
| A re-exported file | A (0.98): nothing automatic; the source says "Changed on disk"; an explicit update shows what changed and replaces the copy only on accept, the old copy kept as the previous revision. | The change is `column_change` (below) plus row counts. |
| A changed set of columns | A (1.00): a named schema change (added, removed, reordered, by exact name); a rename is never guessed. | `ColumnChange` / `column_change`. |
| What identifies a record | A (0.96): its 1-based data-row number, shown with the row's text; a key column is a later option and an empty or repeated key is refused by name. | Nothing to build yet; the Test records table uses row numbers. |
| Which files may be read | C (**0.34, low**; A 0.37, C 0.56 in its probabilities): only files inside the project folder. | Read as: every read is from the copy inside the project; the single place an outside path enters is the import copy, shell-only like `import_asset`, never MCP or the control plane. My own option A (the picked path, with guards) is what the import step does. Recorded as a low-confidence answer. |

## What was built

* `Shared/contracts/src/csv_table.rs` (mine): `ColumnChange { added, removed, reordered }` and `column_change(old, new)`. Names are compared exactly; `added` is in the new list's order, `removed` in the old list's order; `reordered` means the columns in both appear in a different order (a column added or removed around them does not reorder them). `Display` says it: `columns changed: added "country"; removed "role"; the order changed`. It derives `TS` and serde (camelCase); it is not in the codegen list yet.
* `services/editor/src/csv_source.rs` (new, one `pub mod csv_source;` line in `services/editor/src/lib.rs`): `read_csv_file(path, delimiter, limits) -> CsvRead { file_name, bytes, content_hash, delimiter, table }`, or `CsvSourceError::{Missing, NotAFile, Unreadable{reason}, Csv{path, fault}}` (each says which file; a reader fault keeps its line). The size is taken from the file's metadata and a file over the limit is refused **before a byte is read** (a file of invalid UTF-8 over the limit is refused as too large, which proves nothing was decoded); the read is capped at the limit plus one byte, so a file that grows after the check is refused, never read without bound; the SHA-256 (lowercase hex, the same content address assets use) is of the very bytes parsed, a byte order mark included, so the hash is never of a second read of a changed file. It writes nothing and leaves the file as it found it.

## Verified

* `cargo test --locked -p gx-contracts --lib csv_table`: **32 passed** (the 26 of slice 1 and 6 on `column_change`: no change, added and removed in their lists' order, a rename is one removed and one added with case and spaces exact, a different order alone, the words and the serde shape, and a random property over 3,000 edit sequences checked against how each list was made).
* `cargo test --locked -p gx-editor --lib csv_source`: **13 passed**: the name, size and an independently computed SHA-256; the mark changes the hash and counts in the size; Devanagari file name and cells with a semicolon delimiter; a missing path, a folder, a name Windows rejects (`what?.csv`) and a file another program holds open exclusively (Windows) each refused as itself; a reader fault reaching the caller with its line and the file; the size judged from the metadata before decoding; a file exactly at the limit read and one byte over refused; a source that never ends read to one byte over and no further; a non-text file named; the file untouched after a read (bytes and modified time); 100,000 rows read in full.
* Whole suites in the shared tree: `gx-contracts` **423 passed**, `gx-editor` **178 passed, 1 ignored** (the ignored test is the one that reads a real project by hand, from slice 119); `rustfmt --check` on both files clean; `check:boundaries` OK.
* Mutation check (`tools/mutate-csv-slice2.mjs`, my own two files mutated in place with backups restored byte for byte): **28 of 28 mutants caught** (`mutation-log-slice2.txt`, `mutation-log-slice2-rerun.txt`). The first run left two: C7 (a reorder on its own counted as "no change": the test never asked `is_none()` of a reorder-only change; it now does, and the words of that case, "columns the order changed", were reworded to "columns changed: the order changed") and S15 (the pattern did not match the formatted source: the pattern was fixed and the mutant is caught by the locked-file test). One mutant was made testable instead of excused: the "read one byte over the limit" guard could not be reached through a real file (it would have to grow between the check and the read), so it is the small `read_at_most` function with its own test on an endless reader.

## Not built, not verified

* Slice 3 (keeping a source in the project: the `Data/` folder in the `.gpx` layout, the copy, the data-source record, "Changed on disk", the previous revision) waits for codex's `project.rs`; I will not touch `project.rs` or the layout without codex releasing it and saying so. No shell command, no `Refusal` variant (the conformance refusal audit couples to that list), no codegen of `ColumnChange`, nothing in the Data panel yet. Row 11.153 stays active.
* Not run: the whole `npm run check` (others' work is in flight in the shared tree).
