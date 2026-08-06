import Foundation

/// Parsed server-to-client WebSocket frames. Frame types the client does not
/// care about yet decode to `.ignored` instead of failing, so protocol
/// additions on the server are harmless.
/// Sendable so large frames can decode off the main actor (see OS1Socket).
enum ServerEvent: Sendable {
    case hello(bootId: String)
    case pong
    case transcriptInit(sessionId: String, entries: [TranscriptEntry], cursor: HistoryCursor)
    case transcriptHistory(sessionId: String, entries: [TranscriptEntry], cursor: HistoryCursor)
    case transcriptAppend(sessionId: String, entries: [TranscriptEntry])
    case streamStart(sessionId: String)
    case streamText(sessionId: String, text: String)
    case streamEntry(sessionId: String, entry: TranscriptEntry)
    case streamDone(sessionId: String)
    case sessionStatus(sessionId: String, isRunning: Bool)
    case queueUpdate(sessionId: String, queued: [QueueItem], steered: [QueueItem])
    case askQuestion(sessionId: String, question: AskQuestion)
    case askResolved(sessionId: String, questionId: String)
    case notice(String)
    case serverError(String)
    case ignored

    static func parse(_ data: Data) -> ServerEvent {
        guard let frame = try? JSONDecoder().decode(RawFrame.self, from: data) else {
            return .ignored
        }
        switch frame.type {
        case "hello":
            return .hello(bootId: frame.bootId ?? "")
        case "pong":
            return .pong
        case "transcript_init":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptInit(
                sessionId: id, entries: frame.entries ?? [], cursor: frame.cursor
            )
        case "transcript_history":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptHistory(
                sessionId: id, entries: frame.entries ?? [], cursor: frame.cursor
            )
        case "transcript_append":
            guard let id = frame.sessionId else { return .ignored }
            return .transcriptAppend(sessionId: id, entries: frame.entries ?? [])
        case "stream_start":
            guard let id = frame.sessionId else { return .ignored }
            return .streamStart(sessionId: id)
        case "stream_text":
            guard let id = frame.sessionId, let text = frame.text else { return .ignored }
            return .streamText(sessionId: id, text: text)
        case "stream_tool_use", "stream_tool_result":
            guard let id = frame.sessionId, let entry = frame.entry else { return .ignored }
            return .streamEntry(sessionId: id, entry: entry)
        case "stream_done":
            guard let id = frame.sessionId else { return .ignored }
            return .streamDone(sessionId: id)
        case "session_status":
            guard let id = frame.sessionId else { return .ignored }
            return .sessionStatus(sessionId: id, isRunning: frame.isRunning ?? false)
        case "queue_update":
            guard let id = frame.sessionId else { return .ignored }
            return .queueUpdate(
                sessionId: id,
                queued: (frame.queued ?? []).map(QueueItem.init),
                steered: (frame.steered ?? []).map(QueueItem.init)
            )
        case "ask_question":
            guard let id = frame.sessionId,
                  let questionId = frame.questionId,
                  let questions = frame.questions
            else { return .ignored }
            return .askQuestion(
                sessionId: id,
                question: AskQuestion(id: questionId, questions: questions)
            )
        case "ask_resolved":
            guard let id = frame.sessionId, let questionId = frame.questionId else {
                return .ignored
            }
            return .askResolved(sessionId: id, questionId: questionId)
        case "notice":
            return .notice(frame.message ?? "")
        case "error":
            return .serverError(frame.message ?? "Unknown server error")
        default:
            return .ignored
        }
    }
}

/// Pagination cursor carried by transcript_init / transcript_history frames.
/// `truncated` means older history exists; paging back sends `load_history`
/// with `beforeOffset` + `beforeRev` (byte cursor into the mirror file) or
/// `beforeSeq` when the server serves the seq-mode transcript store.
struct HistoryCursor: Equatable, Sendable {
    var truncated: Bool
    var startOffset: Int?
    var rev: String?
    var firstSeq: Int?

    /// No paging metadata (short transcripts, tests).
    static let empty = HistoryCursor(
        truncated: false, startOffset: nil, rev: nil, firstSeq: nil
    )
}

/// One message waiting on a busy run — either queued (held until the run
/// finishes) or steered (delivering at the next turn boundary).
struct QueueItem: Identifiable, Equatable, Sendable {
    let id: String
    let content: String
    let user: String?
    /// Images the message carries, as `data:` URLs — the chip shows the first
    /// as a thumbnail so a queued screenshot is recognisable.
    let images: [String]
    /// Whether file attachments ride along. The server can't fold a
    /// file-carrying message into a live run, so the chip hides Steer.
    let hasFiles: Bool

    /// Chips minted locally (the optimistic echo of a busy send) carry an id
    /// the server has never seen, so the actions that address a queue entry
    /// by id — edit, reorder — have to wait for the real `queue_update`.
    var isLocalEcho: Bool { id.hasPrefix("local-") }

    fileprivate init(_ wire: RawFrame.WireQueueItem) {
        id = wire.id ?? UUID().uuidString
        content = wire.content ?? ""
        user = wire.user
        images = wire.images ?? []
        hasFiles = !(wire.files ?? []).isEmpty
    }

    /// Local optimistic construction — the composer's echo of a send made
    /// while a run is busy, shown as a queue chip until the server's own
    /// queue_update replaces it.
    init(
        id: String,
        content: String,
        user: String?,
        images: [String] = [],
        hasFiles: Bool = false
    ) {
        self.id = id
        self.content = content
        self.user = user
        self.images = images
        self.hasFiles = hasFiles
    }

    /// The same entry with new text, for the optimistic half of an edit.
    func withContent(_ content: String) -> QueueItem {
        QueueItem(
            id: id, content: content, user: user, images: images, hasFiles: hasFiles
        )
    }
}

/// Superset of every server frame's fields; individual events pick what they need.
private struct RawFrame: Decodable {
    struct WireQueueItem: Decodable {
        /// The `files` payload's shape varies by client (staged-path refs,
        /// inline blobs) and all the chip needs is whether there are any —
        /// so each element is consumed without being interpreted.
        struct OpaqueFile: Decodable {
            init(from decoder: Decoder) throws {}
        }

        let id: String?
        let content: String?
        let user: String?
        let images: [String]?
        let files: [OpaqueFile]?
    }

    let type: String
    let sessionId: String?
    let bootId: String?
    let entries: [TranscriptEntry]?
    let entry: TranscriptEntry?
    let text: String?
    let isRunning: Bool?
    let queued: [WireQueueItem]?
    let steered: [WireQueueItem]?
    let questionId: String?
    let questions: [AskQuestion.Question]?
    let message: String?
    let truncated: Bool?
    let startOffset: Int?
    let rev: String?
    let firstSeq: Int?

    var cursor: HistoryCursor {
        HistoryCursor(
            truncated: truncated ?? false,
            startOffset: startOffset,
            rev: rev,
            firstSeq: firstSeq
        )
    }
}
