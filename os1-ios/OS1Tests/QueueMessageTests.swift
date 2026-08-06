import XCTest
@testable import OS1

/// The queue carries agent-to-agent deliveries alongside what people type.
/// Their sentinels are HTML comments, which the transcript's markdown
/// renderer swallows and a plain-text chip does not — these pin the stripping
/// so a queued worker report never shows up as `<!--os:worker-report-->`.
final class QueueMessageTests: XCTestCase {
    private func present(_ content: String, user: String? = "Alex")
        -> QueueMessagePresentation
    {
        QueueMessagePresentation(content: content, user: user)
    }

    func testOrdinaryMessageIsUntouched() {
        let message = present("rebase this on main please")
        XCTAssertNil(message.label)
        XCTAssertEqual(message.body, "rebase this on main please")
        XCTAssertFalse(message.isGitHub)
    }

    /// The routing prefix is only stripped when a sentinel behind it proves
    /// the message is a delivery. A person is allowed to open a prompt with a
    /// bracket, and it must reach the chip intact.
    func testTypedMessageKeepsItsOwnBrackets() {
        XCTAssertEqual(present("[WIP] still drafting").body, "[WIP] still drafting")
        XCTAssertNil(present("[WIP] still drafting").label)
        XCTAssertEqual(present("[Kent] run the tests").body, "[Kent] run the tests")
    }

    func testWorkerReportIsLabelledAndStripped() {
        let message = present("[worker os-42] <!--os:worker-report-->\nInspection complete.")
        XCTAssertEqual(message.label, "🤖 Worker report")
        XCTAssertEqual(message.body, "Inspection complete.")
    }

    func testStackedSentinelsAreAllStripped() {
        let message = present(
            "<!--os:worker-report:os-42--><!--os:workflow-notice:wf-1-->\n✅ Workflow finished"
        )
        XCTAssertEqual(message.label, "🤖 Worker report")
        XCTAssertEqual(message.body, "✅ Workflow finished")
    }

    func testWorkflowNoticeKeepsItsAttributionOutOfTheBody() {
        let message = present(
            "[Alex Rivera] <!--os:workflow-notice:wf-1-->\n✅ Workflow \"review\" finished"
        )
        XCTAssertEqual(message.label, "⚙️ Workflow")
        XCTAssertEqual(message.body, "✅ Workflow \"review\" finished")
    }

    func testSessionNoticeIsLabelled() {
        let message = present("<!--os:session-notice-->\nHeads-up: the deploy is done.")
        XCTAssertEqual(message.label, "Heads-up from another session")
        XCTAssertEqual(message.body, "Heads-up: the deploy is done.")
    }

    func testHumanReplyCreditsTheTeammate() {
        let message = present("💬 **Kent** answered your question\n\nShip it.")
        XCTAssertEqual(message.label, "💬 Kent")
        XCTAssertEqual(message.body, "Ship it.")
    }

    func testGitHubDeliveryIsFlagged() {
        let message = present("PR #12 was reviewed", user: "GitHub")
        XCTAssertTrue(message.isGitHub)
        XCTAssertEqual(message.label, "GitHub")
        XCTAssertEqual(message.body, "PR #12 was reviewed")
    }
}
