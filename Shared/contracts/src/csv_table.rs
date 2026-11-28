//! A strict CSV table reader (Panchayati task 121, first slice; plan rows 11.153, 19.4 and 6.9 use it).
//!
//! A CSV file is whatever Excel, Google Sheets, a newsroom system or a hand editor wrote, and it leaves many things open. This reader closes
//! them the way the project's rules ask: **nothing is guessed, nothing is silently changed, every refusal is named and says where** (invariants
//! 17 and 18). The choices were put to Jev and Laya before it was built (`docs/evidence/11.153/jev-laya-csv.json`); Jev chose each:
//!
//!  * **The caller states the delimiter** (comma, semicolon or tab). It is never detected. When the header comes out as one column and its
//!    first line plainly uses another delimiter, the refusal says which one it looks like.
//!  * **UTF-8 only.** A leading byte order mark is removed. UTF-16 and a Windows code page are refused by name, with what they look like,
//!    and nothing is decoded by guessing. Text comes back exactly: a Devanagari name is the same bytes it was.
//!  * **Cells are exactly the text in the file after unquoting.** No trimming, no case change, no Unicode normalisation, no number, date or
//!    yes/no parsing: a leading zero stays. Types come from the graphic's own fields (row 11.54), not from the cells.
//!  * **The header row names the columns, and the names are the binding keys**, so an empty (or blank) name and a repeated name are refused,
//!    and never renamed.
//!  * **A row with more or fewer cells than the header is refused** with its line number, never padded or cut.
//!  * **Blank lines are allowed only at the end of the file.** One anywhere else is refused with its line number, because it is probably an
//!    editing slip and dropping it would drop a row someone expected. (A one-column file writes an empty cell as `""`: a bare empty line is a
//!    blank line.)
//!  * **Quotes are RFC 4180:** a quote opens a whole cell and closes it, `""` is a quote inside, and a cell may hold the delimiter and line
//!    breaks. A quote anywhere else, or text after a closing quote, or a quote never closed, is refused with its line number.
//!  * **Limits are stated and refused above**, never read in part as if they were the whole: file size, rows, columns and bytes in a cell.
//!
//! Line numbers count physical lines of the file from 1, so a cell that spans lines moves the count, and a record's line is where it starts.
//! Line endings are CRLF, LF or CR; a line break inside a quoted cell is kept exactly as written.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// The character that separates cells. Always stated by the caller.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Delimiter {
    Comma,
    Semicolon,
    Tab,
}

impl Delimiter {
    /// The delimiters, in the order a refusal that looks for the other one considers them.
    pub const ALL: [Delimiter; 3] = [Delimiter::Comma, Delimiter::Semicolon, Delimiter::Tab];

    pub const fn character(self) -> char {
        match self {
            Delimiter::Comma => ',',
            Delimiter::Semicolon => ';',
            Delimiter::Tab => '\t',
        }
    }

    const fn index(self) -> usize {
        match self {
            Delimiter::Comma => 0,
            Delimiter::Semicolon => 1,
            Delimiter::Tab => 2,
        }
    }

    const fn word(self) -> &'static str {
        match self {
            Delimiter::Comma => "comma",
            Delimiter::Semicolon => "semicolon",
            Delimiter::Tab => "tab",
        }
    }
}

/// What the reader will read. A file above any of them is refused, never read in part.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct CsvLimits {
    /// The file, in bytes.
    pub max_bytes: u32,
    /// Data rows (the header is not one).
    pub max_rows: u32,
    pub max_columns: u32,
    /// One cell, in bytes of UTF-8.
    pub max_cell_bytes: u32,
}

impl Default for CsvLimits {
    fn default() -> Self {
        Self {
            max_bytes: 16 * 1024 * 1024,
            max_rows: 100_000,
            max_columns: 256,
            max_cell_bytes: 64 * 1024,
        }
    }
}

/// A table: the header's column names and the data rows, every cell exactly as written.
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TextTable {
    pub columns: Vec<String>,
    /// Each row has exactly as many cells as there are columns.
    pub rows: Vec<Vec<String>>,
}

/// Which limit a file went over.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Limit {
    FileBytes,
    Rows,
    Columns,
    CellBytes,
}

impl Limit {
    const fn words(self) -> &'static str {
        match self {
            Limit::FileBytes => "the file size in bytes",
            Limit::Rows => "the number of rows",
            Limit::Columns => "the number of columns",
            Limit::CellBytes => "the size of a cell in bytes",
        }
    }
}

/// What bytes that are not UTF-8 look like.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum LooksLike {
    Utf16LittleEndian,
    Utf16BigEndian,
    WindowsCodePage,
}

/// Why a file was not read. Each says where, in the file's own lines.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(
    tag = "fault",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum CsvFault {
    /// The bytes are not UTF-8. `valid_up_to` is the offset of the first byte that is not.
    NotUtf8 {
        looks_like: LooksLike,
        valid_up_to: u32,
    },
    /// There is no header row: the file is empty, or only blank lines.
    Empty,
    /// A blank line that is not at the end of the file.
    BlankLine { line: u32 },
    /// A column's name is empty or only spaces. `column` counts from 1.
    EmptyColumnName { line: u32, column: u32 },
    /// Two columns have the same name.
    DuplicateColumnName {
        name: String,
        first_column: u32,
        column: u32,
    },
    /// A row has a different number of cells from the header.
    RaggedRow {
        line: u32,
        expected: u32,
        found: u32,
    },
    /// A quote that is not at the start of a cell, or text after the quote that closed one.
    StrayQuote { line: u32, column: u32 },
    /// A quote that opens on `line` is never closed.
    UnterminatedQuote { line: u32 },
    /// The header is one column as stated, and its first line looks like it uses another delimiter.
    WrongDelimiter {
        stated: Delimiter,
        looks_like: Delimiter,
    },
    /// The file is over a limit. `found` is the size at which reading stopped.
    TooLarge {
        limit: Limit,
        allowed: u32,
        found: u32,
    },
}

impl std::fmt::Display for CsvFault {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotUtf8 { looks_like, valid_up_to } => {
                let what = match looks_like {
                    LooksLike::Utf16LittleEndian => "UTF-16 (little endian)",
                    LooksLike::Utf16BigEndian => "UTF-16 (big endian)",
                    LooksLike::WindowsCodePage => "a Windows code page",
                };
                write!(f, "the file is not UTF-8 (it looks like {what}; the first byte that is not text is at {valid_up_to}): save it as \"CSV UTF-8\" and try again")
            }
            Self::Empty => write!(f, "the file has no header row"),
            Self::BlankLine { line } => write!(f, "line {line} is blank: blank lines are only allowed at the end of the file; remove it, or write an empty cell as \"\""),
            Self::EmptyColumnName { line, column } => write!(f, "the name of column {column} (line {line}) is empty: every column needs a name, because names are what fields bind to"),
            Self::DuplicateColumnName { name, first_column, column } => write!(f, "column {column} is called \"{name}\", as column {first_column} is: column names must differ"),
            Self::RaggedRow { line, expected, found } => write!(f, "line {line} has {found} cells and the header has {expected}"),
            Self::StrayQuote { line, column } => write!(f, "line {line}, cell {column}: a quote must open and close a whole cell (\"...\"), not sit inside one"),
            Self::UnterminatedQuote { line } => write!(f, "the quote that opens on line {line} is never closed"),
            Self::WrongDelimiter { stated, looks_like } => write!(
                f,
                "the first line is one column as {}-separated, but it looks {}-separated: choose {} as the delimiter, or quote the header",
                stated.word(),
                looks_like.word(),
                looks_like.word()
            ),
            Self::TooLarge { limit, allowed, found } => write!(f, "the file is too large to read in full: {} is limited to {allowed} (reached {found}); nothing was read", limit.words()),
        }
    }
}

impl std::error::Error for CsvFault {}

/// How one list of column names differs from another (the columns a source had, and the columns an updated file has). Names are compared
/// exactly. A rename is never guessed: it is one column removed and one added, so a field bound to the old name is named, not carried over
/// (Jev, `docs/evidence/11.153/jev-laya-source.json`). A change is a named event and never applied silently (plan row 19.2).
#[derive(Debug, Clone, PartialEq, Eq, Default, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ColumnChange {
    /// In the new list and not the old, in the new list's order.
    pub added: Vec<String>,
    /// In the old list and not the new, in the old list's order.
    pub removed: Vec<String>,
    /// The columns in both appear in a different order.
    pub reordered: bool,
}

impl ColumnChange {
    pub fn is_none(&self) -> bool {
        self.added.is_empty() && self.removed.is_empty() && !self.reordered
    }
}

impl std::fmt::Display for ColumnChange {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        if self.is_none() {
            return write!(f, "the columns are the same");
        }
        let quoted = |names: &[String]| {
            names
                .iter()
                .map(|name| format!("\"{name}\""))
                .collect::<Vec<_>>()
                .join(", ")
        };
        let mut parts = Vec::new();
        if !self.added.is_empty() {
            parts.push(format!("added {}", quoted(&self.added)));
        }
        if !self.removed.is_empty() {
            parts.push(format!("removed {}", quoted(&self.removed)));
        }
        if self.reordered {
            parts.push("the order changed".to_owned());
        }
        write!(f, "columns changed: {}", parts.join("; "))
    }
}

/// What changed from the `old` column names to the `new` ones. Both lists are a reader's column names, so each name is unique in its list.
pub fn column_change(old: &[String], new: &[String]) -> ColumnChange {
    let in_old: std::collections::HashSet<&str> = old.iter().map(String::as_str).collect();
    let in_new: std::collections::HashSet<&str> = new.iter().map(String::as_str).collect();
    let kept_in_old = old.iter().filter(|name| in_new.contains(name.as_str()));
    let kept_in_new = new.iter().filter(|name| in_old.contains(name.as_str()));
    ColumnChange {
        added: new
            .iter()
            .filter(|name| !in_old.contains(name.as_str()))
            .cloned()
            .collect(),
        removed: old
            .iter()
            .filter(|name| !in_new.contains(name.as_str()))
            .cloned()
            .collect(),
        reordered: !kept_in_old.eq(kept_in_new),
    }
}

fn size(n: usize) -> u32 {
    u32::try_from(n).unwrap_or(u32::MAX)
}

const UTF8_BYTE_ORDER_MARK: [u8; 3] = [0xEF, 0xBB, 0xBF];

/// The bytes as text: a leading UTF-8 byte order mark removed, anything that is not UTF-8 refused with what it looks like.
fn decode(bytes: &[u8]) -> Result<&str, CsvFault> {
    // UTF-16 is refused first: ASCII text in UTF-16 has a zero in every other byte, and a zero is valid UTF-8, so it would otherwise be read as
    // text with NUL characters in it.
    if let Some((looks_like, at)) = utf16(bytes) {
        return Err(CsvFault::NotUtf8 {
            looks_like,
            valid_up_to: size(at),
        });
    }
    let body = bytes.strip_prefix(&UTF8_BYTE_ORDER_MARK).unwrap_or(bytes);
    let skipped = bytes.len() - body.len();
    std::str::from_utf8(body).map_err(|error| CsvFault::NotUtf8 {
        looks_like: LooksLike::WindowsCodePage,
        valid_up_to: size(skipped + error.valid_up_to()),
    })
}

/// Bytes that are plainly UTF-16: a UTF-16 byte order mark, or mostly zeros at every other byte (which parity says which end). The offset is where
/// the proof is: the mark at 0, or the first zero.
fn utf16(bytes: &[u8]) -> Option<(LooksLike, usize)> {
    if bytes.starts_with(&[0xFF, 0xFE]) {
        return Some((LooksLike::Utf16LittleEndian, 0));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        return Some((LooksLike::Utf16BigEndian, 0));
    }
    let sample = &bytes[..bytes.len().min(256)];
    if sample.len() < 4 {
        return None;
    }
    let zeros = |parity: usize| {
        sample
            .iter()
            .skip(parity)
            .step_by(2)
            .filter(|byte| **byte == 0)
            .count()
    };
    let (even, odd) = (zeros(0), zeros(1));
    let first_zero = sample.iter().position(|byte| *byte == 0)?;
    if odd * 3 >= sample.len() && odd > even {
        return Some((LooksLike::Utf16LittleEndian, first_zero));
    }
    if even * 3 >= sample.len() && even > odd {
        return Some((LooksLike::Utf16BigEndian, first_zero));
    }
    None
}

/// One record being read.
struct Record {
    start_line: u32,
    fields: Vec<String>,
    field: String,
    /// Some character of this cell has been read (a quote counts), so an empty `field` is a real empty cell, not nothing.
    field_started: bool,
    in_quotes: bool,
    /// A quote closed this cell: only a delimiter or a line end may follow.
    after_quote: bool,
    quote_line: u32,
}

impl Record {
    fn new(start_line: u32) -> Self {
        Self {
            start_line,
            fields: Vec::new(),
            field: String::new(),
            field_started: false,
            in_quotes: false,
            after_quote: false,
            quote_line: start_line,
        }
    }

    /// Anything of the record has been read: it is not a blank line.
    fn has_any(&self) -> bool {
        !self.fields.is_empty() || !self.field.is_empty() || self.field_started
    }
}

struct Reader<'a> {
    delimiter: Delimiter,
    limits: &'a CsvLimits,
    line: u32,
    columns: Vec<String>,
    rows: Vec<Vec<String>>,
    header_done: bool,
    /// The first blank line not yet known to be at the end of the file.
    pending_blank: Option<u32>,
    /// How many times each delimiter appeared unquoted in the header line (the stated one is not looked at).
    header_others: [u32; 3],
}

impl<'a> Reader<'a> {
    fn push(&self, record: &mut Record, character: char) -> Result<(), CsvFault> {
        record.field.push(character);
        record.field_started = true;
        if record.field.len() > self.limits.max_cell_bytes as usize {
            return Err(CsvFault::TooLarge {
                limit: Limit::CellBytes,
                allowed: self.limits.max_cell_bytes,
                found: size(record.field.len()),
            });
        }
        Ok(())
    }

    fn end_field(&self, record: &mut Record) -> Result<(), CsvFault> {
        record.fields.push(std::mem::take(&mut record.field));
        record.field_started = false;
        record.after_quote = false;
        if !self.header_done && record.fields.len() > self.limits.max_columns as usize {
            return Err(CsvFault::TooLarge {
                limit: Limit::Columns,
                allowed: self.limits.max_columns,
                found: size(record.fields.len()),
            });
        }
        Ok(())
    }

    /// A line end outside quotes: the record is complete (or blank).
    fn end_record(&mut self, mut record: Record) -> Result<(), CsvFault> {
        if !record.has_any() {
            self.pending_blank.get_or_insert(record.start_line);
            return Ok(());
        }
        self.end_field(&mut record)?;
        self.accept(record.start_line, record.fields)
    }

    fn accept(&mut self, line: u32, fields: Vec<String>) -> Result<(), CsvFault> {
        if let Some(blank) = self.pending_blank {
            return Err(CsvFault::BlankLine { line: blank });
        }
        if !self.header_done {
            return self.accept_header(line, fields);
        }
        if fields.len() != self.columns.len() {
            return Err(CsvFault::RaggedRow {
                line,
                expected: size(self.columns.len()),
                found: size(fields.len()),
            });
        }
        if self.rows.len() >= self.limits.max_rows as usize {
            return Err(CsvFault::TooLarge {
                limit: Limit::Rows,
                allowed: self.limits.max_rows,
                found: self.limits.max_rows.saturating_add(1),
            });
        }
        self.rows.push(fields);
        Ok(())
    }

    fn accept_header(&mut self, line: u32, fields: Vec<String>) -> Result<(), CsvFault> {
        let mut seen: HashMap<&str, usize> = HashMap::new();
        for (index, name) in fields.iter().enumerate() {
            if name.trim().is_empty() {
                return Err(CsvFault::EmptyColumnName {
                    line,
                    column: size(index + 1),
                });
            }
            if let Some(first) = seen.insert(name.as_str(), index) {
                return Err(CsvFault::DuplicateColumnName {
                    name: name.clone(),
                    first_column: size(first + 1),
                    column: size(index + 1),
                });
            }
        }
        if fields.len() == 1 {
            let (best, count) = Delimiter::ALL
                .iter()
                .map(|d| (*d, self.header_others[d.index()]))
                .max_by_key(|(_, count)| *count)
                .unwrap_or((self.delimiter, 0));
            if count > 0 && best != self.delimiter {
                return Err(CsvFault::WrongDelimiter {
                    stated: self.delimiter,
                    looks_like: best,
                });
            }
        }
        self.columns = fields;
        self.header_done = true;
        Ok(())
    }

    fn run(mut self, text: &str) -> Result<TextTable, CsvFault> {
        let delimiter = self.delimiter.character();
        let mut chars = text.chars().peekable();
        let mut record = Record::new(self.line);
        while let Some(c) = chars.next() {
            if record.in_quotes {
                match c {
                    '"' if chars.peek() == Some(&'"') => {
                        chars.next();
                        self.push(&mut record, '"')?;
                    }
                    '"' => {
                        record.in_quotes = false;
                        record.after_quote = true;
                    }
                    '\r' => {
                        self.push(&mut record, '\r')?;
                        if chars.peek() == Some(&'\n') {
                            chars.next();
                            self.push(&mut record, '\n')?;
                        }
                        self.line += 1;
                    }
                    '\n' => {
                        self.push(&mut record, '\n')?;
                        self.line += 1;
                    }
                    other => self.push(&mut record, other)?,
                }
                continue;
            }
            if c == '\r' || c == '\n' {
                if c == '\r' && chars.peek() == Some(&'\n') {
                    chars.next();
                }
                let finished = std::mem::replace(&mut record, Record::new(0));
                self.end_record(finished)?;
                self.line += 1;
                record = Record::new(self.line);
                continue;
            }
            if c == delimiter {
                self.end_field(&mut record)?;
                continue;
            }
            if record.after_quote {
                return Err(CsvFault::StrayQuote {
                    line: self.line,
                    column: size(record.fields.len() + 1),
                });
            }
            if c == '"' {
                if record.field_started {
                    return Err(CsvFault::StrayQuote {
                        line: self.line,
                        column: size(record.fields.len() + 1),
                    });
                }
                record.in_quotes = true;
                record.field_started = true;
                record.quote_line = self.line;
                continue;
            }
            if !self.header_done {
                if let Some(other) = Delimiter::ALL
                    .iter()
                    .find(|d| d.character() == c && **d != self.delimiter)
                {
                    self.header_others[other.index()] += 1;
                }
            }
            self.push(&mut record, c)?;
        }
        if record.in_quotes {
            return Err(CsvFault::UnterminatedQuote {
                line: record.quote_line,
            });
        }
        if record.has_any() {
            self.end_record(record)?;
        }
        if !self.header_done {
            return Err(CsvFault::Empty);
        }
        Ok(TextTable {
            columns: self.columns,
            rows: self.rows,
        })
    }
}

/// Read CSV bytes as a table, strictly (see the module's rules). `delimiter` is stated by the caller, never guessed.
pub fn parse_csv(
    bytes: &[u8],
    delimiter: Delimiter,
    limits: &CsvLimits,
) -> Result<TextTable, CsvFault> {
    if bytes.len() > limits.max_bytes as usize {
        return Err(CsvFault::TooLarge {
            limit: Limit::FileBytes,
            allowed: limits.max_bytes,
            found: size(bytes.len()),
        });
    }
    let text = decode(bytes)?;
    Reader {
        delimiter,
        limits,
        line: 1,
        columns: Vec::new(),
        rows: Vec::new(),
        header_done: false,
        pending_blank: None,
        header_others: [0; 3],
    }
    .run(text)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn read(text: &str) -> Result<TextTable, CsvFault> {
        parse_csv(text.as_bytes(), Delimiter::Comma, &CsvLimits::default())
    }

    fn table(columns: &[&str], rows: &[&[&str]]) -> TextTable {
        TextTable {
            columns: columns.iter().map(|c| (*c).to_owned()).collect(),
            rows: rows
                .iter()
                .map(|row| row.iter().map(|c| (*c).to_owned()).collect())
                .collect(),
        }
    }

    // ---- what is read ----------------------------------------------------------------------------------------------------------

    #[test]
    fn a_plain_file_is_its_header_and_its_rows() {
        assert_eq!(
            read("name,role\nArjun,Commentator\nPriya,Analyst\n"),
            Ok(table(
                &["name", "role"],
                &[&["Arjun", "Commentator"], &["Priya", "Analyst"]]
            ))
        );
    }

    #[test]
    fn a_header_alone_is_a_table_with_no_rows_and_the_last_line_needs_no_line_end() {
        assert_eq!(read("a,b"), Ok(table(&["a", "b"], &[])));
        assert_eq!(read("a,b\n"), Ok(table(&["a", "b"], &[])));
        assert_eq!(read("a,b\n1,2"), Ok(table(&["a", "b"], &[&["1", "2"]])));
    }

    #[test]
    fn text_comes_back_exactly_with_no_trimming_case_change_normalisation_or_number_parsing() {
        let hindi = "अर्जुन";
        let combining = "e\u{301}"; // e plus a combining acute: not normalised to a single character
        let source = format!("name,n,note\n{hindi},0012,  padded  \n{combining},1e3,=SUM(A1)\n");
        let got = read(&source).unwrap();
        assert_eq!(got.rows[0], [hindi, "0012", "  padded  "]);
        assert_eq!(got.rows[1], [combining, "1e3", "=SUM(A1)"]);
        assert_eq!(got.rows[1][0].chars().count(), 2, "not normalised");
    }

    #[test]
    fn the_three_line_endings_are_read_alike_and_may_be_mixed() {
        for ending in ["\n", "\r\n", "\r"] {
            let source = format!("a,b{ending}1,2{ending}3,4{ending}");
            assert_eq!(
                read(&source),
                Ok(table(&["a", "b"], &[&["1", "2"], &["3", "4"]])),
                "{ending:?}"
            );
        }
        assert_eq!(
            read("a,b\r\n1,2\n3,4\r5,6"),
            Ok(table(&["a", "b"], &[&["1", "2"], &["3", "4"], &["5", "6"]]))
        );
    }

    #[test]
    fn a_leading_utf8_byte_order_mark_is_removed_and_nothing_else_is() {
        let mut bytes = vec![0xEF, 0xBB, 0xBF];
        bytes.extend_from_slice("name,role\nA,B\n".as_bytes());
        assert_eq!(
            parse_csv(&bytes, Delimiter::Comma, &CsvLimits::default()),
            Ok(table(&["name", "role"], &[&["A", "B"]]))
        );
        // Exactly one is removed: a second is part of the first name; and one inside the file is a character like any other.
        let mut twice = vec![0xEF, 0xBB, 0xBF, 0xEF, 0xBB, 0xBF];
        twice.extend_from_slice("a,b\n\u{FEFF}x,y\n".as_bytes());
        assert_eq!(
            parse_csv(&twice, Delimiter::Comma, &CsvLimits::default()),
            Ok(table(&["\u{FEFF}a", "b"], &[&["\u{FEFF}x", "y"]]))
        );
    }

    #[test]
    fn quotes_are_rfc_4180_a_cell_may_hold_the_delimiter_a_quote_and_line_breaks() {
        let got = read("a,b\n\"x,y\",\"say \"\"hi\"\"\"\n\"line1\nline2\",\"cr\r\nlf\"\n").unwrap();
        assert_eq!(got.rows[0], ["x,y", "say \"hi\""]);
        assert_eq!(
            got.rows[1],
            ["line1\nline2", "cr\r\nlf"],
            "a line break inside quotes is kept exactly as written"
        );
    }

    #[test]
    fn an_empty_quoted_cell_and_an_empty_cell_are_both_empty_and_a_quote_can_hold_only_a_quote() {
        assert_eq!(
            read("a,b,c\n,\"\",x\n\"\"\"\",1,2\n"),
            Ok(table(
                &["a", "b", "c"],
                &[&["", "", "x"], &["\"", "1", "2"]]
            ))
        );
    }

    #[test]
    fn semicolon_and_tab_are_read_when_stated() {
        let limits = CsvLimits::default();
        assert_eq!(
            parse_csv(b"a;b\n1;2,5\n", Delimiter::Semicolon, &limits),
            Ok(table(&["a", "b"], &[&["1", "2,5"]]))
        );
        assert_eq!(
            parse_csv(b"a\tb\n1\t2;3\n", Delimiter::Tab, &limits),
            Ok(table(&["a", "b"], &[&["1", "2;3"]]))
        );
    }

    #[test]
    fn a_header_name_with_inner_spaces_is_kept_as_written() {
        assert_eq!(
            read(" Player Name ,Role\nx,y\n").unwrap().columns,
            [" Player Name ", "Role"]
        );
    }

    // ---- what is refused -------------------------------------------------------------------------------------------------------

    #[test]
    fn an_empty_file_or_one_of_blank_lines_has_no_header() {
        assert_eq!(read(""), Err(CsvFault::Empty));
        assert_eq!(read("\n\n\n"), Err(CsvFault::Empty));
        assert_eq!(read("\r\n"), Err(CsvFault::Empty));
    }

    #[test]
    fn blank_lines_at_the_end_are_ignored_and_anywhere_else_refused_with_their_line() {
        assert_eq!(
            read("a,b\n1,2\n\n\n"),
            Ok(table(&["a", "b"], &[&["1", "2"]]))
        );
        assert_eq!(
            read("a,b\n1,2\n\n3,4\n"),
            Err(CsvFault::BlankLine { line: 3 })
        );
        assert_eq!(
            read("\na,b\n1,2\n"),
            Err(CsvFault::BlankLine { line: 1 }),
            "before the header is not the end"
        );
        assert_eq!(
            read("a,b\n\n\n1,2\n"),
            Err(CsvFault::BlankLine { line: 2 }),
            "the first of several"
        );
    }

    #[test]
    fn a_one_column_file_writes_an_empty_cell_as_quotes_because_a_bare_empty_line_is_blank() {
        assert_eq!(
            read("name\nA\n\"\"\nB\n"),
            Ok(table(&["name"], &[&["A"], &[""], &["B"]]))
        );
        assert_eq!(read("name\nA\n\nB\n"), Err(CsvFault::BlankLine { line: 3 }));
    }

    #[test]
    fn a_ragged_row_is_refused_with_its_line_whether_short_or_long() {
        assert_eq!(
            read("a,b,c\n1,2,3\n4,5\n"),
            Err(CsvFault::RaggedRow {
                line: 3,
                expected: 3,
                found: 2
            })
        );
        assert_eq!(
            read("a,b\n1,2\n3,4,5\n"),
            Err(CsvFault::RaggedRow {
                line: 3,
                expected: 2,
                found: 3
            })
        );
        assert_eq!(
            read("a,b\n1\n"),
            Err(CsvFault::RaggedRow {
                line: 2,
                expected: 2,
                found: 1
            })
        );
    }

    #[test]
    fn line_numbers_count_the_lines_a_quoted_cell_spans() {
        // Line 2 is a record that spans lines 2 to 4; the ragged one starts on line 5.
        assert_eq!(
            read("a,b\n\"one\ntwo\nthree\",x\n1\n"),
            Err(CsvFault::RaggedRow {
                line: 5,
                expected: 2,
                found: 1
            })
        );
        // CRLF inside quotes counts once.
        assert_eq!(
            read("a,b\r\n\"one\r\ntwo\",x\r\n1\r\n"),
            Err(CsvFault::RaggedRow {
                line: 4,
                expected: 2,
                found: 1
            })
        );
    }

    #[test]
    fn an_empty_or_blank_column_name_is_refused_and_never_filled_in() {
        assert_eq!(
            read("a,,c\n1,2,3\n"),
            Err(CsvFault::EmptyColumnName { line: 1, column: 2 })
        );
        assert_eq!(
            read("a,   ,c\n1,2,3\n"),
            Err(CsvFault::EmptyColumnName { line: 1, column: 2 })
        );
        assert_eq!(
            read("a,b,\n1,2,3\n"),
            Err(CsvFault::EmptyColumnName { line: 1, column: 3 })
        );
    }

    #[test]
    fn a_repeated_column_name_is_refused_and_never_renamed() {
        assert_eq!(
            read("name,role,name\n1,2,3\n"),
            Err(CsvFault::DuplicateColumnName {
                name: "name".into(),
                first_column: 1,
                column: 3
            })
        );
        assert!(
            read("name,Name\n1,2\n").is_ok(),
            "names are the binding keys, compared exactly"
        );
    }

    #[test]
    fn a_stray_quote_text_after_a_closing_quote_and_an_unterminated_quote_are_refused() {
        assert_eq!(
            read("a,b\nx\"y,2\n"),
            Err(CsvFault::StrayQuote { line: 2, column: 1 })
        );
        assert_eq!(
            read("a,b\n1,\"x\"y\n"),
            Err(CsvFault::StrayQuote { line: 2, column: 2 })
        );
        assert_eq!(
            read("a,b\n\"x\" ,2\n"),
            Err(CsvFault::StrayQuote { line: 2, column: 1 }),
            "even a space after the closing quote"
        );
        assert_eq!(
            read("a,b\n1,\"never closed\n2,3\n"),
            Err(CsvFault::UnterminatedQuote { line: 2 })
        );
        // The quote's own line, not the record's: the record starts on line 2, a cell that spans lines comes first, the open quote is on line 3.
        assert_eq!(
            read("a,b\n\"one\ntwo\",\"never closed\n4,5\n"),
            Err(CsvFault::UnterminatedQuote { line: 3 })
        );
    }

    #[test]
    fn a_wrong_delimiter_is_refused_saying_which_one_the_header_looks_like() {
        let limits = CsvLimits::default();
        assert_eq!(
            parse_csv(b"name;role\nA;B\n", Delimiter::Comma, &limits),
            Err(CsvFault::WrongDelimiter {
                stated: Delimiter::Comma,
                looks_like: Delimiter::Semicolon
            })
        );
        assert_eq!(
            parse_csv(b"name,role\nA,B\n", Delimiter::Semicolon, &limits),
            Err(CsvFault::WrongDelimiter {
                stated: Delimiter::Semicolon,
                looks_like: Delimiter::Comma
            })
        );
        assert_eq!(
            parse_csv(b"name\trole\nA\tB\n", Delimiter::Comma, &limits),
            Err(CsvFault::WrongDelimiter {
                stated: Delimiter::Comma,
                looks_like: Delimiter::Tab
            })
        );
        // A header that really is one column is fine, and so is a one-column header that quotes its other delimiters.
        assert_eq!(
            parse_csv(b"name\nA\n", Delimiter::Comma, &limits),
            Ok(table(&["name"], &[&["A"]]))
        );
        assert_eq!(
            parse_csv(b"\"a;b\"\nA\n", Delimiter::Comma, &limits),
            Ok(table(&["a;b"], &[&["A"]]))
        );
    }

    #[test]
    fn bytes_that_are_not_utf8_are_refused_by_what_they_look_like() {
        let limits = CsvLimits::default();
        let utf16_le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("a,b\n1,2\n".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let utf16_be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("a,b\n1,2\n".encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        let no_bom_le: Vec<u8> = "name,role\nA,B\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect();
        let no_bom_be: Vec<u8> = "name,role\nA,B\n"
            .encode_utf16()
            .flat_map(u16::to_be_bytes)
            .collect();
        let latin1 = b"name,city\nJos\xE9,Z\xFCrich\n".to_vec();
        let looks = |bytes: &[u8]| match parse_csv(bytes, Delimiter::Comma, &limits) {
            Err(CsvFault::NotUtf8 { looks_like, .. }) => looks_like,
            other => panic!("expected NotUtf8, got {other:?}"),
        };
        assert_eq!(looks(&utf16_le), LooksLike::Utf16LittleEndian);
        assert_eq!(looks(&utf16_be), LooksLike::Utf16BigEndian);
        assert_eq!(looks(&no_bom_le), LooksLike::Utf16LittleEndian);
        assert_eq!(looks(&no_bom_be), LooksLike::Utf16BigEndian);
        assert_eq!(looks(&latin1), LooksLike::WindowsCodePage);
        assert_eq!(
            parse_csv(&latin1, Delimiter::Comma, &limits),
            Err(CsvFault::NotUtf8 {
                looks_like: LooksLike::WindowsCodePage,
                valid_up_to: 13
            }),
            "the offset of the byte that is not text"
        );
        let with_mark: Vec<u8> = [0xEF, 0xBB, 0xBF]
            .into_iter()
            .chain(latin1.iter().copied())
            .collect();
        assert_eq!(
            parse_csv(&with_mark, Delimiter::Comma, &limits),
            Err(CsvFault::NotUtf8 {
                looks_like: LooksLike::WindowsCodePage,
                valid_up_to: 16
            }),
            "an offset in the file, the mark counted"
        );
        assert_eq!(
            parse_csv(&no_bom_le, Delimiter::Comma, &limits),
            Err(CsvFault::NotUtf8 {
                looks_like: LooksLike::Utf16LittleEndian,
                valid_up_to: 1
            }),
            "UTF-16 with no mark: the first zero byte"
        );
        // A mark alone is proof, with no zero byte in the text to go by (Devanagari in UTF-16 has none).
        let hindi_le: Vec<u8> = [0xFF, 0xFE]
            .into_iter()
            .chain("नाम,भूमिका\n".encode_utf16().flat_map(u16::to_le_bytes))
            .collect();
        let hindi_be: Vec<u8> = [0xFE, 0xFF]
            .into_iter()
            .chain("नाम,भूमिका\n".encode_utf16().flat_map(u16::to_be_bytes))
            .collect();
        assert_eq!(
            parse_csv(&hindi_le, Delimiter::Comma, &limits),
            Err(CsvFault::NotUtf8 {
                looks_like: LooksLike::Utf16LittleEndian,
                valid_up_to: 0
            })
        );
        assert_eq!(
            parse_csv(&hindi_be, Delimiter::Comma, &limits),
            Err(CsvFault::NotUtf8 {
                looks_like: LooksLike::Utf16BigEndian,
                valid_up_to: 0
            })
        );
        // A zero inside otherwise ordinary UTF-8 is not UTF-16 and is not touched.
        assert_eq!(
            parse_csv(b"a,b\nx\0y,2\n", Delimiter::Comma, &limits),
            Ok(table(&["a", "b"], &[&["x\0y", "2"]]))
        );
    }

    #[test]
    fn each_limit_is_refused_by_name_with_the_size_it_was_stopped_at() {
        let small = |bytes, rows, columns, cell| CsvLimits {
            max_bytes: bytes,
            max_rows: rows,
            max_columns: columns,
            max_cell_bytes: cell,
        };
        let run =
            |text: &str, limits: &CsvLimits| parse_csv(text.as_bytes(), Delimiter::Comma, limits);
        assert_eq!(
            run("a,b\n1,2\n", &small(5, 10, 10, 10)),
            Err(CsvFault::TooLarge {
                limit: Limit::FileBytes,
                allowed: 5,
                found: 8
            })
        );
        assert_eq!(
            run("a\n1\n2\n3\n", &small(100, 2, 10, 10)),
            Err(CsvFault::TooLarge {
                limit: Limit::Rows,
                allowed: 2,
                found: 3
            })
        );
        assert_eq!(
            run("a,b,c,d\n1,2,3,4\n", &small(100, 10, 3, 10)),
            Err(CsvFault::TooLarge {
                limit: Limit::Columns,
                allowed: 3,
                found: 4
            })
        );
        assert_eq!(
            run("a\nabcdefgh\n", &small(100, 10, 10, 5)),
            Err(CsvFault::TooLarge {
                limit: Limit::CellBytes,
                allowed: 5,
                found: 6
            })
        );
        // Exactly at a limit is fine.
        assert!(run("a\n1\n2\n", &small(100, 2, 10, 10)).is_ok());
        assert!(run("a,b,c\n1,2,3\n", &small(100, 10, 3, 10)).is_ok());
        assert!(run("a,b\n1,2\n", &small(8, 10, 10, 10)).is_ok());
        assert!(run("a\nabcde\n", &small(100, 10, 10, 5)).is_ok());
        // A row longer than the header is a ragged row, whatever the column limit says.
        assert_eq!(
            run("a,b\n1,2,3,4,5\n", &small(100, 10, 3, 10)),
            Err(CsvFault::RaggedRow {
                line: 2,
                expected: 2,
                found: 5
            })
        );
        // A cell's limit is bytes of UTF-8, not characters: three Devanagari characters are nine bytes.
        assert_eq!(
            run("a\nअर्ज\n", &small(100, 10, 10, 8)).unwrap_err(),
            CsvFault::TooLarge {
                limit: Limit::CellBytes,
                allowed: 8,
                found: 9
            }
        );
    }

    #[test]
    fn the_default_limits_are_the_stated_ones() {
        assert_eq!(
            CsvLimits::default(),
            CsvLimits {
                max_bytes: 16 * 1024 * 1024,
                max_rows: 100_000,
                max_columns: 256,
                max_cell_bytes: 64 * 1024
            }
        );
    }

    #[test]
    fn a_fault_is_said_in_words_an_operator_can_act_on() {
        let say = |fault: CsvFault| fault.to_string();
        assert!(say(CsvFault::RaggedRow {
            line: 17,
            expected: 3,
            found: 2
        })
        .contains("line 17 has 2 cells and the header has 3"));
        assert!(say(CsvFault::BlankLine { line: 9 }).contains("write an empty cell as \"\""));
        assert!(say(CsvFault::NotUtf8 {
            looks_like: LooksLike::WindowsCodePage,
            valid_up_to: 4
        })
        .contains("CSV UTF-8"));
        assert!(say(CsvFault::WrongDelimiter {
            stated: Delimiter::Comma,
            looks_like: Delimiter::Semicolon
        })
        .contains("choose semicolon"));
        assert!(say(CsvFault::DuplicateColumnName {
            name: "role".into(),
            first_column: 2,
            column: 5
        })
        .contains("column 5 is called \"role\", as column 2 is"));
        assert!(say(CsvFault::TooLarge {
            limit: Limit::Rows,
            allowed: 100,
            found: 101
        })
        .contains("nothing was read"));
        // Each limit says what it limits, so an operator can tell which one a file went over.
        let over = |limit| {
            say(CsvFault::TooLarge {
                limit,
                allowed: 1,
                found: 2,
            })
        };
        assert!(
            over(Limit::FileBytes).contains("the file size in bytes is limited to 1 (reached 2)")
        );
        assert!(over(Limit::Rows).contains("the number of rows is limited to 1"));
        assert!(over(Limit::Columns).contains("the number of columns is limited to 1"));
        assert!(over(Limit::CellBytes).contains("the size of a cell in bytes is limited to 1"));
    }

    #[test]
    fn a_fault_serialises_with_its_name_and_fields_for_the_page() {
        let json = serde_json::to_value(CsvFault::RaggedRow {
            line: 4,
            expected: 3,
            found: 2,
        })
        .unwrap();
        assert_eq!(
            json,
            serde_json::json!({ "fault": "raggedRow", "line": 4, "expected": 3, "found": 2 })
        );
        let json = serde_json::to_value(CsvFault::DuplicateColumnName {
            name: "n".into(),
            first_column: 1,
            column: 2,
        })
        .unwrap();
        assert_eq!(json["firstColumn"], 1);
        assert_eq!(
            serde_json::to_value(Delimiter::Semicolon).unwrap(),
            "semicolon"
        );
    }

    // ---- the whole property: what a writer writes, the reader reads back exactly --------------------------------------------------

    /// A small deterministic generator, so a failure is the same failure every time.
    struct Rng(u64);

    impl Rng {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_F491_4F6C_DD1D)
        }
        fn below(&mut self, n: usize) -> usize {
            (self.next() % n as u64) as usize
        }
    }

    const TRICKY: &[&str] = &[
        "",
        " ",
        "a",
        "  lead",
        "trail  ",
        "a,b",
        "a;b",
        "a\tb",
        "say \"hi\"",
        "\"",
        "\"\"",
        ",",
        ";",
        "\t",
        "line1\nline2",
        "line1\r\nline2",
        "a\rb",
        "अर्जुन",
        "٣٤٥",
        "😀 emoji",
        "0012",
        "1e3",
        "=SUM(A1)",
        "#N/A",
        "e\u{301}",
        "\u{FEFF}inner bom",
        "a  b",
        "x\ny\n",
        "\n",
        "\r\n",
    ];

    fn write(table: &TextTable, delimiter: Delimiter, rng: &mut Rng) -> String {
        let d = delimiter.character();
        let one_column = table.columns.len() == 1;
        let ending = ["\n", "\r\n", "\r"][rng.below(3)];
        // A one-column header that holds another delimiter must be quoted, or the reader (rightly) takes the file for the wrong delimiter.
        let any_delimiter = |c: char| Delimiter::ALL.iter().any(|d| d.character() == c);
        let cell = |text: &str, header: bool, rng: &mut Rng| -> String {
            let must = text.is_empty() && one_column
                || text
                    .chars()
                    .any(|c| c == d || c == '"' || c == '\n' || c == '\r')
                || header && one_column && text.chars().any(any_delimiter);
            if must || rng.below(4) == 0 {
                format!("\"{}\"", text.replace('"', "\"\""))
            } else {
                text.to_owned()
            }
        };
        let mut out = String::new();
        let line = |cells: &[String], header: bool, rng: &mut Rng, out: &mut String| {
            let joined: Vec<String> = cells.iter().map(|c| cell(c, header, rng)).collect();
            out.push_str(&joined.join(&d.to_string()));
        };
        line(&table.columns, true, rng, &mut out);
        for row in &table.rows {
            out.push_str(ending);
            line(row, false, rng, &mut out);
        }
        if rng.below(2) == 0 {
            out.push_str(ending);
            for _ in 0..rng.below(3) {
                out.push_str(ending);
            }
        }
        out
    }

    #[test]
    fn what_a_writer_writes_the_reader_reads_back_exactly_for_thousands_of_random_tables() {
        let mut rng = Rng(0x9E37_79B9_7F4A_7C15);
        for case in 0..4000 {
            let columns = 1 + rng.below(6);
            // A file that begins with U+FEFF begins with a byte order mark, so a first column name cannot (see the test of the mark above).
            let names: Vec<String> = (0..columns)
                .map(|n| {
                    format!(
                        "{}{n}",
                        TRICKY[3 + rng.below(TRICKY.len() - 3)]
                            .replace(['\n', '\r'], "_")
                            .replace(' ', "_")
                            .replace('\u{FEFF}', "_")
                    )
                })
                .collect();
            let rows: Vec<Vec<String>> = (0..rng.below(25))
                .map(|_| {
                    (0..columns)
                        .map(|_| TRICKY[rng.below(TRICKY.len())].to_owned())
                        .collect()
                })
                .collect();
            let original = TextTable {
                columns: names,
                rows,
            };
            let delimiter = Delimiter::ALL[rng.below(3)];
            let text = write(&original, delimiter, &mut rng);
            let got = parse_csv(text.as_bytes(), delimiter, &CsvLimits::default());
            assert_eq!(
                got.as_ref(),
                Ok(&original),
                "case {case}, {delimiter:?}, written as {text:?}"
            );
        }
    }

    // ---- a changed set of columns is named, never guessed ------------------------------------------------------------------------

    fn names(list: &[&str]) -> Vec<String> {
        list.iter().map(|name| (*name).to_owned()).collect()
    }

    #[test]
    fn the_same_columns_are_no_change() {
        let same = names(&["name", "role", "team"]);
        let change = column_change(&same, &same);
        assert_eq!(change, ColumnChange::default());
        assert!(change.is_none());
        assert_eq!(change.to_string(), "the columns are the same");
        assert!(column_change(&[], &[]).is_none());
    }

    #[test]
    fn added_and_removed_columns_are_named_in_their_own_lists_order() {
        let old = names(&["name", "role", "team"]);
        let change = column_change(&old, &names(&["name", "country", "role", "team", "age"]));
        assert_eq!(change.added, ["country", "age"]);
        assert!(change.removed.is_empty());
        assert!(
            !change.reordered,
            "a column added in the middle does not reorder the ones kept"
        );
        let change = column_change(&old, &names(&["name"]));
        assert_eq!(change.removed, ["role", "team"]);
        assert!(change.added.is_empty() && !change.reordered);
    }

    #[test]
    fn a_rename_is_one_removed_and_one_added_and_never_a_match() {
        let change = column_change(&names(&["name", "role"]), &names(&["name", "position"]));
        assert_eq!(change.removed, ["role"]);
        assert_eq!(change.added, ["position"]);
        assert!(!change.reordered);
        // Names are exact: case and spaces make a different column.
        let change = column_change(&names(&["Name"]), &names(&["name"]));
        assert_eq!(
            (change.removed, change.added),
            (names(&["Name"]), names(&["name"]))
        );
        let change = column_change(&names(&["name"]), &names(&["name "]));
        assert_eq!(
            (change.removed, change.added),
            (names(&["name"]), names(&["name "]))
        );
    }

    #[test]
    fn a_different_order_of_the_columns_kept_is_reordered_and_nothing_else() {
        let change = column_change(&names(&["a", "b", "c"]), &names(&["c", "a", "b"]));
        assert_eq!(
            change,
            ColumnChange {
                added: vec![],
                removed: vec![],
                reordered: true
            }
        );
        // A different order is a change on its own, and is said so.
        assert!(!change.is_none());
        assert_eq!(change.to_string(), "columns changed: the order changed");
        // Reordered is about the columns in both, whatever was added or removed around them.
        let change = column_change(&names(&["a", "b", "c"]), &names(&["b", "x", "a"]));
        assert_eq!(
            change,
            ColumnChange {
                added: names(&["x"]),
                removed: names(&["c"]),
                reordered: true
            }
        );
        let change = column_change(&names(&["a", "b", "c"]), &names(&["a", "x", "c"]));
        assert!(!change.reordered, "b is gone; a and c keep their order");
    }

    #[test]
    fn a_column_change_is_said_in_words_and_serialises_for_the_page() {
        let change = column_change(
            &names(&["name", "role", "team"]),
            &names(&["team", "name", "country"]),
        );
        assert_eq!(
            change.to_string(),
            "columns changed: added \"country\"; removed \"role\"; the order changed"
        );
        assert_eq!(
            column_change(&names(&["a"]), &names(&["a", "b", "c"])).to_string(),
            "columns changed: added \"b\", \"c\""
        );
        assert_eq!(
            serde_json::to_value(&change).unwrap(),
            serde_json::json!({ "added": ["country"], "removed": ["role"], "reordered": true })
        );
    }

    #[test]
    fn a_column_change_matches_how_a_list_was_made_for_thousands_of_random_edits() {
        let mut rng = Rng(0xD1B5_4A32_D192_ED03);
        for case in 0..3000 {
            let old: Vec<String> = (0..rng.below(8)).map(|n| format!("c{n}")).collect();
            // Keep some, drop the rest, shuffle the kept ones or not, then add new names at random places.
            let mut kept: Vec<String> = old.iter().filter(|_| rng.below(3) != 0).cloned().collect();
            let removed: Vec<String> = old
                .iter()
                .filter(|name| !kept.contains(name))
                .cloned()
                .collect();
            let shuffled = rng.below(2) == 0;
            if shuffled {
                for i in (1..kept.len()).rev() {
                    kept.swap(i, rng.below(i + 1));
                }
            }
            let mut new = kept.clone();
            let mut added = Vec::new();
            for n in 0..rng.below(4) {
                let name = format!("new{n}");
                new.insert(rng.below(new.len() + 1), name.clone());
                added.push(name);
            }
            let in_new_order: Vec<String> = new
                .iter()
                .filter(|name| added.contains(name))
                .cloned()
                .collect();
            let kept_in_old_order: Vec<String> = old
                .iter()
                .filter(|name| kept.contains(name))
                .cloned()
                .collect();
            let expected = ColumnChange {
                added: in_new_order,
                removed,
                reordered: kept != kept_in_old_order,
            };
            assert_eq!(
                column_change(&old, &new),
                expected,
                "case {case}: {old:?} -> {new:?}"
            );
        }
    }

    #[test]
    fn the_same_bytes_always_give_the_same_table() {
        let text = "a,b\n\"x\ny\",2\n3,4\n";
        assert_eq!(read(text), read(text));
    }

    #[test]
    fn a_hundred_thousand_rows_are_read_and_one_more_is_refused() {
        let mut text = String::from("id,name,role,team,score\n");
        for n in 0..100_000 {
            text.push_str(&format!("{n},Player {n},Analyst,Team Soul,{}\n", n % 97));
        }
        let got = read(&text).expect("100,000 rows are within the limit");
        assert_eq!(got.rows.len(), 100_000);
        assert_eq!(got.rows[99_999][1], "Player 99999");
        text.push_str("100000,Over,Analyst,Team Soul,1\n");
        assert_eq!(
            read(&text),
            Err(CsvFault::TooLarge {
                limit: Limit::Rows,
                allowed: 100_000,
                found: 100_001
            })
        );
    }
}
