import XCTest
@testable import OS1

/// State-machine tests for `SessionViewModel.handle`: the dedupe dance between
/// the ephemeral stream channel (stream_text / stream_tool_*) and the durable
/// transcript channel (transcript_append / resync transcript_init) is where
/// every "text renders twice" bug has lived — each case here pins one of them.
@MainActor
final class SessionViewModelTests: XCTestCase {
    private let serverA = SessionViewModelCache.Scope(serverURL: "server-a", token: "token-a")
    private let serverB = SessionViewModelCache.Scope(serverURL: "server-b", token: "token-b")

    private func makeViewModel() -> SessionViewModel {
        SessionViewModel(session: Session(id: "bks-1"))
    }

    private func entry(
        _ id: String, _ type: String, text: String? = nil, toolUseId: String? = nil
    ) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text, toolUseId: toolUseId)
    }

    func testPageCacheReusesLoadedConversationAndRefreshesSessionSnapshot() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(for: Session(id: "bks-1", title: "Old"), scope: serverA)
        first.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("e1", "assistant", text: "Already loaded")],
            cursor: .empty
        ))

        let reopened = cache.viewModel(
            for: Session(id: "bks-1", title: "Updated"),
            scope: serverA
        )

        XCTAssertTrue(first === reopened)
        XCTAssertFalse(reopened.isLoadingConversation)
        XCTAssertEqual(reopened.entries.map(\.id), ["e1"])
        XCTAssertEqual(reopened.session.title, "Updated")
    }

    func testPageCacheEvictsLeastRecentlyUsedConversation() {
        let cache = SessionViewModelCache(capacity: 2)
        _ = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-2"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        _ = cache.viewModel(for: Session(id: "bks-3"), scope: serverA)

        XCTAssertEqual(cache.cachedSessionIds, ["bks-1", "bks-3"])
    }

    func testPageCacheDoesNotCrossServerScope() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(for: Session(id: "bks-1"), scope: serverA)
        let otherServer = cache.viewModel(for: Session(id: "bks-1"), scope: serverB)

        XCTAssertFalse(first === otherServer)
        XCTAssertEqual(cache.cachedSessionIds, ["bks-1"])
    }

    func testCachedConversationReconcilesOperationalStateWhileStopped() {
        let cache = SessionViewModelCache(capacity: 2)
        let first = cache.viewModel(
            for: Session(
                id: "bks-1", model: "old", effort: "low",
                fastMode: false, isRunning: true, queuedCount: 2
            ),
            scope: serverA
        )
        first.stop()

        let reopened = cache.viewModel(
            for: Session(
                id: "bks-1", model: "new", effort: "high",
                fastMode: true, isRunning: false, queuedCount: 0
            ),
            scope: serverA
        )

        XCTAssertFalse(reopened.isRunning)
        XCTAssertEqual(reopened.queuedCount, 0)
        XCTAssertEqual(reopened.model, "new")
        XCTAssertEqual(reopened.effort, "high")
        XCTAssertTrue(reopened.fastMode)
    }

    func testResyncDropsCachedPartialPrefixOfOffscreenCompletion() {
        let viewModel = makeViewModel()
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Partial repl"))
        viewModel.stop()
        viewModel.updateSessionSnapshot(Session(id: "bks-1", isRunning: false))

        var snapshot = [entry(
            "e1", "assistant", text: "Partial reply completed off-screen"
        )]
        snapshot += (2...20).map {
            entry("e\($0)", $0.isMultiple(of: 2) ? "user" : "assistant", text: "Later \($0)")
        }

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: snapshot,
            cursor: .empty
        ))

        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.count, 20)
    }

    func testActiveResyncKeepsLiveTextMatchingHistoricalPrefix() {
        let viewModel = makeViewModel()
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "I can help"))

        viewModel.handle(.transcriptInit(
            sessionId: "bks-1",
            entries: [entry("old", "assistant", text: "I can help with the old task")],
            cursor: .empty
        ))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))

        XCTAssertEqual(viewModel.liveText, "I can help")
    }

    func testOverlappingViewOwnersKeepSocketAliveUntilLastRelease() {
        let socket = MockSocket()
        let viewModel = SessionViewModel(
            session: Session(id: "bks-1"),
            socketFactory: { socket }
        )
        let outgoing = UUID()
        let incoming = UUID()

        viewModel.start(owner: outgoing)
        viewModel.start(owner: incoming)
        viewModel.stop(owner: outgoing)

        XCTAssertEqual(socket.connectCount, 1)
        XCTAssertEqual(socket.disconnectCount, 0)

        viewModel.stop(owner: incoming)
        XCTAssertEqual(socket.disconnectCount, 1)
    }

    func testTranscriptInitPopulatesEntries() {
        let viewModel = makeViewModel()
        XCTAssertTrue(viewModel.isLoadingConversation)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "hi"),
            entry("e2", "assistant", text: "hello"),
        ], cursor: .empty))
        XCTAssertFalse(viewModel.isLoadingConversation)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
        XCTAssertEqual(viewModel.displayItems.map(\.id), ["e1", "e2"])
    }

    /// A session opened as a new tab in a workspace is created empty: it has a
    /// real server row and no run, so it opens on its (empty) conversation
    /// rather than the loading spinner. An id-only stub looks the same to
    /// `neverRan` but says nothing about the session, so it keeps waiting.
    func testServerRowThatNeverRanSkipsTheLoadingState() {
        let created = "2026-08-06T10:00:00.000Z"
        let empty = SessionViewModel(
            session: Session(id: "bks-new", createdAt: created, lastActivity: created)
        )
        XCTAssertFalse(empty.isLoadingConversation)
        XCTAssertTrue(makeViewModel().isLoadingConversation)
    }

    func testEventsForOtherSessionsAreIgnored() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-other", entries: [entry("x", "user")], cursor: .empty))
        viewModel.handle(.streamStart(sessionId: "bks-other"))
        viewModel.handle(.streamText(sessionId: "bks-other", text: "nope"))
        XCTAssertTrue(viewModel.isLoadingConversation)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertFalse(viewModel.isStreaming)
    }

    func testStreamTextAccumulatesAndFlushesOnDone() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        XCTAssertTrue(viewModel.isStreaming)
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello "))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "world"))
        // Chunks coalesce off-screen until a flush point (stream_done here).
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "Hello world")
    }

    func testAppendStripsLandedTextFromLiveBubble() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world")
        ]))
        XCTAssertEqual(viewModel.liveText, "")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1"])
    }

    func testStreamTextArrivingAfterItsAppendIsDropped() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        // Durable entry beats the stream broadcast (1s file watcher won the race).
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "block A")
        ]))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "block A"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        XCTAssertEqual(viewModel.liveText, "", "already-landed block must not re-enter the live bubble")
        XCTAssertEqual(viewModel.entries.count, 1)
    }

    /// The foreground-resync fix: a re-watch's transcript_init carries blocks
    /// that are still sitting in the live bubble — they must be stripped.
    func testResyncInitStripsAlreadyLandedLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world"))
        viewModel.handle(.streamDone(sessionId: "bks-1"))
        // Foreground re-watch → full resync containing the same block.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi"),
            entry("e1", "assistant", text: "Hello world"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.liveText, "", "resynced block would render twice")
        XCTAssertFalse(viewModel.isStreaming)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1", "e1"])
    }

    func testResyncInitKeepsUnlandedTail() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Hello world. And more"))
        // Resync landed only the first block; the tail is still live-only.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Hello world.")
        ], cursor: .empty))
        XCTAssertTrue(viewModel.liveText.contains("And more"))
        XCTAssertFalse(viewModel.liveText.contains("Hello world."))
    }

    func testHistoryPrependsWithoutDuplicates() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [entry("e2", "user", text: "recent")], cursor: .empty))
        viewModel.handle(.transcriptHistory(sessionId: "bks-1", entries: [
            entry("e1", "user", text: "older"),
            entry("e2", "user", text: "recent"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "e2"])
    }

    func testAppendUpsertsById() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [entry("e1", "assistant", text: "draft")]))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [entry("e1", "assistant", text: "final")]))
        XCTAssertEqual(viewModel.entries.count, 1)
        XCTAssertEqual(viewModel.entries[0].text, "final")
    }

    func testToolUseAndResultMergeIntoOneDisplayItem() {
        let viewModel = makeViewModel()
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("e1", "tool_use", toolUseId: "tu-1"),
            entry("tr-tu-1", "tool_result", text: "ok", toolUseId: "tu-1"),
            entry("tr-orphan", "tool_result", text: "lost"),
        ], cursor: .empty))
        XCTAssertEqual(viewModel.displayItems.count, 2)
        guard case .toolCall(let use, let result, let isLive) = viewModel.displayItems[0] else {
            return XCTFail("expected merged tool call")
        }
        XCTAssertEqual(use.id, "e1")
        XCTAssertEqual(result?.text, "ok")
        XCTAssertFalse(isLive)
        guard case .entry(let orphan) = viewModel.displayItems[1] else {
            return XCTFail("orphan tool_result should render standalone")
        }
        XCTAssertEqual(orphan.id, "tr-orphan")
    }

    func testOnlyCurrentStreamToolCallIsLive() {
        let viewModel = makeViewModel()
        // An incomplete historical entry must not reopen just because it has no result.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("old-tool", "tool_use", toolUseId: "tu-old"),
        ], cursor: .empty))
        guard case .toolCall(_, _, let historicalIsLive) = viewModel.displayItems[0] else {
            return XCTFail("expected historical tool call")
        }
        XCTAssertFalse(historicalIsLive)

        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamEntry(
            sessionId: "bks-1",
            entry: entry("live-tool", "tool_use", toolUseId: "tu-live")
        ))
        guard case .toolCall(_, _, let liveIsLive) = viewModel.displayItems.last else {
            return XCTFail("expected live tool call")
        }
        XCTAssertTrue(liveIsLive)
    }

    /// A tool call graduates the preceding live text into an ordered
    /// ephemeral entry, so the turn reads text → tool instead of the text
    /// dangling in the bottom bubble below the tool row.
    func testToolCallGraduatesPrecedingLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Let me check."))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-1", "tool_use", toolUseId: "tu-1")))
        XCTAssertEqual(viewModel.liveText, "", "text must leave the live bubble")
        XCTAssertEqual(viewModel.displayItems.count, 2)
        guard case .entry(let graduated) = viewModel.displayItems[0] else {
            return XCTFail("graduated text should render before the tool call")
        }
        XCTAssertEqual(graduated.text, "Let me check.")
        XCTAssertTrue(graduated.isAssistant)
        guard case .toolCall = viewModel.displayItems[1] else {
            return XCTFail("tool call should follow the graduated text")
        }
    }

    /// The durable copy of a graduated block replaces it without duplication.
    func testDurableAppendReplacesGraduatedLiveText() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "Let me check."))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-1", "tool_use", toolUseId: "tu-1")))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("e1", "assistant", text: "Let me check."),
            entry("srv-1", "tool_use", toolUseId: "tu-1"),
        ]))
        XCTAssertTrue(viewModel.liveEntries.isEmpty, "graduated copy must not linger next to the durable one")
        XCTAssertEqual(viewModel.entries.map(\.id), ["e1", "srv-1"])
        XCTAssertEqual(viewModel.displayItems.count, 2)
    }

    func testStreamEntryGraduatesWhenDurableCopyLands() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamEntry(sessionId: "bks-1", entry: entry("live-5", "tool_use", toolUseId: "tu-5")))
        XCTAssertEqual(viewModel.liveEntries.count, 1)
        // Durable copy arrives under a different entry id but the same toolUseId.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("srv-5", "tool_use", toolUseId: "tu-5")
        ]))
        XCTAssertTrue(viewModel.liveEntries.isEmpty, "ephemeral copy must not linger next to the durable one")
        XCTAssertEqual(viewModel.entries.map(\.id), ["srv-5"])
        XCTAssertEqual(viewModel.displayItems.count, 1)
    }

    func testRunStopPreservesLiveTextUntilAppendLands() {
        let viewModel = makeViewModel()
        viewModel.handle(.streamStart(sessionId: "bks-1"))
        viewModel.handle(.streamText(sessionId: "bks-1", text: "tail text"))
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        XCTAssertFalse(viewModel.isRunning)
        XCTAssertFalse(viewModel.isStreaming)
        // Wiping here would blink the reply out before transcript_append lands.
        XCTAssertEqual(viewModel.liveText, "tail text")
    }

    func testQueueUpdate() {
        let viewModel = makeViewModel()
        // Drive this one through the raw frame so it also pins the wire parse.
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"next","user":"jaap"}],
         "steered":[{"id":"s1","content":"steer"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["s1"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testAskQuestionLifecycle() {
        let viewModel = makeViewModel()
        let question = AskQuestion(id: "ask-1", questions: [])
        viewModel.handle(.askQuestion(sessionId: "bks-1", question: question))
        XCTAssertEqual(viewModel.pendingQuestion?.id, "ask-1")
        viewModel.handle(.askResolved(sessionId: "bks-1", questionId: "ask-other"))
        XCTAssertNotNil(viewModel.pendingQuestion, "resolving a different question must not clear ours")
        viewModel.handle(.askResolved(sessionId: "bks-1", questionId: "ask-1"))
        XCTAssertNil(viewModel.pendingQuestion)
    }

    func testNoticeSetsAndClears() {
        let viewModel = makeViewModel()
        viewModel.handle(.notice("heads up"))
        XCTAssertEqual(viewModel.notice, "heads up")
        viewModel.handle(.notice(""))
        XCTAssertNil(viewModel.notice)
    }
}

/// `sendDraft` composer semantics. Sending is a two-step now: the draft goes
/// into the outbox (on disk, immediately) and the transcript bubble or queue
/// chip appears when the SERVER acknowledges it — which is also what says
/// where it landed. These pin down both halves: that nothing is lost when the
/// server can't be reached, and that an acknowledged message is shown exactly
/// once, in the right place.
@MainActor
final class SendDraftTests: XCTestCase {
    private var viewModel: SessionViewModel!
    private var socket: MockSocket!
    private var outbox: Outbox!
    private var outboxDirectory: URL!
    private var savedBusySend: String?

    /// Stub for the fake server's answer. nil = behave like the real one:
    /// queue a send that arrives mid-run, start a turn when idle.
    private var stubbedOutcome: OS1API.PromptDelivery?
    private var deliveries: [(item: Outbox.Item, images: [String])] = []

    override func setUp() async throws {
        // `sendDraft` reads the busy-send mode straight from UserDefaults, and
        // the test host shares its defaults domain with the real app — on a
        // machine where someone has set "steer" in Settings, every queue-chip
        // expectation below silently checked the wrong list. Pin it — and put
        // the person's own setting back afterwards, since this is their app's
        // real defaults domain.
        savedBusySend = UserDefaults.standard.string(forKey: "os1.composer.busySend")
        UserDefaults.standard.set("queue", forKey: "os1.composer.busySend")
        socket = MockSocket()
        // Its own scratch store: the real one is the person's undelivered mail.
        outboxDirectory = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("os1-outbox-tests-\(UUID().uuidString)", isDirectory: true)
        outbox = Outbox(directory: outboxDirectory, monitorNetwork: false)
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            if let stubbedOutcome = self.stubbedOutcome { return stubbedOutcome }
            return .delivered(
                status: self.viewModel.isRunning ? "queued" : "started",
                message: ""
            )
        }
        let mock = socket!
        viewModel = SessionViewModel(
            session: Session(id: "bks-1"), socketFactory: { mock }, outbox: outbox
        )
        viewModel.start()
    }

    override func tearDown() async throws {
        viewModel?.stop()
        if let outboxDirectory {
            try? FileManager.default.removeItem(at: outboxDirectory)
        }
        if let savedBusySend {
            UserDefaults.standard.set(savedBusySend, forKey: "os1.composer.busySend")
        } else {
            UserDefaults.standard.removeObject(forKey: "os1.composer.busySend")
        }
    }

    private func entry(_ id: String, _ type: String, text: String? = nil) -> TranscriptEntry {
        TranscriptEntry(id: id, type: type, content: text)
    }

    private func markRunning() {
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: true))
    }

    /// Type it, send it, and let the delivery round trip finish.
    private func send(_ text: String) async {
        viewModel.draft = text
        viewModel.sendDraft()
        await outbox.flushNow()
    }

    /// Signal is back: the app clears the backoff and retries (what
    /// `appDidBecomeActive` and the socket handshake do for real).
    private func comeBackOnline() async {
        stubbedOutcome = nil
        outbox.clearBackoff()
        await outbox.flushNow()
    }

    private var unsent: [Outbox.Item] { outbox.items(for: "bks-1") }

    // MARK: - Idle sends

    func testIdleSendEchoesOptimisticBubble() async {
        await send("hi there")
        XCTAssertEqual(viewModel.entries.count, 1)
        XCTAssertEqual(viewModel.entries[0].text, "hi there")
        XCTAssertTrue(viewModel.entries[0].isUser)
        XCTAssertEqual(viewModel.displayItems.count, 1)
        XCTAssertTrue(viewModel.queuedItems.isEmpty, "idle sends must not fabricate a queue chip")
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.draft, "")
        XCTAssertEqual(deliveries.map(\.item.content), ["hi there"])
        XCTAssertTrue(unsent.isEmpty, "a delivered message must leave the outbox")
    }

    func testIdleEchoReplacedByServerCopyWithoutDuplication() async {
        await send("hi")
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"], "optimistic bubble must be replaced, not doubled")
    }

    func testWhitespaceOnlyDraftIsNotSent() async {
        await send("   \n  ")
        XCTAssertTrue(deliveries.isEmpty)
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertTrue(viewModel.entries.isEmpty)
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
    }

    // MARK: - Offline sends (the message that used to disappear)

    /// The reported bug: sending with no connection cleared the composer,
    /// showed a bubble, and delivered nothing. Now the message is held —
    /// visibly — and goes out when the server is reachable again.
    func testOfflineSendIsHeldThenDeliveredWhenBackOnline() async {
        stubbedOutcome = .unavailable("offline")
        await send("written in a tunnel")

        XCTAssertEqual(viewModel.draft, "", "the composer accepted the message")
        XCTAssertEqual(unsent.map(\.content), ["written in a tunnel"])
        XCTAssertFalse(unsent[0].failed, "no connection is not a refusal")
        XCTAssertTrue(
            viewModel.entries.isEmpty,
            "nothing enters the transcript until the server has it"
        )

        await comeBackOnline()
        XCTAssertTrue(unsent.isEmpty, "the held message went out")
        XCTAssertEqual(viewModel.entries.map(\.text), ["written in a tunnel"])
        XCTAssertEqual(deliveries.count, 2, "one failed attempt, then the delivery")
    }

    /// It has to survive the app dying, not just the socket: the queue is on
    /// disk, and a fresh Outbox over the same directory still owes the message.
    func testHeldMessageSurvivesRelaunch() async {
        stubbedOutcome = .unavailable("offline")
        await send("still owed")

        let relaunched = Outbox(directory: outboxDirectory, monitorNetwork: false)
        XCTAssertEqual(relaunched.items(for: "bks-1").map(\.content), ["still owed"])
    }

    /// Order is meaning: message 2 must never overtake message 1, so a
    /// session with a stuck head waits as a whole.
    func testHeldMessagesKeepTheirOrder() async {
        stubbedOutcome = .unavailable("offline")
        await send("first")
        await send("second")
        XCTAssertEqual(unsent.map(\.content), ["first", "second"])

        await comeBackOnline()
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.text), ["first", "second"])
    }

    /// Retrying is only safe because the server can recognise a repeat: every
    /// attempt carries the same client id.
    func testRetriesReuseTheSameClientId() async {
        stubbedOutcome = .unavailable("offline")
        await send("say it once")
        await comeBackOnline()
        XCTAssertEqual(deliveries.count, 2)
        XCTAssertEqual(
            deliveries[0].item.id, deliveries[1].item.id,
            "a retry must be recognisable as the same message, not a new one"
        )
    }

    /// A refusal is not a connection problem: it stops, says so, and waits for
    /// the person rather than retrying forever or silently vanishing.
    func testRefusedMessageIsKeptAndMarkedFailed() async {
        stubbedOutcome = .rejected("Session has no engine to resume yet.")
        await send("nope")
        XCTAssertEqual(unsent.map(\.content), ["nope"])
        XCTAssertTrue(unsent[0].failed)
        XCTAssertEqual(unsent[0].lastError, "Session has no engine to resume yet.")
        XCTAssertTrue(viewModel.entries.isEmpty)

        // Retry once the reason is gone.
        stubbedOutcome = nil
        outbox.retry(id: unsent[0].id)
        await outbox.flushNow()
        XCTAssertTrue(unsent.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.text), ["nope"])
    }

    /// Discarding is the one way a message leaves unsent — and it has to be
    /// the person's choice.
    func testDiscardingAnUnsentMessageRemovesIt() async {
        stubbedOutcome = .unavailable("offline")
        await send("never mind")
        outbox.delete(id: unsent[0].id)
        XCTAssertTrue(unsent.isEmpty)

        await comeBackOnline()
        XCTAssertTrue(deliveries.map(\.item.content).filter { $0 == "never mind" }.count == 1,
                      "a discarded message must not be delivered later")
    }

    /// One stuck conversation must not hold up the others.
    func testAnotherSessionsBacklogDoesNotBlockThisOne() async {
        stubbedOutcome = .unavailable("offline")
        outbox.enqueue(
            sessionId: "bks-other", content: "stuck elsewhere",
            busyMode: "queue", user: "jaap"
        )
        await outbox.flushNow()
        stubbedOutcome = nil
        outbox.clearBackoff()
        // Only this session's send is expected to land; the other one is
        // simply not blocked BY it.
        await send("mine")
        XCTAssertEqual(viewModel.entries.map(\.text), ["mine"])
    }

    // MARK: - Busy sends (the queue-chip path)

    func testBusySendShowsQueueChipNotTranscriptBubble() async {
        markRunning()
        await send("do this next")
        XCTAssertTrue(viewModel.entries.isEmpty, "a queued send must not enter the transcript")
        XCTAssertTrue(viewModel.displayItems.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.count, 1)
        XCTAssertEqual(viewModel.queuedItems[0].content, "do this next")
        XCTAssertEqual(viewModel.queuedItems[0].user, ServerConfig.shared.userName)
        XCTAssertTrue(viewModel.queuedItems[0].id.hasPrefix("local-queued-"))
        XCTAssertEqual(viewModel.queuedCount, 1)
        // The frame still goes out — queueing is the server's job.
        // The message still went out — queueing is the server's decision, and
        // its answer is what put the chip there.
        XCTAssertEqual(deliveries.map(\.item.content), ["do this next"])
        XCTAssertEqual(deliveries[0].item.busyMode, "queue")
    }

    func testTwoBusySendsStackTwoChips() async {
        markRunning()
        await send("first")
        await send("second")
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["first", "second"])
        XCTAssertEqual(viewModel.queuedCount, 2)
        XCTAssertTrue(viewModel.entries.isEmpty)
    }

    /// The socket usually beats the HTTP response: the server broadcasts the
    /// new queue while the delivery answer is still travelling. The optimistic
    /// chip must not double the entry that's already on screen.
    func testQueueUpdateArrivingBeforeTheDeliveryAnswerShowsOneChip() async {
        markRunning()
        outbox.transport = { [weak self] item, images in
            guard let self else { return .unavailable("test torn down") }
            self.deliveries.append((item, images))
            let json = #"""
            {"type":"queue_update","sessionId":"bks-1",
             "queued":[{"id":"q1","content":"do this next","user":"ios"}],
             "steered":[]}
            """#
            self.viewModel.handle(ServerEvent.parse(Data(json.utf8)))
            return .delivered(status: "queued", message: "")
        }
        await send("do this next")
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        XCTAssertEqual(viewModel.queuedCount, 1)
        XCTAssertTrue(viewModel.entries.isEmpty)
    }

    func testServerQueueUpdateReplacesLocalChip() async {
        markRunning()
        await send("do this next")
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"], "server copy must replace the local chip, not join it")
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testQueuedMessageEntersTranscriptOnlyOnDelivery() async {
        markRunning()
        await send("do this next")
        // Run finishes, queue delivers: queue empties and the prompt lands as
        // a durable user entry — the thread shows it exactly once, in order.
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u9", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u9"])
        XCTAssertEqual(viewModel.displayItems.count, 1)
    }

    /// The race: the run ended in the gap, the server delivered the prompt
    /// straight to the engine, and no queue_update ever mentions it — the
    /// chip must retire when the durable user entry lands.
    func testBusySendDeliveredImmediatelyRetiresChip() async {
        markRunning()
        await send("do this next")
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(viewModel.queuedCount, 0)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    func testChipRetirementMatchesByContent() async {
        markRunning()
        await send("mine")
        // Someone else's prompt (web UI, another device) landing must not
        // retire our chip.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "someone else's")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["mine"])
        XCTAssertEqual(viewModel.queuedCount, 1)
    }

    func testServerChipsAreNeverRetiredByContentMatch() async {
        // A server-issued queue item (real id) with the same text as a landing
        // user entry must stay — only local optimistic chips retire this way.
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"repeat me","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "repeat me")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
    }

    func testBusySendCarriesImagesOnTheWire() async {
        markRunning()
        viewModel.attachedImages = [AttachedImage(id: "img1", jpegData: Data([1, 2, 3]))]
        await send("with pic")
        XCTAssertEqual(viewModel.queuedItems.map(\.content), ["with pic"])
        XCTAssertTrue(viewModel.attachedImages.isEmpty)
        XCTAssertEqual(deliveries.count, 1)
        XCTAssertEqual(deliveries[0].images.count, 1)
    }

    /// Images have to survive the wait too — they're kept beside the queue on
    /// disk, so an offline send with a screenshot still carries it later.
    func testHeldMessageKeepsItsImages() async {
        stubbedOutcome = .unavailable("offline")
        viewModel.attachedImages = [AttachedImage(id: "img1", jpegData: Data([1, 2, 3]))]
        await send("look at this")
        XCTAssertEqual(unsent.count, 1)

        await comeBackOnline()
        XCTAssertEqual(deliveries.last?.images.count, 1)
        XCTAssertEqual(viewModel.entries.last?.images?.count, 1)
    }

    func testDeleteQueuedRemovesChipAndSendsFrame() async {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"next","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.deleteQueued(viewModel.queuedItems[0])
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(socket.deletedQueueIds, ["q1"])
    }

    /// A dismissed steer receipt leaves the server queue without its message
    /// ever landing in the transcript — the exact shape the delivering-hold
    /// looks for. Without the optimistic removal it comes straight back as a
    /// ghost "Delivering…" row.
    func testDismissingSteerReceiptDoesNotResurrectItAsDelivering() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],
         "steered":[{"id":"s1","content":"while you're in there","user":"ios"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
        viewModel.dismissSteered(viewModel.steeredItems[0])
        XCTAssertTrue(viewModel.steeredItems.isEmpty)
        XCTAssertEqual(socket.deletedQueueIds, ["s1"])

        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testEditingQueuedMessageRewritesItInPlace() {
        queueTwo()
        viewModel.editQueued(viewModel.queuedItems[0], content: "  second thoughts  ")
        XCTAssertEqual(socket.updatedQueued.map(\.id), ["q1"])
        XCTAssertEqual(socket.updatedQueued.map(\.content), ["second thoughts"])
        XCTAssertEqual(
            viewModel.queuedItems.map(\.content), ["second thoughts", "then this"],
            "an edit must keep the message where it was in the queue"
        )
    }

    func testEditingQueuedMessageToNothingDiscardsIt() {
        queueTwo()
        viewModel.editQueued(viewModel.queuedItems[0], content: "   ")
        XCTAssertTrue(socket.updatedQueued.isEmpty)
        XCTAssertEqual(socket.deletedQueueIds, ["q1"])
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q2"])
    }

    /// A chip minted by the composer has an id the server has never seen, so
    /// the id-addressed actions have to wait for the real queue_update.
    func testLocalEchoChipIsNotEditableOrReorderable() async {
        markRunning()
        await send("do this next")
        let chip = viewModel.queuedItems[0]
        XCTAssertTrue(chip.isLocalEcho)
        XCTAssertFalse(viewModel.canReorder(chip))
        viewModel.editQueued(chip, content: "changed my mind")
        XCTAssertTrue(socket.updatedQueued.isEmpty)
        XCTAssertEqual(viewModel.queuedItems[0].content, "do this next")
    }

    func testMovingQueuedMessageReordersLocallyAndOnTheServer() {
        queueTwo()
        viewModel.moveQueued(viewModel.queuedItems[1], by: -1)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q2", "q1"])
        XCTAssertEqual(socket.reorders, [["q2", "q1"]])
    }

    func testMovingPastTheEndsOfTheQueueDoesNothing() {
        queueTwo()
        viewModel.moveQueued(viewModel.queuedItems[0], by: -1)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1", "q2"])
        XCTAssertTrue(socket.reorders.isEmpty)
    }

    /// Two server-known messages waiting behind a run.
    private func queueTwo() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"first","user":"ios"},
                   {"id":"q2","content":"then this","user":"ios"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
    }

    // MARK: - Delivering hold state (the vanish-then-reappear bug)

    private func sendEmptyQueueUpdate() {
        let json = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],"steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(json.utf8)))
    }

    /// The core bug: the queue drain broadcasts the EMPTIED queue seconds
    /// before the delivered prompt lands via the ~1s file watcher. The chip
    /// must hold as "delivering" across that gap — the message is never
    /// absent from the UI.
    func testDrainedChipHoldsAsDeliveringUntilEchoLands() async {
        markRunning()
        await send("do this next")
        // Server registers the queued item (replaces the local chip).
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        // Run ends; the drain empties the queue BEFORE the transcript echo.
        viewModel.handle(.sessionStatus(sessionId: "bks-1", isRunning: false))
        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["do this next"],
            "the message must stay visible while the echo is in flight"
        )
        // Echo lands: the delivering chip retires; exactly one copy remains.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u9", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u9"])
    }

    /// Race: a queue_update computed before our prompt reached the server
    /// (run ended in the gap; the prompt went straight to the engine) must
    /// not wipe the local chip — it holds as delivering until the entry lands.
    func testLocalChipSurvivesQueueUpdateThatOmitsIt() async {
        markRunning()
        await send("do this next")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["do this next"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// Steered/attributed deliveries land as "[user] content", and a
    /// multi-message drain joins the batch into ONE user entry — containment
    /// must retire every chip the entry covers (mirrors the server's own
    /// steer-receipt reconciliation).
    func testAttributedAndBatchedEchoRetiresDeliveringChips() async {
        markRunning()
        await send("first")
        await send("second")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["first", "second"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] first\n\n[jaap] second")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    func testDeliveringChipIgnoresUnrelatedUserEntry() async {
        markRunning()
        await send("mine")
        sendEmptyQueueUpdate()
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "someone else's")
        ]))
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["mine"])
    }

    /// A queue_update that re-lists a delivering chip's message (the prompt
    /// arrived after the drain frame was computed and got queued after all)
    /// moves it back to a live queue chip instead of duplicating it.
    func testRequeuedMessageLeavesDeliveringState() async {
        markRunning()
        await send("do this next")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        let requeued = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(requeued.utf8)))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
    }

    /// A resync's transcript_init is a full snapshot — no upsert runs on it,
    /// so a delivering chip whose message it already contains (attributed
    /// form here) must retire there instead of lingering.
    func testResyncInitRetiresDeliveredChip() async {
        markRunning()
        await send("do this next")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ], cursor: .empty))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    /// Ghost protection: a chip whose echo never comes (deleted from another
    /// device, server restart) drops once the grace window passes — but not
    /// a moment before.
    func testDeliveringChipExpiresOnlyAfterGrace() async {
        markRunning()
        await send("gone")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.pruneExpiredDelivering(
            now: Date().addingTimeInterval(viewModel.deliveringGrace - 5)
        )
        XCTAssertEqual(viewModel.deliveringItems.count, 1, "still within the grace window")
        viewModel.pruneExpiredDelivering(
            now: Date().addingTimeInterval(viewModel.deliveringGrace + 5)
        )
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
    }

    /// A re-send of an identical message must not be retired against the OLD
    /// copy in history: the drain holds it as delivering until ITS echo
    /// lands. (The whole-history containment scan dropped it immediately and
    /// blinked the message out — the steering vanish-then-reappear.)
    func testRepeatedSendHoldsAsDeliveringDespiteIdenticalOldMessage() async {
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue"),
            entry("a1", "assistant", text: "done"),
        ], cursor: .empty))
        markRunning()
        await send("continue")
        sendEmptyQueueUpdate()
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["continue"],
            "the old identical message must not count as this chip's echo"
        )
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u2", "user", text: "continue")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1", "a1", "u2"])
    }

    /// Same protection on the resync path: a snapshot that re-lists only
    /// entries we already hold must not retire a delivering chip — only a
    /// NEW entry (an id we didn't know) counts as its echo.
    func testResyncInitKeepsDeliveringChipAgainstOldIdenticalMessage() async {
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ], cursor: .empty))
        markRunning()
        await send("continue")
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.count, 1)
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.deliveringItems.map(\.content), ["continue"],
            "an old identical entry in the snapshot is not this chip's echo"
        )
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "continue"),
            entry("u2", "user", text: "[jaap] continue"),
        ], cursor: .empty))
        XCTAssertTrue(
            viewModel.deliveringItems.isEmpty,
            "the snapshot carrying the NEW echo retires the chip"
        )
    }

    /// Echo-before-drain ordering: when the durable entry lands while the
    /// server still lists the chip as queued, the eventual drain drops the
    /// chip outright instead of resurrecting a delivered message as a
    /// "Delivering…" ghost.
    func testDrainDropsChipWhoseEchoAlreadyLanded() async {
        markRunning()
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ]))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"], "server chips retire only via queue_update")
        sendEmptyQueueUpdate()
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertTrue(viewModel.queuedItems.isEmpty)
    }

    /// The steer flow end-to-end: steered receipt → drain → attributed echo.
    /// The message must be visible at every step.
    func testSteeredChipHoldsAcrossDrainUntilEchoLands() async {
        markRunning()
        let steered = #"""
        {"type":"queue_update","sessionId":"bks-1","queued":[],
         "steered":[{"id":"s1","content":"go left","user":"jaap"}]}
        """#
        viewModel.handle(ServerEvent.parse(Data(steered.utf8)))
        XCTAssertEqual(viewModel.steeredItems.map(\.id), ["s1"])
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["go left"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] go left")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }

    // MARK: - Stale-busy sends (bubble ↔ queue reconciliation)

    /// A resync racing the ~1s persist of a just-delivered send must not wipe
    /// its optimistic bubble — the snapshot doesn't contain the message yet.
    func testResyncInitKeepsUnlandedOptimisticBubble() async {
        await send("hi there")
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u0", "user", text: "earlier message")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.entries.map(\.text), ["earlier message", "hi there"],
            "the unlanded bubble must survive the snapshot"
        )
        // The echo then replaces the preserved bubble without duplication.
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi there")
        ]))
        XCTAssertEqual(viewModel.entries.map(\.id), ["u0", "u1"])
    }

    func testResyncInitRetiresLandedOptimisticBubble() async {
        await send("hi there")
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "hi there")
        ], cursor: .empty))
        XCTAssertEqual(
            viewModel.entries.map(\.id), ["u1"],
            "a landed echo must replace the bubble, not join it"
        )
    }

    /// The stale-isRunning hole: the client thought the session idle (bubble
    /// echo), but the server was mid-run and QUEUED the prompt. The bubble
    /// converts to the server's queue chip — one representation, no thread
    /// copy for the next resync to wipe — and the message stays visible
    /// through drain and delivery.
    func testStaleBusySendConvertsBubbleToChipWhenServerQueuesIt() async {
        await send("do this next")
        XCTAssertEqual(viewModel.entries.map(\.text), ["do this next"])
        let registered = #"""
        {"type":"queue_update","sessionId":"bks-1",
         "queued":[{"id":"q1","content":"do this next","user":"jaap"}],
         "steered":[]}
        """#
        viewModel.handle(ServerEvent.parse(Data(registered.utf8)))
        XCTAssertTrue(viewModel.entries.isEmpty, "the queue chip now represents the message")
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        // A resync mid-queue has nothing to wipe — the chip carries on.
        viewModel.handle(.transcriptInit(sessionId: "bks-1", entries: [], cursor: .empty))
        XCTAssertEqual(viewModel.queuedItems.map(\.id), ["q1"])
        // Drain → delivering hold → attributed echo lands exactly once.
        sendEmptyQueueUpdate()
        XCTAssertEqual(viewModel.deliveringItems.map(\.content), ["do this next"])
        viewModel.handle(.transcriptAppend(sessionId: "bks-1", entries: [
            entry("u1", "user", text: "[jaap] do this next")
        ]))
        XCTAssertTrue(viewModel.deliveringItems.isEmpty)
        XCTAssertEqual(viewModel.entries.map(\.id), ["u1"])
    }
}

/// Records every outgoing frame; never touches the network.
@MainActor
private final class MockSocket: SessionSocket {
    var onEvent: ((ServerEvent) -> Void)?
    var onClose: ((String?) -> Void)?

    struct PromptCall {
        let sessionId: String
        let content: String
        let user: String
        let images: [String]?
        let effort: String?
        let fastMode: Bool?
        let busyMode: String?
    }

    private(set) var connectCount = 0
    private(set) var disconnectCount = 0
    private(set) var watched: [String] = []
    private(set) var prompts: [PromptCall] = []
    private(set) var steeredQueueIds: [String] = []
    private(set) var deletedQueueIds: [String] = []
    private(set) var updatedQueued: [(id: String, content: String)] = []
    private(set) var reorders: [[String]] = []

    func connect() { connectCount += 1 }
    func disconnect() { disconnectCount += 1 }
    func watch(sessionId: String) { watched.append(sessionId) }
    func loadHistory(sessionId: String, beforeOffset: Int, beforeRev: String?) {}
    func loadHistory(sessionId: String, beforeSeq: Int) {}
    func prompt(
        sessionId: String, content: String, user: String,
        images: [String]?, effort: String?, fastMode: Bool?, busyMode: String?
    ) {
        prompts.append(PromptCall(
            sessionId: sessionId, content: content, user: user,
            images: images, effort: effort, fastMode: fastMode, busyMode: busyMode
        ))
    }
    func steerQueued(sessionId: String, queueId: String) { steeredQueueIds.append(queueId) }
    func deleteQueued(sessionId: String, queueId: String) { deletedQueueIds.append(queueId) }
    func updateQueued(sessionId: String, queueId: String, content: String) {
        updatedQueued.append((id: queueId, content: content))
    }
    func reorderQueued(sessionId: String, order: [String]) { reorders.append(order) }
    func cancelWatchedRun() {}
    func answer(sessionId: String, questionId: String, answers: [String: String]?) {}
}
