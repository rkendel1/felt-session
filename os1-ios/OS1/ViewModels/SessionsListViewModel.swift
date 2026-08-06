import Foundation
import Observation

/// Sessions overview. The server has no push channel for list changes, so this
/// polls `GET /api/sessions` (server caches for 2s; the web UI polls at 5s too).
@Observable
@MainActor
final class SessionsListViewModel {
    private(set) var sessions: [Session] = []
    private(set) var archivedSessions: [Session] = []
    private(set) var workspaceNames: [String: String] = [:]
    private(set) var error: String?
    /// Why the list has nothing in it, when the reason is a failed load
    /// rather than a server with nothing on it.
    ///
    /// Kept apart from `error`, which also carries action failures (a rename
    /// that didn't take, an archive that bounced): the empty screen stands in
    /// for the list itself, so it may only speak about loading the list.
    private(set) var loadFailure: Reachability.Diagnosis?
    private(set) var hasLoaded = false

    private var pollTask: Task<Void, Never>?

    /// Memoized sidebar rows for the current list — see `sidebarRows`.
    ///
    /// Observation-ignored on purpose: `sidebarWorkspaces` fills it from its
    /// own getter, and an observed write during a view body evaluation would
    /// invalidate the view that is being evaluated.
    @ObservationIgnored private var sidebarRowsCache: [SidebarWorkspace]?

    /// Bumped by every mutation of the grouping's inputs, so a detached prime
    /// can tell whether the list moved under it without an O(n) comparison.
    @ObservationIgnored private var sessionsRevision = 0

    /// The sidebar's rows: workspace groups, memoized.
    ///
    /// The grouping walks every session — dictionary builds, worktree path
    /// parsing, a sort per row — and the list view reads it several times per
    /// body evaluation. A `sample` of a cold launch (5.5k rows) had the main
    /// thread inside this call for ~70% of the trace, which is why the app
    /// took minutes to become usable. `refresh` primes the cache off the main
    /// actor, so in the steady state a read here costs nothing.
    var sidebarWorkspaces: [SidebarWorkspace] {
        // Read the inputs even on a cache hit: that is what registers the
        // reading view's observation dependency. Without it, a cached read
        // would silently stop re-rendering when the list changes.
        let sessions = self.sessions
        let names = workspaceNames
        if let cached = sidebarRowsCache { return cached }
        let rows = Self.sidebarRows(in: sessions, workspaceNames: names)
        sidebarRowsCache = rows
        return rows
    }

    /// The one way to replace the list — keeps the grouping cache honest.
    ///
    /// `rows` is the grouping for `next` when the caller already has it;
    /// passing nil leaves the next read to group lazily. Publishing both in
    /// one step matters: assigning `sessions` alone wakes every observing
    /// view immediately, and a body that runs before the grouping lands is
    /// exactly the main-thread pass this cache exists to avoid.
    private func setSessions(_ next: [Session], rows: [SidebarWorkspace]? = nil) {
        sessions = next
        sidebarRowsCache = rows
        sessionsRevision += 1
    }

    /// Cached rows with one session spliced in as a row of its own, or nil when
    /// the insert can't be proven row-local — the caller then invalidates and
    /// the next read regroups.
    ///
    /// The local mutations below (create, resolve, restore) publish straight
    /// into a body evaluation, and a body that finds the cache empty regroups
    /// thousands of rows on the main actor: the pass `refresh` goes out of its
    /// way to keep off-main. Creating a session did exactly that at the moment
    /// the new conversation was being pushed, which is why the list sat there
    /// for seconds before the session appeared.
    private func rowsInserting(
        _ session: Session, into rows: [SidebarWorkspace]
    ) -> [SidebarWorkspace]? {
        #if !os(macOS)
        // A session started inside a workspace joins that workspace's row rather
        // than opening one of its own: rebuild the one row from its sessions plus
        // this one, and move it to the front — where a full regroup puts it,
        // since the new session leads the list that pass walks.
        if let workspaceId = session.workspaceId, !workspaceId.isEmpty {
            guard let index = rows.firstIndex(where: { $0.workspaceId == workspaceId })
            else { return nil }
            let merged = Self.sidebarRows(
                in: [session] + rows[index].sessions, workspaceNames: workspaceNames
            )
            guard merged.count == 1 else { return nil }
            var next = rows
            next.remove(at: index)
            return merged + next
        }
        #endif
        guard ownsItsRow(session),
              let row = Self.sidebarRows(in: [session], workspaceNames: workspaceNames).first,
              !rows.contains(where: { $0.id == row.id })
        else { return nil }
        return [row] + rows
    }

    /// Cached rows with one session dropped, regrouping just the row that held
    /// it. Nil when that regroup doesn't reproduce the same single row, i.e.
    /// the removal moved the grouping and only a full pass can say how.
    private func rowsRemoving(
        sessionId id: String, from rows: [SidebarWorkspace]
    ) -> [SidebarWorkspace]? {
        guard let index = rows.firstIndex(where: { $0.sessions.contains { $0.id == id } })
        else { return rows }
        var next = rows
        let remaining = rows[index].sessions.filter { $0.id != id }
        if remaining.isEmpty {
            next.remove(at: index)
            return next
        }
        let regrouped = Self.sidebarRows(in: remaining, workspaceNames: workspaceNames)
        guard regrouped.count == 1, regrouped[0].id == rows[index].id else { return nil }
        next[index] = regrouped[0]
        return next
    }

    /// A session no existing row can absorb and that absorbs none: no workspace,
    /// no isolated worktree. (Every Mac row is a single session, so there the
    /// question doesn't arise.)
    private func ownsItsRow(_ session: Session) -> Bool {
        #if os(macOS)
        return true
        #else
        return session.workspaceId?.isEmpty != false
            && Self.isolatedWorktree(for: session) == nil
        #endif
    }

    /// Group a list off the main actor, ready to publish with it. The session
    /// titles that label `bks-…` links in transcripts are built in the same
    /// detached pass — it walks every row already, and doing it on the main
    /// actor would put another thousands-of-rows loop in the 5s poll.
    private static func groupedOffMain(
        _ sessions: [Session], workspaceNames names: [String: String]
    ) async -> (rows: [SidebarWorkspace], titles: [String: String]) {
        await Task.detached(priority: .userInitiated) {
            var titles: [String: String] = [:]
            titles.reserveCapacity(sessions.count)
            for session in sessions {
                let title = session.displayTitle
                if !title.isEmpty { titles[session.id] = title }
            }
            return (sidebarRows(in: sessions, workspaceNames: names), titles)
        }.value
    }

    /// Honor the web sidebar's shared order, then append newly seen repositories
    /// by frequency with a stable alphabetical tie-breaker.
    nonisolated static func repositoryOrder(
        in sessions: [Session],
        preferredOrderJSON: String = "[]"
    ) -> [String] {
        var counts: [String: Int] = [:]
        for session in sessions where session.archived != true {
            counts[session.effectiveRepo, default: 0] += 1
        }
        let discovered = counts.keys.sorted {
            let left = counts[$0, default: 0]
            let right = counts[$1, default: 0]
            return left != right ? left > right : $0.localizedStandardCompare($1) == .orderedAscending
        }
        let preferred = (try? JSONDecoder().decode(
            [String].self,
            from: Data(preferredOrderJSON.utf8)
        )) ?? []
        var seen = Set<String>()
        let ordered = preferred.filter { counts[$0] != nil && seen.insert($0).inserted }
        return ordered + discovered.filter { seen.insert($0).inserted }
    }

    /// Live sibling sessions shown in the conversation tab strip. This mirrors
    /// the web client: workspace membership wins, with isolated worktrees as
    /// the fallback for legacy rows, and the natural order is oldest first.
    nonisolated static func tabSessions(
        in sessions: [Session], containing current: Session
    ) -> [Session] {
        // NavigationPath retains the row snapshot that was originally pushed.
        // Prefer the latest polled copy so a newly filed optimistic session
        // joins its workspace without requiring the conversation to reopen.
        let current = sessions.first { $0.id == current.id } ?? current
        let belongs: (Session) -> Bool
        if let workspaceId = current.workspaceId, !workspaceId.isEmpty {
            let dir = isolatedWorktree(for: current)
            belongs = {
                $0.workspaceId == workspaceId
                    || (dir != nil && $0.workspaceId?.isEmpty != false
                        && isolatedWorktree(for: $0) == dir)
            }
        } else if let dir = isolatedWorktree(for: current) {
            belongs = { isolatedWorktree(for: $0) == dir }
        } else {
            return [current]
        }
        var tabs = sessions.filter {
            belongs($0) && ($0.archived != true || $0.id == current.id)
        }
        if !tabs.contains(where: { $0.id == current.id }) {
            tabs.append(current)
        }
        tabs.sort {
            let left = $0.createdAt ?? ""
            let right = $1.createdAt ?? ""
            return left == right ? $0.id < $1.id : left < right
        }
        let main = mainSession(in: tabs)
        guard let main else { return [] }
        return [main] + tabs.filter { $0.id != main.id }
    }

    /// The session that takes over the strip when `closed` is closed from it: the
    /// tab to its right, or the one to its left when it was the rightmost. Nil
    /// when it was the workspace's last session and there is nothing left to show.
    nonisolated static func tabAfterClosing(
        _ closed: Session, in tabs: [Session]
    ) -> Session? {
        let remaining = tabs.filter { $0.id != closed.id }
        guard !remaining.isEmpty else { return nil }
        let index = tabs.firstIndex { $0.id == closed.id } ?? 0
        return index < remaining.count ? remaining[index] : remaining.last
    }

    /// The sidebar's rows on this platform: workspace groups on iOS, and one
    /// row per session on the Mac, whose detail has no sibling-tab strip yet.
    nonisolated static func sidebarRows(
        in sessions: [Session],
        workspaceNames: [String: String]
    ) -> [SidebarWorkspace] {
        #if os(macOS)
        return sessions.map {
            SidebarWorkspace(
                id: "session:\($0.id)",
                title: $0.displayTitle,
                sessions: [$0],
                mainSession: $0
            )
        }
        #else
        return sidebarWorkspaces(in: sessions, workspaceNames: workspaceNames)
        #endif
    }

    /// One sidebar row per workspace, with isolated worktrees as the fallback
    /// for legacy workspace-less rows. Such a row adopts the one workspace
    /// already using its worktree, but separate workspaces are never merged
    /// merely because their paths happen to match.
    nonisolated static func sidebarWorkspaces(
        in sessions: [Session],
        workspaceNames: [String: String] = [:]
    ) -> [SidebarWorkspace] {
        let workspaceKeyByWorktree = Dictionary(grouping: sessions.filter {
            $0.workspaceId?.isEmpty == false && isolatedWorktree(for: $0) != nil
        }, by: { isolatedWorktree(for: $0)! }).compactMapValues { group in
            let keys = Set(group.compactMap(\.workspaceId))
            return keys.count == 1 ? "workspace:\(keys.first!)" : nil
        }
        var order: [String] = []
        var grouped: [String: [Session]] = [:]
        for session in sessions {
            let key: String
            if session.workspaceId?.isEmpty != false,
               let dir = isolatedWorktree(for: session),
               let groupKey = workspaceKeyByWorktree[dir] {
                key = groupKey
            } else {
                key = workspaceKey(for: session)
            }
            if grouped[key] == nil { order.append(key) }
            grouped[key, default: []].append(session)
        }
        return order.compactMap { key in
            guard var rowSessions = grouped[key] else { return nil }
            rowSessions.sort(by: sessionNaturalOrder)
            guard let main = mainSession(in: rowSessions) else { return nil }
            let named = rowSessions.compactMap(\.workspaceId)
                .compactMap { workspaceNames[$0] }.first
            let renamed = rowSessions.first { $0.titleOverridden == true }
            let worktreeName = main.worktreeDir.flatMap {
                $0.contains("/worktrees/")
                    ? URL(fileURLWithPath: $0).lastPathComponent
                    : nil
            }
            // A real workspace row NEVER falls back to the branch, matching the
            // web sidebar (`ws?.name || sessions[0].title`). The names map is
            // fetched separately from the sessions list and is empty until that
            // request lands — or for good, if an app build outlives a rename of
            // the endpoint it reads (`/api/projects` -> `/api/workspaces`, which
            // is exactly how every row came to be titled by its branch). Falling
            // to the session's own title degrades to something a person wrote;
            // falling to `branch` degrades to machine slugs across the sidebar.
            // Branch/worktree naming stays where it's the only identity there
            // is: the legacy workspace-less isolated-worktree rows.
            let title: String
            if key.hasPrefix("workspace:") {
                title = named ?? renamed?.displayTitle ?? main.displayTitle
            } else {
                title = renamed?.displayTitle ?? main.branch ?? worktreeName
                    ?? main.displayTitle
            }
            return SidebarWorkspace(
                id: key,
                title: title,
                sessions: rowSessions,
                mainSession: main
            )
        }
    }

    /// Workspace rows split into the web sidebar's Inbox bands. The bands are
    /// exclusive, with priority needs-action > live-or-today > yesterday >
    /// earlier, and every band ranks by last activity — deliberately ignoring
    /// the "Created" sort, since an inbox orders by what moved last. Empty
    /// bands are dropped.
    nonisolated static func inboxBands(
        _ workspaces: [SidebarWorkspace],
        now: Date = Date(),
        calendar: Calendar = .current
    ) -> [(band: InboxBand, workspaces: [SidebarWorkspace])] {
        let dayStart = calendar.startOfDay(for: now)
        let yesterdayStart = dayStart.addingTimeInterval(-24 * 60 * 60)
        // Decorated: each row's activity date is derived once (it walks the
        // row's sessions), not once per comparison — this runs on every body
        // evaluation over a list that can be thousands of rows.
        var bucketed: [InboxBand: [(workspace: SidebarWorkspace, date: Date)]] = [:]
        for workspace in workspaces {
            let date = workspace.lastActivityDate
            let band: InboxBand
            if workspace.lane == .needsInput {
                band = .needsAction
            } else if workspace.isRunning || date >= dayStart {
                // A live row is recent whatever its day — work in flight is
                // recent by definition — but ranks by activity like the rest.
                band = .recent
            } else if date >= yesterdayStart {
                band = .yesterday
            } else {
                band = .earlier
            }
            bucketed[band, default: []].append((workspace, date))
        }
        return InboxBand.allCases.compactMap { band in
            guard let rows = bucketed[band] else { return nil }
            return (band, rows.sorted { $0.date > $1.date }.map(\.workspace))
        }
    }

    nonisolated private static func workspaceKey(for session: Session) -> String {
        if let workspaceId = session.workspaceId, !workspaceId.isEmpty {
            return "workspace:\(workspaceId)"
        }
        if let dir = isolatedWorktree(for: session) { return "worktree:\(dir)" }
        return "session:\(session.id)"
    }

    nonisolated private static func isolatedWorktree(for session: Session) -> String? {
        guard let dir = session.worktreeDir,
              dir.contains("/worktrees/") else { return nil }
        return dir
    }

    nonisolated private static func sessionNaturalOrder(_ left: Session, _ right: Session) -> Bool {
        let leftDate = left.createdAt ?? ""
        let rightDate = right.createdAt ?? ""
        return leftDate == rightDate ? left.id < right.id : leftDate < rightDate
    }

    nonisolated private static func mainSession(in sessions: [Session]) -> Session? {
        sessions.first { !$0.isAutomation && !$0.neverRan }
            ?? sessions.first { !$0.neverRan }
            ?? sessions.first
    }

    /// Just-created sessions rendered before the server's list includes them.
    /// Dropped once the real row appears (or after a 2-minute safety window).
    private var optimistic: [String: (session: Session, added: Date)] = [:]

    /// Show a locally-built row for a just-created session immediately.
    ///
    /// The pending row is prepended rather than re-merged: `sessions` already
    /// carries any earlier pending rows, and re-merging would see their ids in
    /// the list and retire their overlay entries, dropping them on the next
    /// poll until the server's own rows arrive.
    func addOptimistic(_ session: Session) {
        optimistic[session.id] = (session, Date())
        setSessions(
            [session] + sessions,
            rows: sidebarRowsCache.flatMap { rowsInserting(session, into: $0) }
        )
    }

    /// The background create resolved: move a pending row onto the server's
    /// real id (still in the optimistic overlay until polling returns the
    /// server's own row for it).
    func resolveOptimistic(tempId: String, realId: String) {
        guard let entry = optimistic.removeValue(forKey: tempId) else { return }
        let old = entry.session
        let real = Session.optimistic(
            id: realId,
            title: old.title ?? "",
            repo: old.effectiveRepo,
            mode: old.mode ?? "code",
            model: old.model,
            effort: old.effort,
            fastMode: old.fastMode ?? false,
            startedBy: old.startedBy ?? "",
            // Keep the workspace: a session created into one stays in its row
            // (and its tab strip) across the create resolving, instead of
            // falling out until the server's own row arrives.
            workspaceId: old.workspaceId
        )
        optimistic[realId] = (real, entry.added)
        setSessions(
            sessions.map { $0.id == tempId ? real : $0 },
            rows: sidebarRowsCache.flatMap { cached in
                rowsRemoving(sessionId: tempId, from: cached)
                    .flatMap { rowsInserting(real, into: $0) }
            }
        )
    }

    /// Roll back a pending row whose create failed.
    func removeOptimistic(_ id: String) {
        optimistic.removeValue(forKey: id)
        setSessions(
            sessions.filter { $0.id != id },
            rows: sidebarRowsCache.flatMap { rowsRemoving(sessionId: id, from: $0) }
        )
    }

    /// Sessions archived locally that the server's (2s-cached) list may still
    /// include for a poll or two — suppressed until it catches up, with a
    /// safety expiry so a failed archive doesn't hide the row forever.
    private var locallyArchived: [String: (session: Session, added: Date)] = [:]

    /// Swipe-to-archive: drop the row immediately, tell the server in the
    /// background, and roll back (surfacing the error) if that fails.
    func archive(_ session: Session) {
        setSessions(
            sessions.filter { $0.id != session.id },
            rows: sidebarRowsCache.flatMap { rowsRemoving(sessionId: session.id, from: $0) }
        )
        var archived = session
        archived.archived = true
        locallyArchived[session.id] = (archived, Date())
        archivedSessions.removeAll { $0.id == session.id }
        archivedSessions.insert(archived, at: 0)
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: true)
            } catch {
                locallyArchived.removeValue(forKey: session.id)
                archivedSessions.removeAll { $0.id == session.id }
                self.error = "Couldn't archive: \(error.localizedDescription)"
                await refresh()
            }
        }
    }

    /// Restore from the archived list immediately, then reconcile with the
    /// server. The short-lived suppression avoids a cached archived row
    /// flashing back into the sheet before the PATCH reaches `/api/sessions`.
    func unarchive(_ session: Session) {
        archivedSessions.removeAll { $0.id == session.id }
        locallyUnarchived[session.id] = Date()
        var restored = session
        restored.archived = false
        setSessions(
            [restored] + sessions,
            rows: sidebarRowsCache.flatMap { rowsInserting(restored, into: $0) }
        )
        Task {
            do {
                try await OS1API.setArchived(sessionId: session.id, archived: false)
            } catch {
                locallyUnarchived.removeValue(forKey: session.id)
                setSessions(sessions.filter { $0.id != session.id })
                self.error = "Couldn't restore: \(error.localizedDescription)"
                await refresh()
            }
        }
    }

    func rename(_ workspace: SidebarWorkspace, to proposedName: String) {
        let name = proposedName.trimmingCharacters(in: .whitespacesAndNewlines)
        if workspace.workspaceId != nil, name.isEmpty { return }

        Task {
            do {
                if let workspaceId = workspace.workspaceId {
                    try await OS1API.renameWorkspace(workspaceId: workspaceId, name: name)
                } else if name.isEmpty {
                    for session in workspace.sessions where session.titleOverridden == true {
                        try await OS1API.renameSession(sessionId: session.id, title: "")
                    }
                } else {
                    let session = workspace.sessions.first { $0.titleOverridden == true }
                        ?? workspace.mainSession
                    try await OS1API.renameSession(
                        sessionId: session.id,
                        title: name
                    )
                }
                await refresh()
            } catch {
                self.error = workspace.workspaceId == nil
                    ? "Couldn't rename session: \(error.localizedDescription)"
                    : "Couldn't rename workspace: \(error.localizedDescription)"
            }
        }
    }

    private func isLocallyArchived(_ id: String) -> Bool {
        guard let entry = locallyArchived[id] else { return false }
        if Date().timeIntervalSince(entry.added) > 30 {
            locallyArchived.removeValue(forKey: id)
            return false
        }
        return true
    }

    private var locallyUnarchived: [String: Date] = [:]

    private func isLocallyUnarchived(_ id: String) -> Bool {
        guard let added = locallyUnarchived[id] else { return false }
        if Date().timeIntervalSince(added) > 30 {
            locallyUnarchived.removeValue(forKey: id)
            return false
        }
        return true
    }

    private func mergeOptimistic(into list: [Session]) -> [Session] {
        guard !optimistic.isEmpty else { return list }
        let serverIds = Set(list.map(\.id))
        var extras: [Session] = []
        for (id, entry) in optimistic {
            if serverIds.contains(id) || Date().timeIntervalSince(entry.added) > 120 {
                optimistic.removeValue(forKey: id)
            } else {
                extras.append(entry.session)
            }
        }
        return extras.isEmpty ? list : extras + list
    }

    func startPolling() {
        stopPolling()
        pollTask = Task {
            while !Task.isCancelled {
                await refresh()
                try? await Task.sleep(for: .seconds(5))
            }
        }
    }

    func stopPolling() {
        pollTask?.cancel()
        pollTask = nil
    }

    func refresh() async {
        // A tailnet server with the tunnel down answers nothing at all, and
        // URLSession takes a full minute to admit it. Ask why alongside the
        // first request instead of after its timeout — the banner is up in
        // milliseconds, and a request that lands clears it.
        if !hasLoaded { diagnoseUnreachableServer() }
        do {
            async let workspaceRequest = try? OS1API.workspaces()
            let all = try await OS1API.sessions()
            // Renames are held back rather than published on arrival: names
            // feed every row's title, so publishing them on their own would
            // strand the grouping cache and leave the next body to rebuild it
            // on the main actor. They go out below, with rows already built
            // from them.
            var renamed: [String: String]?
            if let workspaces = await workspaceRequest {
                let nextNames = Dictionary(uniqueKeysWithValues: workspaces.map { ($0.id, $0.name) })
                if nextNames != workspaceNames { renamed = nextNames }
            }
            // Snapshot the main-actor state the filter needs, then do the
            // heavy pass (thousands of rows) off the main thread — inline it
            // ran on the main actor every 5s poll and hitched typing.
            let hiddenIds = Set(Array(locallyArchived.keys).filter { isLocallyArchived($0) })
            let restoredIds = Set(Array(locallyUnarchived.keys).filter { isLocallyUnarchived($0) })
            let localArchivedRows = hiddenIds.compactMap { locallyArchived[$0]?.session }
            let hideKeys = Set(HideStore.shared.hides.keys)
            let prepared = await Task.detached(priority: .userInitiated) {
                Self.prepared(
                    all,
                    hiding: hiddenIds,
                    restoring: restoredIds,
                    hidden: hideKeys
                )
            }.value
            // A hidden row comes back while one of its sessions is blocked on a
            // question, and the entry is consumed when it does — so a hide can
            // never swallow work that needs you. Consuming it here (not in the
            // row filter) keeps the mutation out of view body evaluation.
            HideStore.shared.clear(prepared.resurfacedHideKeys)
            let next = mergeOptimistic(into: prepared.active)
            let serverArchivedIds = Set(prepared.archived.map(\.id))
            for id in serverArchivedIds {
                locallyArchived.removeValue(forKey: id)
            }
            let archivedNext = localArchivedRows.filter { !serverArchivedIds.contains($0.id) }
                + prepared.archived
            // Most 5s polls change nothing — skip the assignment so the whole
            // list doesn't re-diff (grouping, sorting, row rebuilds) for a
            // byte-identical result.
            if next != sessions || renamed != nil {
                // Group before publishing, not after: the assignment wakes
                // every observing view, so a grouping that starts afterwards
                // always loses the race to the body that needs it.
                let names = renamed ?? workspaceNames
                let grouped = await Self.groupedOffMain(next, workspaceNames: names)
                SessionLinks.register(titles: grouped.titles)
                if let renamed { workspaceNames = renamed }
                setSessions(next, rows: grouped.rows)
            }
            if archivedNext != archivedSessions {
                archivedSessions = archivedNext
            }
            error = nil
            loadFailure = nil
        } catch {
            // Keep showing the last good list; surface the error alongside it.
            let diagnosis = await Reachability.diagnose(error)
            // The banner sits over a list that's still good, so it takes the
            // headline: "Can't reach the server" is the news, and the system's
            // wording underneath it is for the screen that has room.
            self.error = diagnosis.isConnection ? diagnosis.title : diagnosis.detail
            self.loadFailure = diagnosis
        }
        hasLoaded = true
    }

    /// Name the reason a first load can't land while it's still trying. Only
    /// speaks up if the answer is still useful — a list that arrived in the
    /// meantime has already said more than any diagnosis could.
    ///
    /// It sets `loadFailure` and not `error`: the request hasn't failed yet,
    /// so this belongs under the spinner as a diagnosis, not in the red
    /// capsule reserved for something that actually went wrong.
    private func diagnoseUnreachableServer() {
        Task { [weak self] in
            guard let diagnosis = await Reachability.tailnetDiagnosis(),
                  let self, !self.hasLoaded
            else { return }
            self.loadFailure = diagnosis
        }
    }

    /// Drop archived/desk/locally-hidden rows and sort by last activity, and
    /// report which sidebar hides a blocked session resurfaces.
    /// Decorated sort on purpose: the comparator form re-parsed each row's
    /// ISO date ~2·log n times, which multiplied into hundreds of
    /// milliseconds per poll at this list size — parse once per row instead.
    nonisolated static func prepared(
        _ all: [Session],
        hiding hiddenIds: Set<String>,
        restoring restoredIds: Set<String>,
        hidden hideKeys: Set<String> = []
    ) -> (active: [Session], archived: [Session], resurfacedHideKeys: [String]) {
        let visible = all.filter { $0.desk != true }
        let active = visible
            .filter {
                ($0.archived != true || restoredIds.contains($0.id))
                    && !hiddenIds.contains($0.id)
            }
            .map { session -> Session in
                guard restoredIds.contains(session.id) else { return session }
                var restored = session
                restored.archived = false
                return restored
            }
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
        let archived = visible
            .filter { $0.archived == true && !restoredIds.contains($0.id) }
            .map { (session: $0, key: $0.lastActivityDate ?? .distantPast) }
            .sorted { $0.key > $1.key }
            .map(\.session)
        var resurfaced = Set<String>()
        if !hideKeys.isEmpty {
            for session in active where session.lane == .needsInput && !session.isAutomation {
                for key in SidebarRowKeys.candidateKeys(for: session) where hideKeys.contains(key) {
                    resurfaced.insert(key)
                }
            }
        }
        return (active, archived, Array(resurfaced))
    }
}

/// The web sidebar's Inbox bands: an email-style split of the rows by when
/// they last moved, with "blocked on you" lifted out in front.
enum InboxBand: String, CaseIterable {
    case needsAction, recent, yesterday, earlier

    var label: String {
        switch self {
        case .needsAction: "Needs action"
        case .recent: "Recent"
        case .yesterday: "Yesterday"
        case .earlier: "Earlier"
        }
    }
}

struct SidebarWorkspace: Identifiable, Equatable, Sendable {
    let id: String
    let title: String
    let sessions: [Session]
    let mainSession: Session

    var statusSession: Session {
        let humanSessions = sessions.filter { !$0.isAutomation }
        let candidates = humanSessions.isEmpty ? sessions : humanSessions
        return candidates.min { statusRank($0) < statusRank($1) } ?? mainSession
    }

    var lane: Session.Lane { statusSession.lane }
    var workspaceId: String? {
        sessions.compactMap(\.workspaceId).first { !$0.isEmpty }
    }
    var isOptimistic: Bool {
        sessions.contains(where: \.isOptimistic)
    }
    var effectiveRepo: String { mainSession.effectiveRepo }

    /// This row's page on the web app, for sharing: the workspace session URL
    /// when the row is a real workspace, the bare session URL otherwise.
    @MainActor var shareURL: URL? {
        guard let base = ServerConfig.shared.baseURL else { return nil }
        if let workspaceId = mainSession.workspaceId, !workspaceId.isEmpty {
            return base
                .appendingPathComponent("workspace")
                .appendingPathComponent(workspaceId)
                .appendingPathComponent("session")
                .appendingPathComponent(mainSession.id)
        }
        return base
            .appendingPathComponent("session")
            .appendingPathComponent(mainSession.id)
    }
    /// Any session of the row is mid-turn — the row counts as live even when a
    /// blocked sibling owns its lane.
    var isRunning: Bool { sessions.contains { $0.isRunning == true } }
    var lastActivityDate: Date {
        sessions.compactMap(\.lastActivityDate).max() ?? .distantPast
    }
    var createdDate: Date {
        sessions.compactMap { Session.parseISO($0.createdAt) }.min() ?? .distantPast
    }

    private func statusRank(_ session: Session) -> Int {
        switch session.lane {
        case .needsInput: 0
        case .inProgress: 1
        case .inReview: 2
        case .done: 3
        case .backlog: 4
        }
    }
}
