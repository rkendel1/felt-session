import XCTest
@testable import OS1

/// Block-level parser coverage: tables, nested/task/ordered lists, and the
/// fallbacks that keep malformed input rendering as plain paragraphs.
final class MarkdownBlockTests: XCTestCase {
    func testPipeTableParses() {
        let blocks = MarkdownBlock.parse("""
        Intro line.

        | Name | Count | Share |
        |:-----|:-----:|------:|
        | iOS  | 20    | 51%   |
        | Mac  | 19    | 49%   |

        After.
        """)
        XCTAssertEqual(blocks.count, 3)
        guard case .table(let table) = blocks[1] else {
            return XCTFail("expected table, got \(blocks[1])")
        }
        XCTAssertEqual(table.headers, ["Name", "Count", "Share"])
        XCTAssertEqual(table.alignments, [.leading, .center, .trailing])
        XCTAssertEqual(table.rows, [["iOS", "20", "51%"], ["Mac", "19", "49%"]])
    }

    func testPipeLinesWithoutSeparatorStayParagraph() {
        let blocks = MarkdownBlock.parse("| just | pipes |\n| no separator |")
        XCTAssertEqual(blocks, [.paragraph("| just | pipes |\n| no separator |")])
    }

    func testRaggedRowsNormalizeToHeaderCount() {
        let blocks = MarkdownBlock.parse("""
        | A | B |
        |---|---|
        | 1 |
        | 1 | 2 | 3 |
        """)
        guard case .table(let table) = blocks.first else {
            return XCTFail("expected table")
        }
        XCTAssertEqual(table.rows, [["1", ""], ["1", "2"]])
    }

    func testEscapedPipeDoesNotSplitCell() {
        let blocks = MarkdownBlock.parse("| A |\n|---|\n| x \\| y |")
        guard case .table(let table) = blocks.first else {
            return XCTFail("expected table")
        }
        XCTAssertEqual(table.rows, [["x | y"]])
    }

    func testNestedAndMixedListStaysOneBlock() {
        let blocks = MarkdownBlock.parse("""
        1. First
           - detail one
           - detail two
        2. Second
        """)
        guard case .list(let items) = blocks.first, blocks.count == 1 else {
            return XCTFail("expected a single list block, got \(blocks)")
        }
        XCTAssertEqual(items.map(\.content), ["First", "detail one", "detail two", "Second"])
        XCTAssertEqual(items.map(\.ordinal), ["1.", nil, nil, "2."])
        XCTAssertEqual(items[0].indent, 0)
        XCTAssertGreaterThan(items[1].indent, 0)
    }

    func testTaskListCheckboxes() {
        let blocks = MarkdownBlock.parse("- [ ] todo\n- [x] done")
        guard case .list(let items) = blocks.first else {
            return XCTFail("expected list")
        }
        XCTAssertEqual(items.map(\.checkbox), [false, true])
        XCTAssertEqual(items.map(\.content), ["todo", "done"])
    }

    func testOrdinalKeepsSourceNumbering() {
        let blocks = MarkdownBlock.parse("7. seventh\n8. eighth")
        guard case .list(let items) = blocks.first else {
            return XCTFail("expected list")
        }
        XCTAssertEqual(items.map(\.ordinal), ["7.", "8."])
    }

    func testListContinuationLineJoinsItem() {
        let blocks = MarkdownBlock.parse("- item one\n  wrapped tail\nplain paragraph")
        XCTAssertEqual(blocks.count, 2)
        guard case .list(let items) = blocks[0] else {
            return XCTFail("expected list")
        }
        XCTAssertEqual(items, [MarkdownListItem(
            indent: 0, ordinal: nil, checkbox: nil, content: "item one\nwrapped tail"
        )])
        XCTAssertEqual(blocks[1], .paragraph("plain paragraph"))
    }

    func testCodeFenceStillWins() {
        let blocks = MarkdownBlock.parse("```swift\n| not | a table |\n```")
        XCTAssertEqual(blocks, [.codeBlock(code: "| not | a table |", language: "swift")])
    }

    func testTableDirectlyAfterParagraphKeepsOrder() {
        let blocks = MarkdownBlock.parse("Results:\n| A |\n|---|\n| 1 |")
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[0], .paragraph("Results:"))
        guard case .table = blocks[1] else {
            return XCTFail("expected table second")
        }
    }
}
