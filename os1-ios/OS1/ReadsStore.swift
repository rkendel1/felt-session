import Foundation
import Observation

/// Per-user "last read" marks — what makes a sidebar row read as unread.
///
/// Same store the web sidebar writes (`GET/PUT /api/reads`, see
/// src/server/reads.ts and src/frontend/lib/reads.ts): session id → the
/// `lastActivity` the session carried the last time you looked at it. A session is
/// unread when its current `lastActivity` is NEWER than that mark, so a session
/// you have never opened never lights up — the flag means "new since you read
/// it", not "never seen". Because the marks live on the server, reading a session
/// on the phone clears its emphasis in the browser too.
@Observable
@MainActor
final class ReadsStore {
    static let shared = ReadsStore()

    /// Session id → ISO `lastActivity` at the moment it was last read.
    private(set) var reads: [String: String] = [:]

    /// The session on screen right now. Its row is never unread: the web sidebar
    /// skips the selected session the same way, so activity arriving while
    /// you watch it can't bold the row behind the conversation for the few
    /// seconds before the next poll re-marks it.
    private(set) var openSessionId: String?

    /// Bumped by every local write and by every hydrate. An in-flight GET that
    /// finishes after a mark landed is discarded rather than undoing it.
    private var generation = 0

    /// Nothing is pushed before the first hydrate succeeds. A PUT replaces the
    /// whole map, so saving a map that is empty-but-for-this-launch's reads
    /// would wipe every mark you made in the browser. Marks taken meanwhile
    /// stay local and ride out with the first hydrate that carries them.
    private var hydrated = false

    /// The server caps a user's map (src/server/reads.ts) and silently drops
    /// whatever spills, so bound it here first — and drop the OLDEST marks,
    /// which are the ones worth missing, rather than whatever order JSON took.
    private static let cap = 500

    private init() {}

    /// Load this user's marks from the server. Guarded like
    /// `HideStore.hydrate`: a stale response (server/user switched, or a mark
    /// landed meanwhile) is dropped.
    func hydrate() async {
        let requestContext = NativePreferences.context()
        generation += 1
        let requestGeneration = generation
        guard let loaded = try? await SettingsAPI.reads(user: requestContext.user) else { return }
        guard requestGeneration == generation,
              NativePreferences.context() == requestContext
        else { return }
        // Merge, don't replace: a session read before this landed keeps its mark,
        // and the server's other marks (the browser's, another device's) are
        // adopted rather than overwritten on the next save.
        var merged = loaded
        var carried = false
        for (id, mark) in reads where Self.isNewer(mark, than: merged[id]) {
            merged[id] = mark
            carried = true
        }
        hydrated = true
        if merged != reads { reads = merged }
        if carried { save() }
    }

    private static func isNewer(_ mark: String, than other: String?) -> Bool {
        guard let other else { return true }
        guard mark != other else { return false }
        guard let lhs = Session.parseISO(mark), let rhs = Session.parseISO(other) else {
            return false
        }
        return lhs > rhs
    }

    /// A session came on screen: it reads up to its current activity, and stays
    /// out of the unread emphasis until it's closed. Called again with each
    /// fresh copy from the poll, which is what keeps an open session read while
    /// new output lands in it — the web viewer's markRead-on-activity tick.
    func open(_ session: Session) {
        if openSessionId != session.id { openSessionId = session.id }
        markRead(session)
    }

    func close(_ id: String) {
        if openSessionId == id { openSessionId = nil }
    }

    /// Record that `session` has been read up to its current `lastActivity`.
    /// A no-op when the mark already matches, so calling it on every poll of
    /// an open session costs nothing and doesn't spam the server mirror.
    func markRead(_ session: Session) {
        guard let activity = session.lastActivity, !activity.isEmpty else { return }
        guard reads[session.id] != activity else { return }
        reads[session.id] = activity
        enforceCap()
        save()
    }

    /// True when the session has activity past your read mark.
    func isUnread(_ session: Session) -> Bool {
        guard session.id != openSessionId, let mark = reads[session.id] else { return false }
        guard let activity = session.lastActivity, activity != mark else { return false }
        guard let read = Session.parseISO(mark),
              let last = Session.parseISO(activity)
        else { return false }
        return last > read
    }

    /// A sidebar row is unread when any session under it is — one unread session
    /// bolds the whole workspace row, like the web sidebar.
    func isUnread(_ sessions: [Session]) -> Bool {
        sessions.contains { isUnread($0) }
    }

    private func enforceCap() {
        guard reads.count > Self.cap else { return }
        let doomed = reads
            .map { (id: $0.key, date: Session.parseISO($0.value) ?? .distantPast) }
            .sorted { $0.date < $1.date }
            .prefix(reads.count - Self.cap)
        for entry in doomed { reads.removeValue(forKey: entry.id) }
    }

    private func save() {
        guard hydrated else { return }
        generation += 1
        let user = ServerConfig.shared.userName
        let snapshot = reads
        // Fire-and-forget, like the web's mirror: the map is local truth and a
        // failed PUT costs nothing worth an error banner.
        Task { _ = try? await SettingsAPI.saveReads(user: user, reads: snapshot) }
    }
}
