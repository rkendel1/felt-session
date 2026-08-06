import XCTest
@testable import OS1

/// Sidebar hides and pins are shared with the web client through `/api/hides`
/// and `/api/pins`, so the row keys this app writes (`SidebarRowKeys`) must be
/// exactly the ones the web sidebar uses.
final class HideStoreTests: XCTestCase {
    private func sessions(_ json: String) throws -> [Session] {
        try JSONDecoder().decode([Session].self, from: Data(json.utf8))
    }

    func testRowKeyUsesTheWebKeyForEachRowShape() throws {
        let rows = SessionsListViewModel.sidebarWorkspaces(
            in: try sessions(
                """
                [{"id":"bks-1","workspaceId":"ws-1"},
                 {"id":"bks-2","worktreeDir":"/home/u/worktrees/feature"},
                 {"id":"bks-3"}]
                """
            )
        )

        XCTAssertEqual(rows.map(SidebarRowKeys.rowKey(for:)), [
            "workspace:ws-1",
            "wt:/home/u/worktrees/feature",
            "bks-3",
        ])
    }

    func testCandidateKeysCoverEveryRowASessionCanSitUnder() throws {
        let session = try sessions(
            #"[{"id":"bks-1","workspaceId":"ws-1","worktreeDir":"/home/u/worktrees/feature"}]"#
        )[0]

        XCTAssertEqual(SidebarRowKeys.candidateKeys(for: session), [
            "bks-1",
            "workspace:ws-1",
            "wt:/home/u/worktrees/feature",
        ])
    }

    func testBlockedSessionResurfacesItsHiddenRow() throws {
        let all = try sessions(
            """
            [{"id":"bks-1","workspaceId":"ws-1","waitingForInput":true},
             {"id":"bks-2","workspaceId":"ws-2"}]
            """
        )

        let prepared = SessionsListViewModel.prepared(
            all,
            hiding: [],
            restoring: [],
            hidden: ["workspace:ws-1", "workspace:ws-2"]
        )

        XCTAssertEqual(prepared.resurfacedHideKeys, ["workspace:ws-1"])
    }

    func testQuietSessionsResurfaceNothing() throws {
        let all = try sessions(#"[{"id":"bks-1","workspaceId":"ws-1","isRunning":true}]"#)

        let prepared = SessionsListViewModel.prepared(
            all,
            hiding: [],
            restoring: [],
            hidden: ["workspace:ws-1"]
        )

        XCTAssertTrue(prepared.resurfacedHideKeys.isEmpty)
    }

    func testArchivedBlockedSessionDoesNotResurfaceItsRow() throws {
        let all = try sessions(
            #"[{"id":"bks-1","workspaceId":"ws-1","waitingForInput":true,"archived":true}]"#
        )

        let prepared = SessionsListViewModel.prepared(
            all,
            hiding: [],
            restoring: [],
            hidden: ["workspace:ws-1"]
        )

        XCTAssertTrue(prepared.resurfacedHideKeys.isEmpty)
    }
}
