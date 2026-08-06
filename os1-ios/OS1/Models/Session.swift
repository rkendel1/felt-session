import Foundation

/// One row from `GET /api/sessions` — a subset of the server's UnifiedSession.
/// Decoding is deliberately tolerant: almost everything is optional and unknown
/// fields are ignored, so server-side additions never break the client.
struct Session: Identifiable, Decodable, Equatable, Hashable {
    let id: String
    var claudeSessionId: String?
    var codexThreadId: String?
    var opencodeSessionId: String?
    var title: String?
    var titleOverridden: Bool?
    var source: String?
    var repo: String?
    var branch: String?
    var worktreeDir: String?
    var workspaceId: String?
    var mode: String?
    var model: String?
    var effort: String?
    var fastMode: Bool?
    var isRunning: Bool?
    var runState: String?
    /// Journaled start of the current run — only present while running.
    var runStartedAt: String?
    var waitingForInput: Bool?
    var queuedCount: Int?
    var archived: Bool?
    var desk: Bool?
    var createdAt: String?
    var lastActivity: String?
    var prUrl: String?
    var prState: String?
    var prNumber: Int?
    var startedBy: String?
    var automation: AutomationFlag?
    var attachedRepos: [AttachedRepo]?
    /// The agent-published demo of a user-visible change, rendered inline in
    /// the transcript where it was published.
    var walkthrough: SessionWalkthrough?
    /// Local-only marker for a just-created row that the sessions endpoint has
    /// not returned yet. Its id may already be real after create resolves.
    var isOptimisticPlaceholder: Bool?

    /// True for automation-owned sessions (triage runs, scheduled jobs) —
    /// the bulk of server noise a person's list should hide by default.
    var isAutomation: Bool {
        automation?.isAutomation ?? (startedBy?.hasSuffix("(automation)") ?? false)
    }

    /// A just-created row the server hasn't published yet. Archiving one would
    /// PATCH a session `/api/sessions` doesn't know about, so the affordances
    /// that archive (list swipe, tab close) stay hidden until it resolves.
    var isOptimistic: Bool {
        id.hasPrefix("pending-") || isOptimisticPlaceholder == true
    }

    var displayTitle: String {
        if let title, !title.isEmpty { return title }
        return id
    }

    /// Older/default-repo sessions may omit `repo` on the wire. Current
    /// servers normalize it to the configured default repository.
    var effectiveRepo: String {
        guard let repo, !repo.isEmpty else { return "opensession" }
        return repo
    }

    /// Untouched tabs are eagerly created before their first prompt. They are
    /// valid tabs, but should not displace the conversation that started the
    /// workspace from the leading position.
    var neverRan: Bool {
        [claudeSessionId, codexThreadId, opencodeSessionId].allSatisfy {
            $0?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false
        }
            && isRunning != true
            && (queuedCount ?? 0) == 0
            && lastActivity == createdAt
    }

    var lastActivityDate: Date? {
        Self.parseISO(lastActivity)
    }

    var runStartedDate: Date? {
        Self.parseISO(runStartedAt)
    }

    enum Status {
        case needsInput
        case running
        case idle
    }

    var status: Status {
        if waitingForInput == true { return .needsInput }
        if isRunning == true { return .running }
        return .idle
    }

    /// Status lanes in native display order. Running sessions stay above all
    /// other work; within a session, waiting still takes precedence over running.
    enum Lane: String, CaseIterable {
        case inProgress, needsInput, inReview, done, backlog

        var label: String {
            switch self {
            case .needsInput: "Needs input"
            case .inProgress: "In progress"
            case .inReview: "In review"
            case .done: "Done"
            case .backlog: "Backlog"
            }
        }
    }

    var lane: Lane {
        if waitingForInput == true { return .needsInput }
        if isRunning == true { return .inProgress }
        if prState == "OPEN" { return .inReview }
        if prState == "MERGED" { return .done }
        return .backlog
    }

    /// Shared formatters — NSISO8601DateFormatter is documented thread-safe,
    /// and allocating one per call was a real cost: this runs inside list
    /// sort comparators, thousands of times per 5s sessions poll.
    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime]
        return formatter
    }()

    static func parseISO(_ string: String?) -> Date? {
        guard let string else { return nil }
        return isoFractional.date(from: string) ?? isoPlain.date(from: string)
    }
}

struct AttachedRepo: Decodable, Equatable, Hashable, Identifiable {
    let repo: String
    let branch: String
    let dir: String

    var id: String { repo }
}

extension Session {
    /// Locally-built placeholder for a session the server just created but
    /// hasn't persisted to the list yet — rendered (and opened) immediately
    /// instead of polling until `GET /api/sessions` includes it.
    static func optimistic(
        id: String,
        title: String,
        repo: String,
        mode: String,
        model: String?,
        effort: String?,
        fastMode: Bool,
        startedBy: String,
        workspaceId: String? = nil
    ) -> Session {
        var session = Session(id: id)
        session.title = title
        session.source = "opensession"
        session.repo = repo
        // A session created into an existing workspace carries its id from the
        // start, so the pending row joins that workspace's tab strip (and its
        // sidebar row) immediately instead of flashing as a separate session
        // until the first poll lands.
        session.workspaceId = workspaceId
        session.mode = mode
        session.model = model
        session.effort = effort
        session.fastMode = fastMode ? true : nil
        session.isRunning = true
        session.runStartedAt = ISO8601DateFormatter().string(from: .now)
        session.createdAt = session.runStartedAt
        session.lastActivity = session.runStartedAt
        session.startedBy = startedBy
        session.isOptimisticPlaceholder = true
        return session
    }

    /// Bare session with just an id; every other field starts nil.
    init(id: String) {
        self.id = id
    }
}

/// The server's `automation` field is `true` OR the automation's name —
/// either way it means "not a person's session". Tolerant of both shapes.
struct AutomationFlag: Decodable, Equatable, Hashable {
    let isAutomation: Bool

    init(from decoder: Decoder) throws {
        let container = try decoder.singleValueContainer()
        if let flag = try? container.decode(Bool.self) {
            isAutomation = flag
        } else if let name = try? container.decode(String.self) {
            isAutomation = !name.isEmpty
        } else {
            isAutomation = false
        }
    }
}
