import XCTest
@testable import OS1

final class SessionTests: XCTestCase {
    func testMissingRepoUsesServerDefault() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"bks-1"}"#.utf8)
        )

        XCTAssertNil(session.repo)
        XCTAssertEqual(session.effectiveRepo, "opensession")
    }

    func testExplicitRepoIsPreserved() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"bks-1","repo":"backstage"}"#.utf8)
        )

        XCTAssertEqual(session.effectiveRepo, "backstage")
    }

    func testRepositoryOrderUsesFrequencyThenName() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"1","repo":"zebra"},{"id":"2","repo":"alpha"},{"id":"3","repo":"zebra"},{"id":"4","repo":"beta"},{"id":"5","repo":"alpha"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.repositoryOrder(in: sessions),
            ["alpha", "zebra", "beta"]
        )
    }

    func testRepositoryOrderHonorsPreferenceAndAppendsNewRepos() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"1","repo":"alpha"},{"id":"2","repo":"beta"},{"id":"3","repo":"gamma"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.repositoryOrder(
                in: sessions,
                preferredOrderJSON: #"["gamma","missing","alpha","gamma"]"#
            ),
            ["gamma", "alpha", "beta"]
        )
    }

    func testTabSessionsUseWorkspaceAndNaturalOrder() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"second","workspaceId":"ws-1","createdAt":"2026-07-02T00:00:00Z"},{"id":"other","workspaceId":"ws-2","createdAt":"2026-07-01T00:00:00Z"},{"id":"first","workspaceId":"ws-1","createdAt":"2026-07-01T00:00:00Z"},{"id":"archived","workspaceId":"ws-1","archived":true}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["first", "second"]
        )
    }

    func testClosingATabLandsOnItsNeighbour() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(#"[{"id":"one"},{"id":"two"},{"id":"three"}]"#.utf8)
        )

        // Closing a tab hands the strip to the one on its right …
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[0], in: sessions)?.id,
            "two"
        )
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[1], in: sessions)?.id,
            "three"
        )
        // … except the rightmost, which falls back to its left neighbour.
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[2], in: sessions)?.id,
            "two"
        )
        // The workspace's last session leaves nothing to show.
        XCTAssertNil(
            SessionsListViewModel.tabAfterClosing(sessions[0], in: [sessions[0]])
        )
        // A tab that already left the strip doesn't hand it to a phantom.
        XCTAssertEqual(
            SessionsListViewModel.tabAfterClosing(sessions[2], in: Array(sessions.prefix(2)))?.id,
            "one"
        )
    }

    func testTabSessionsFallBackToIsolatedWorktree() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"one","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"two","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"main","worktreeDir":"/home/ubuntu/projects/tella-backstage"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["one", "two"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[2]).map(\.id),
            ["main"]
        )
    }

    func testWorktreeFallbackIncludesWorkspaceAssignedSibling() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"readonly","worktreeDir":"/home/ubuntu/worktrees/feature"},{"id":"filed","workspaceId":"ws-1","worktreeDir":"/home/ubuntu/worktrees/feature"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[0]).map(\.id),
            ["filed", "readonly"]
        )
        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[1]).map(\.id),
            ["filed", "readonly"]
        )
    }

    func testSidebarCollapsesWorkspaceSessionsIntoOneRow() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","branch":"feature","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:01:00Z","opencodeSessionId":"oc-1"},{"id":"second","workspaceId":"ws-1","branch":"feature","createdAt":"2026-07-02T00:00:00Z","lastActivity":"2026-07-02T00:01:00Z"},{"id":"other","workspaceId":"ws-2","branch":"other"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(
            in: sessions,
            workspaceNames: ["ws-1": "Feature workspace"]
        )

        XCTAssertEqual(workspaces.count, 2)
        XCTAssertEqual(workspaces[0].title, "Feature workspace")
        XCTAssertEqual(workspaces[0].sessions.map(\.id), ["first", "second"])
        XCTAssertEqual(workspaces[0].mainSession.id, "first")
    }

    /// The names map arrives from its own request, so it is empty on a cold
    /// launch and stays empty whenever that request fails — which is what an
    /// app build outliving a rename of the endpoint it reads looks like. A
    /// workspace row degrades to the session's own title, never to its branch:
    /// the whole sidebar reading as machine slugs is how that failure surfaced.
    func testWorkspaceRowFallsBackToTheSessionTitleNotTheBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","branch":"feature/some-slug","title":"Add the yin yang spinner","worktreeDir":"/home/ubuntu/worktrees/spinner"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].title, "Add the yin yang spinner")
    }

    /// The other half of that rule: a legacy workspace-less row has no name to
    /// miss, so the branch remains its best identity — as on the web.
    func testWorktreeRowStillTitlesItselfByItsBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"legacy","branch":"feature/some-slug","title":"Add the yin yang spinner","worktreeDir":"/home/ubuntu/worktrees/spinner"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].title, "feature/some-slug")
    }

    func testSidebarDoesNotMergeDistinctWorkspacesSharingAPath() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","workspaceId":"ws-1","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"second","workspaceId":"ws-2","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"main-one","workspaceId":"ws-3","worktreeDir":"/home/ubuntu/projects/tella-backstage"},{"id":"main-two","workspaceId":"ws-4","worktreeDir":"/home/ubuntu/projects/tella-backstage"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 4)
        XCTAssertEqual(workspaces.map(\.sessions).map { $0.map(\.id) }, [
            ["first"], ["second"], ["main-one"], ["main-two"]
        ])
    }

    func testSidebarAdoptsWorkspacelessSiblingUsingTheSameWorktree() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"filed","workspaceId":"ws-1","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"},{"id":"legacy","worktreeDir":"/home/ubuntu/worktrees/shared","branch":"feature"}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.count, 1)
        XCTAssertEqual(workspaces[0].sessions.map(\.id), ["filed", "legacy"])
    }

    func testInboxBandsRankByActivityWithNeedsActionAndLiveRowsLifted() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"blocked","waitingForInput":true,"lastActivity":"2026-07-01T09:00:00Z"},{"id":"today-early","lastActivity":"2026-08-04T02:00:00Z"},{"id":"today-late","lastActivity":"2026-08-04T08:00:00Z"},{"id":"running-old","isRunning":true,"lastActivity":"2026-07-20T09:00:00Z"},{"id":"yesterday","lastActivity":"2026-08-03T23:00:00Z"},{"id":"earlier","lastActivity":"2026-08-01T10:00:00Z"}]"#.utf8
            )
        )
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!

        let bands = SessionsListViewModel.inboxBands(
            SessionsListViewModel.sidebarWorkspaces(in: sessions),
            now: try XCTUnwrap(Session.parseISO("2026-08-04T12:00:00Z")),
            calendar: calendar
        )

        XCTAssertEqual(bands.map(\.band), [.needsAction, .recent, .yesterday, .earlier])
        XCTAssertEqual(bands.map { $0.workspaces.map(\.mainSession.id) }, [
            ["blocked"],
            // A live row is recent whatever its day, but ranks by activity.
            ["today-late", "today-early", "running-old"],
            ["yesterday"],
            ["earlier"],
        ])
    }

    func testSidebarManualRenameWinsOverFallbackBranch() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"first","worktreeDir":"/home/ubuntu/worktrees/feature","branch":"feature"},{"id":"renamed","worktreeDir":"/home/ubuntu/worktrees/feature","branch":"feature","title":"Customer escalation","titleOverridden":true}]"#.utf8
            )
        )

        let workspaces = SessionsListViewModel.sidebarWorkspaces(in: sessions)

        XCTAssertEqual(workspaces.first?.title, "Customer escalation")
    }

    func testOptimisticSessionStaysMarkedAfterReceivingRealId() {
        let session = Session.optimistic(
            id: "bks-real",
            title: "New session",
            repo: "backstage",
            mode: "code",
            model: nil,
            effort: nil,
            fastMode: false,
            startedBy: "Alice"
        )

        XCTAssertTrue(session.isOptimisticPlaceholder == true)
    }

    func testTabSessionsPinStartedHumanSessionFirst() throws {
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"automation","workspaceId":"ws-1","automation":"Review","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:01:00Z","opencodeSessionId":"oc-1"},{"id":"main","workspaceId":"ws-1","createdAt":"2026-07-02T00:00:00Z","lastActivity":"2026-07-02T00:01:00Z","opencodeSessionId":"oc-2"},{"id":"shell","workspaceId":"ws-1","createdAt":"2026-07-03T00:00:00Z","lastActivity":"2026-07-03T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: sessions[1]).map(\.id),
            ["main", "automation", "shell"]
        )
    }

    func testTabSessionsUseLatestPolledWorkspaceMembership() throws {
        let stale = try JSONDecoder().decode(
            Session.self,
            from: Data(#"{"id":"current"}"#.utf8)
        )
        let sessions = try JSONDecoder().decode(
            [Session].self,
            from: Data(
                #"[{"id":"current","workspaceId":"ws-1","createdAt":"2026-07-01T00:00:00Z"},{"id":"sibling","workspaceId":"ws-1","createdAt":"2026-07-02T00:00:00Z"}]"#.utf8
            )
        )

        XCTAssertEqual(
            SessionsListViewModel.tabSessions(in: sessions, containing: stale).map(\.id),
            ["current", "sibling"]
        )
    }

    func testEmptyEngineIdStillCountsAsNeverRun() throws {
        let session = try JSONDecoder().decode(
            Session.self,
            from: Data(
                #"{"id":"shell","claudeSessionId":"","createdAt":"2026-07-01T00:00:00Z","lastActivity":"2026-07-01T00:00:00Z"}"#.utf8
            )
        )

        XCTAssertTrue(session.neverRan)
    }
}
