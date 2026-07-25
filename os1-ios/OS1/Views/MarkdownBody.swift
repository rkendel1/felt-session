import SwiftUI

/// Lightweight markdown renderer for assistant messages. SwiftUI's built-in
/// `Text(markdown:)` only handles a single inline run — no headings, lists,
/// code blocks, or tables — so this splits the text into blocks first and
/// renders inline markdown (bold/italic/code/links) per block via
/// AttributedString. Both the block parse AND the inline AttributedString
/// conversions are memoized per unique text: `AttributedString(markdown:)`
/// is expensive, and rows re-enter the lazy stack constantly while
/// scrolling/streaming — uncached, every ~8Hz live-text flush re-parsed
/// every visible block on the main thread, which is what made the app hitch
/// during long streamed replies.
struct MarkdownBody: View {
    let text: String

    init(_ text: String) {
        self.text = text
    }

    var body: some View {
        let blocks = MarkdownParseCache.parse(text)
        VStack(alignment: .leading, spacing: 8) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { _, block in
                blockView(block)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func blockView(_ block: MarkdownBlock) -> some View {
        switch block {
        case .heading(let level, let content):
            inlineText(content)
                .font(headingFont(level))
                .padding(.top, 2)
        case .paragraph(let content):
            inlineText(content)
        case .codeBlock(let code, _):
            ScrollView(.horizontal, showsIndicators: false) {
                Text(code)
                    .font(.system(.caption, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .padding(10)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        case .list(let items):
            VStack(alignment: .leading, spacing: 4) {
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    listRow(item)
                }
            }
        case .blockquote(let content):
            HStack(alignment: .top, spacing: 8) {
                RoundedRectangle(cornerRadius: 1)
                    .fill(.quaternary)
                    .frame(width: 3)
                inlineText(content)
                    .foregroundStyle(.secondary)
            }
        case .divider:
            Divider()
        case .table(let table):
            MarkdownTableView(table: table)
        }
    }

    private func listRow(_ item: MarkdownListItem) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            listMarker(item)
            inlineText(item.content)
        }
        .padding(.leading, CGFloat(item.indent) * 14)
    }

    @ViewBuilder
    private func listMarker(_ item: MarkdownListItem) -> some View {
        if let checked = item.checkbox {
            Image(systemName: checked ? "checkmark.square.fill" : "square")
                .font(.footnote)
                .foregroundStyle(checked ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
        } else if let ordinal = item.ordinal {
            Text(ordinal)
                .foregroundStyle(.secondary)
                .monospacedDigit()
        } else {
            Text(bulletSymbol(item.indent))
                .foregroundStyle(.secondary)
        }
    }

    private func bulletSymbol(_ indent: Int) -> String {
        switch indent {
        case 0: "•"
        case 1: "◦"
        default: "▪"
        }
    }

    private func inlineText(_ content: String) -> some View {
        Text(MarkdownBody.inline(content))
            .textSelection(.enabled)
    }

    private func headingFont(_ level: Int) -> Font {
        switch level {
        case 1: .title3.weight(.bold)
        case 2: .headline
        default: .subheadline.weight(.semibold)
        }
    }

    /// Inline markdown (bold, italic, `code`, [links], ~~strikethrough~~)
    /// for one block's text, memoized — see `MarkdownInlineCache`.
    static func inline(_ text: String) -> AttributedString {
        MarkdownInlineCache.render(text)
    }

    /// The actual (expensive) conversion; only the cache calls this.
    static func parseInline(_ text: String) -> AttributedString {
        var options = AttributedString.MarkdownParsingOptions()
        options.interpretedSyntax = .inlineOnlyPreservingWhitespace
        return (try? AttributedString(markdown: text, options: options))
            ?? AttributedString(text)
    }
}

// MARK: - Tables

/// GitHub-style pipe table. Wide tables scroll horizontally like code
/// blocks; long cells wrap at a max column width instead of stretching the
/// table indefinitely.
private struct MarkdownTableView: View {
    let table: MarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 0, verticalSpacing: 0) {
                GridRow {
                    ForEach(Array(table.headers.enumerated()), id: \.offset) { column, header in
                        cell(header, column: column)
                            .font(.caption.weight(.semibold))
                            .gridColumnAlignment(gridAlignment(column))
                    }
                }
                .background(.fill.tertiary)
                ForEach(Array(table.rows.enumerated()), id: \.offset) { _, row in
                    Divider().gridCellUnsizedAxes(.horizontal)
                    GridRow {
                        ForEach(Array(row.enumerated()), id: \.offset) { column, content in
                            cell(content, column: column)
                                .font(.caption)
                        }
                    }
                }
            }
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(.quaternary)
            )
        }
    }

    private func cell(_ content: String, column: Int) -> some View {
        Text(MarkdownBody.inline(content))
            .textSelection(.enabled)
            .multilineTextAlignment(textAlignment(column))
            .frame(maxWidth: 300, alignment: frameAlignment(column))
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
    }

    private func columnAlignment(_ column: Int) -> MarkdownTable.ColumnAlignment {
        column < table.alignments.count ? table.alignments[column] : .leading
    }

    private func gridAlignment(_ column: Int) -> HorizontalAlignment {
        switch columnAlignment(column) {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func textAlignment(_ column: Int) -> TextAlignment {
        switch columnAlignment(column) {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }

    private func frameAlignment(_ column: Int) -> Alignment {
        switch columnAlignment(column) {
        case .leading: .leading
        case .center: .center
        case .trailing: .trailing
        }
    }
}

// MARK: - Block model + parser

/// One item of a (possibly nested, possibly mixed bullet/ordered) list.
/// `ordinal` carries the source numbering ("3.") so nested and split lists
/// keep the numbers the model wrote; `checkbox` is the GFM task-list state.
struct MarkdownListItem: Equatable {
    var indent: Int
    var ordinal: String?
    var checkbox: Bool?
    var content: String
}

/// A parsed GFM pipe table: header row, per-column alignment from the
/// separator row (`:---`, `:--:`, `---:`), body rows normalized to the
/// header's column count.
struct MarkdownTable: Equatable {
    enum ColumnAlignment: Equatable {
        case leading, center, trailing
    }

    var headers: [String]
    var alignments: [ColumnAlignment]
    var rows: [[String]]
}

/// Block-level markdown structure. Deliberately small: fenced code, headings,
/// lists (nested, ordered, task), blockquotes, dividers, pipe tables,
/// paragraphs. Everything else renders as a paragraph with inline styling.
enum MarkdownBlock: Equatable {
    case heading(level: Int, content: String)
    case paragraph(String)
    case codeBlock(code: String, language: String?)
    case list([MarkdownListItem])
    case blockquote(String)
    case divider
    case table(MarkdownTable)

    static func parse(_ text: String) -> [MarkdownBlock] {
        var blocks: [MarkdownBlock] = []
        var paragraph: [String] = []
        var listItems: [MarkdownListItem] = []
        var quote: [String] = []
        var tableLines: [String] = []
        var codeLines: [String] = []
        var codeLanguage: String?
        var inCode = false

        func flushParagraph() {
            if !paragraph.isEmpty {
                blocks.append(.paragraph(paragraph.joined(separator: "\n")))
                paragraph = []
            }
        }
        func flushList() {
            if !listItems.isEmpty {
                blocks.append(.list(listItems))
                listItems = []
            }
        }
        func flushQuote() {
            if !quote.isEmpty {
                blocks.append(.blockquote(quote.joined(separator: "\n")))
                quote = []
            }
        }
        func flushTable() {
            guard !tableLines.isEmpty else { return }
            if let table = buildTable(tableLines) {
                flushParagraph()
                blocks.append(.table(table))
            } else {
                // Pipe lines that never formed a valid table (no separator
                // row) are ordinary paragraph text.
                paragraph.append(contentsOf: tableLines)
            }
            tableLines = []
        }
        func flushAll() {
            flushTable()
            flushParagraph()
            flushList()
            flushQuote()
        }

        for rawLine in text.components(separatedBy: "\n") {
            let line = rawLine.trimmingCharacters(in: .whitespaces)

            if inCode {
                if line.hasPrefix("```") {
                    blocks.append(.codeBlock(
                        code: codeLines.joined(separator: "\n"),
                        language: codeLanguage
                    ))
                    codeLines = []
                    inCode = false
                } else {
                    codeLines.append(rawLine)
                }
                continue
            }

            if line.hasPrefix("```") {
                flushAll()
                inCode = true
                let lang = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces)
                codeLanguage = lang.isEmpty ? nil : lang
                continue
            }

            // Table rows accumulate until the first non-pipe line; validity
            // (second line must be a separator) is decided at flush.
            if line.hasPrefix("|") {
                flushList()
                flushQuote()
                tableLines.append(line)
                continue
            }
            flushTable()

            if line.isEmpty {
                flushAll()
                continue
            }

            if line == "---" || line == "***" || line == "___" {
                flushAll()
                blocks.append(.divider)
                continue
            }

            if let heading = parseHeading(line) {
                flushAll()
                blocks.append(heading)
                continue
            }

            if let item = parseListItem(rawLine, trimmed: line) {
                flushParagraph()
                flushQuote()
                listItems.append(item)
                continue
            }

            if line.hasPrefix(">") {
                flushParagraph()
                flushList()
                quote.append(String(line.dropFirst()).trimmingCharacters(in: .whitespaces))
                continue
            }

            // An indented line right under a list item is that item's
            // continuation (hard-wrapped content), not a new paragraph.
            if !listItems.isEmpty, indentWidth(rawLine) >= 2 {
                listItems[listItems.count - 1].content += "\n" + line
                continue
            }

            flushList()
            flushQuote()
            paragraph.append(rawLine)
        }

        if inCode, !codeLines.isEmpty {
            // Unterminated fence mid-stream: show what we have as code.
            blocks.append(.codeBlock(
                code: codeLines.joined(separator: "\n"),
                language: codeLanguage
            ))
        }
        flushAll()
        return blocks
    }

    private static func parseHeading(_ line: String) -> MarkdownBlock? {
        guard line.hasPrefix("#") else { return nil }
        let level = line.prefix(while: { $0 == "#" }).count
        guard level <= 6 else { return nil }
        let content = String(line.dropFirst(level)).trimmingCharacters(in: .whitespaces)
        guard !content.isEmpty else { return nil }
        return .heading(level: min(level, 3), content: content)
    }

    private static func parseListItem(
        _ rawLine: String, trimmed line: String
    ) -> MarkdownListItem? {
        let indent = min(indentWidth(rawLine) / 2, 5)
        for prefix in ["- ", "* ", "+ "] where line.hasPrefix(prefix) {
            var content = String(line.dropFirst(prefix.count))
            var checkbox: Bool?
            if content.hasPrefix("[ ] ") {
                checkbox = false
                content = String(content.dropFirst(4))
            } else if content.hasPrefix("[x] ") || content.hasPrefix("[X] ") {
                checkbox = true
                content = String(content.dropFirst(4))
            }
            return MarkdownListItem(
                indent: indent, ordinal: nil, checkbox: checkbox, content: content
            )
        }
        let digits = line.prefix(while: \.isNumber)
        guard !digits.isEmpty else { return nil }
        let rest = line.dropFirst(digits.count)
        guard rest.hasPrefix(". ") || rest.hasPrefix(") ") else { return nil }
        return MarkdownListItem(
            indent: indent,
            ordinal: "\(digits).",
            checkbox: nil,
            content: String(rest.dropFirst(2))
        )
    }

    /// Leading whitespace width of the raw line (tab counts as 2).
    private static func indentWidth(_ line: String) -> Int {
        var width = 0
        for character in line {
            if character == " " {
                width += 1
            } else if character == "\t" {
                width += 2
            } else {
                break
            }
        }
        return width
    }

    // MARK: Tables

    private static func buildTable(_ lines: [String]) -> MarkdownTable? {
        guard lines.count >= 2 else { return nil }
        guard let alignments = parseSeparator(lines[1]) else { return nil }
        let headers = splitTableRow(lines[0])
        guard !headers.isEmpty else { return nil }
        var normalizedAlignments = alignments
        while normalizedAlignments.count < headers.count {
            normalizedAlignments.append(.leading)
        }
        normalizedAlignments = Array(normalizedAlignments.prefix(headers.count))
        let rows = lines.dropFirst(2).map { line -> [String] in
            var cells = splitTableRow(line)
            while cells.count < headers.count { cells.append("") }
            return Array(cells.prefix(headers.count))
        }
        return MarkdownTable(
            headers: headers, alignments: normalizedAlignments, rows: Array(rows)
        )
    }

    /// The `|---|:--:|` row that makes pipe lines a table; returns each
    /// column's alignment, or nil when the line is not a valid separator.
    private static func parseSeparator(_ line: String) -> [MarkdownTable.ColumnAlignment]? {
        let cells = splitTableRow(line)
        guard !cells.isEmpty else { return nil }
        var alignments: [MarkdownTable.ColumnAlignment] = []
        for cell in cells {
            var body = Substring(cell)
            let leadingColon = body.hasPrefix(":")
            if leadingColon { body = body.dropFirst() }
            let trailingColon = body.hasSuffix(":")
            if trailingColon { body = body.dropLast() }
            guard !body.isEmpty, body.allSatisfy({ $0 == "-" }) else { return nil }
            switch (leadingColon, trailingColon) {
            case (true, true): alignments.append(.center)
            case (false, true): alignments.append(.trailing)
            default: alignments.append(.leading)
            }
        }
        return alignments
    }

    private static func splitTableRow(_ line: String) -> [String] {
        // Escaped pipes must not split cells; \u{1} never occurs in text.
        var content = line.trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: "\\|", with: "\u{1}")
        if content.hasPrefix("|") { content.removeFirst() }
        if content.hasSuffix("|") { content.removeLast() }
        return content.components(separatedBy: "|").map {
            $0.replacingOccurrences(of: "\u{1}", with: "|")
                .trimmingCharacters(in: .whitespaces)
        }
    }
}

// MARK: - Caches

/// Parsed-block memo. Rows re-enter the lazy stack constantly while
/// scrolling and their text never changes, so parsing once per unique text
/// turns every re-appearance into a dictionary hit. (The streaming bubble's
/// growing text misses by design — it's bounded by the ~8Hz flush.)
@MainActor
enum MarkdownParseCache {
    private static var blocks: [String: [MarkdownBlock]] = [:]
    private static var order: [String] = []

    static func parse(_ text: String) -> [MarkdownBlock] {
        if let hit = blocks[text] { return hit }
        let parsed = MarkdownBlock.parse(text)
        blocks[text] = parsed
        order.append(text)
        if order.count > 400 {
            for key in order.prefix(100) { blocks.removeValue(forKey: key) }
            order.removeFirst(100)
        }
        return parsed
    }
}

/// Inline-run memo — the load-bearing one. `AttributedString(markdown:)` is
/// far more expensive than the block split, and it used to run for EVERY
/// visible block on EVERY body evaluation: during a streamed reply the ~8Hz
/// live-text flush re-evaluated the transcript, so long sessions burned tens
/// of milliseconds of main-thread markdown parsing per flush and the UI
/// visibly hitched. Keyed by block content, so even the streaming bubble
/// only pays for its changing tail block — all earlier blocks hit.
@MainActor
enum MarkdownInlineCache {
    private static var rendered: [String: AttributedString] = [:]
    private static var order: [String] = []

    static func render(_ text: String) -> AttributedString {
        if let hit = rendered[text] { return hit }
        let value = MarkdownBody.parseInline(text)
        rendered[text] = value
        order.append(text)
        if order.count > 2000 {
            for key in order.prefix(500) { rendered.removeValue(forKey: key) }
            order.removeFirst(500)
        }
        return value
    }
}
