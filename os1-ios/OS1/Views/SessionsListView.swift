import Combine
import SwiftUI

/// Sessions list, mirroring the web sidebar's organization: group by Status
/// (In progress / Needs input / In review / Done / Backlog), by Repo, by Repo
/// and Status, by Repo and Inbox (each repo's rows banded by activity, the
/// web's Inbox mode nested per repo), or a flat Recent list — plus a repo
/// filter, sort, and search.
/// The grouping/filter choices persist like the web's filter popover does.
struct SessionsListView: View {
    enum GroupBy: String, CaseIterable {
        case status, repo
        case repoStatus = "repo-status"
        case repoInbox = "repo-inbox"
        case recent

        var label: String {
            switch self {
            case .status: "Status"
            case .repo: "Repo"
            case .repoStatus: "Repo and status"
            case .repoInbox: "Repo and inbox"
            case .recent: "Recently active"
            }
        }
    }

    enum SortBy: String, CaseIterable {
        case updated, created

        var label: String {
            switch self {
            case .updated: "Last activity"
            case .created: "Created"
            }
        }
    }

    @State private var viewModel = SessionsListViewModel()
    @State private var showSettings = false
    @State private var showDesk = false
    /// The push stack, typed rather than a `NavigationPath`, so a create that
    /// resolves after the person has navigated elsewhere can find its own
    /// pending entry instead of assuming it is still on top.
    @State private var path: [Session] = []
    @State private var searchText = ""
    /// Non-nil opens the new-session sheet; carries the per-repo "+" preset.
    @State private var newSessionRequest: NewSessionRequest?
    /// Opening prompts (and images) of just-created sessions, keyed by id —
    /// seeds the conversation view so it renders instantly instead of waiting
    /// for the server to persist the session.
    @State private var optimisticSeeds: [String: SessionViewModel.OptimisticSeed] = [:]
    /// Unsent composer state survives switching sibling tabs (whose
    /// SessionViewModel/socket is otherwise deliberately recreated).
    @State private var composerDrafts: [String: SessionViewModel.ComposerDraft] = [:]
    /// Temp IDs remain aliases through the outgoing view's onDisappear so a
    /// draft edited while session creation resolves is saved under the real ID.
    @State private var resolvedSessionIds: [String: String] = [:]
    /// Loaded transcripts for recently visited mobile conversations. The
    /// cache is bounded and cached view models disconnect while off-screen.
    @State private var sessionPageCache = SessionViewModelCache()
    /// Surfaced when a background session create fails after the sheet closed.
    @State private var createError: String?
    @State private var showArchived = false
    /// A tapped "Try again" on the unreachable screen, until it lands.
    @State private var isRetrying = false
    #if os(iOS)
    @State private var renamingWorkspace: SidebarWorkspace?
    @State private var renameText = ""
    @State private var detailsWorkspace: SidebarWorkspace?
    #endif

    struct NewSessionRequest: Identifiable {
        let id = UUID()
        var repo: String?
        /// Set when the create joins an existing workspace as a new tab (the
        /// session's ⋯ menu); nil starts a standalone session.
        var workspaceId: String?
    }

    @AppStorage("os1.list.groupBy") private var groupByRaw = GroupBy.repoStatus.rawValue
    @AppStorage("os1.list.repo") private var repoFilter = "all"
    @AppStorage("os1.list.sort") private var sortByRaw = SortBy.updated.rawValue
    // Default to the signed-in person's own sessions, like the web sidebar —
    // the server also hosts hundreds of automation runs and teammates' sessions.
    @AppStorage("os1.list.people") private var peopleFilter = "mine"
    @AppStorage("os1.sidebar.repoOrder") private var preferredRepoOrder = "[]"
    /// Section headings the person has folded shut — repo bands, status lanes
    /// and inbox bands, keyed like the web sidebar's collapse state and stored
    /// as a JSON array so the choice survives relaunches.
    @AppStorage("os1.list.collapsed") private var collapsedGroupsRaw = "[]"

    private var groupBy: GroupBy { GroupBy(rawValue: groupByRaw) ?? .repoStatus }
    private var sortBy: SortBy { SortBy(rawValue: sortByRaw) ?? .updated }

    private var collapsedGroups: Set<String> {
        guard let data = collapsedGroupsRaw.data(using: .utf8),
              let keys = try? JSONDecoder().decode([String].self, from: data)
        else { return [] }
        return Set(keys)
    }

    private func isCollapsed(_ key: String) -> Bool {
        collapsedGroups.contains(key)
    }

    /// The same key a plain "Repo" group carries, so folding a repo shut in
    /// one grouping keeps it shut in the other.
    private func repoBandKey(_ repo: String) -> String { "repo-\(repo)" }

    private func toggleCollapsed(_ key: String) {
        var keys = collapsedGroups
        if keys.contains(key) {
            keys.remove(key)
        } else {
            keys.insert(key)
        }
        guard let data = try? JSONEncoder().encode(keys.sorted()),
              let raw = String(data: data, encoding: .utf8)
        else { return }
        withAnimation(.snappy(duration: 0.25)) {
            collapsedGroupsRaw = raw
        }
    }

    /// A folded section still shows the open session, so the row you're
    /// reading never disappears out from under the selection — the same rule
    /// the web sidebar applies to its collapsed lanes.
    private func showsWhileCollapsed(_ workspace: SidebarWorkspace) -> Bool {
        #if os(macOS)
        guard let selectedSessionID else { return false }
        return workspace.sessions.contains { $0.id == selectedSessionID }
        #else
        return false
        #endif
    }

    private func visibleWorkspaces(
        _ workspaces: [SidebarWorkspace],
        collapsedKey: String
    ) -> [SidebarWorkspace] {
        guard isCollapsed(collapsedKey) else { return workspaces }
        return workspaces.filter(showsWhileCollapsed)
    }

    #if os(macOS)
    @State private var selectedSessionID: String?
    #endif

    var body: some View {
        navigationContainer
            // Session-id links in agent output (SessionLinks) are ordinary
            // markdown links on a private scheme; catching them here — above
            // the navigation container — is what lets a transcript push the
            // worker it spawned instead of leaving the id as dead text.
            .environment(\.openURL, OpenURLAction { url in
                guard let id = SessionLinks.sessionId(from: url) else {
                    return .systemAction
                }
                return openSessionLink(id: id)
            })
            .task {
                viewModel.startPolling()
            }
            .onDisappear {
                viewModel.stopPolling()
            }
            .onChange(of: sessionCacheScope) {
                sessionPageCache.removeAll()
            }
            #if os(macOS)
            // File > New Session (Cmd+N) from the app's menu commands.
            .onReceive(NotificationCenter.default.publisher(for: .os1NewSession)) { _ in
                newSessionRequest = NewSessionRequest()
            }
            #endif
            .onChange(of: viewModel.hasLoaded) {
                autoOpenFromEnvironment()
            }
            .alert(
                "Couldn't start session",
                isPresented: Binding(
                    get: { createError != nil },
                    set: { if !$0 { createError = nil } }
                )
            ) {
                Button("OK", role: .cancel) {}
            } message: {
                Text(createError ?? "")
            }
            #if os(iOS)
            .alert(
                "Rename workspace",
                isPresented: Binding(
                    get: { renamingWorkspace != nil },
                    set: { if !$0 { renamingWorkspace = nil } }
                ),
                presenting: renamingWorkspace
            ) { workspace in
                TextField("Workspace name", text: $renameText)
                Button("Cancel", role: .cancel) {}
                Button("Rename") {
                    viewModel.rename(workspace, to: renameText)
                }
                .disabled(
                    workspace.workspaceId != nil
                        && renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
            } message: { _ in
                Text("Choose a name for this workspace.")
            }
            .sheet(item: $detailsWorkspace) { workspace in
                WorktreeInfoSheet(workspace: workspace, listViewModel: viewModel)
                    .presentationDetents([.large])
                    .presentationDragIndicator(.visible)
            }
            #endif
    }

    #if os(macOS)
    /// Mac: sessions live in a sidebar and the selected one opens in the
    /// detail column (like the web app), instead of iOS push navigation.
    private var navigationContainer: some View {
        NavigationSplitView {
            VStack(spacing: 0) {
                macSidebarHeader
                Divider()
                loadingOrList
            }
                .navigationSplitViewColumnWidth(min: 240, ideal: 300, max: 420)
        } detail: {
            if let selectedSessionID,
               let session = viewModel.sessions.first(where: { $0.id == selectedSessionID }) {
                SessionView(
                    session: session,
                    seed: optimisticSeeds[session.id],
                    workspaceNames: viewModel.workspaceNames
                )
                    // Fresh view (and socket) per session, not a reused one.
                    .id(selectedSessionID)
                    // The selected session reads as read, and keeps re-marking as
                    // the poll hands it fresher activity — see SessionTabsView
                    // for the same rule on the iOS stack.
                    .onChange(of: session, initial: true) { _, open in
                        ReadsStore.shared.open(open)
                    }
                    .onDisappear { ReadsStore.shared.close(session.id) }
            } else {
                ContentUnavailableView(
                    "Select a session",
                    systemImage: "bubble.left.and.bubble.right"
                )
            }
        }
        .sheet(item: $newSessionRequest) { request in
            NewSessionView(
                initialRepo: request.repo,
                initialWorkspaceId: request.workspaceId
            ) { session, seed in
                openOptimistic(session, seed: seed)
            } onResolved: { tempId, result in
                resolveCreate(tempId: tempId, result: result)
            }
        }
        .sheet(isPresented: $showArchived) {
            ArchivedSessionsView(
                sessions: visibleArchivedSessions,
                onRestore: viewModel.unarchive
            )
        }
        .sheet(isPresented: $showDesk) {
            DeskSheet()
                .frame(minWidth: 520, minHeight: 600)
        }
        .safeAreaInset(edge: .bottom) {
            errorBanner
        }
    }

    /// A stable in-sidebar hierarchy avoids three unrelated icon buttons
    /// floating in the unified window toolbar. Settings remains available in
    /// the app menu (Cmd+,), where Mac users expect it.
    private var macSidebarHeader: some View {
        VStack(alignment: .leading, spacing: 9) {
            HStack(spacing: 7) {
                Text("Sessions")
                    .font(.headline)
                Text("\(viewModel.sessions.count)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(OS1VisualStyle.textFaint)
                Spacer(minLength: 8)
                filterMenu
                    .menuStyle(.borderlessButton)
                    .menuIndicator(.hidden)
                    .controlSize(.small)
                    .help("Filter, group, and sort sessions")
                Button {
                    showDesk = true
                } label: {
                    Image(systemName: "lamp.desk")
                }
                .controlSize(.small)
                .help("Open the Desk")
                Button {
                    newSessionRequest = NewSessionRequest()
                } label: {
                    Label("New", systemImage: "plus")
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.small)
                .help("New session (Command-N)")
            }

            HStack(spacing: 7) {
                Image(systemName: "magnifyingglass")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
                TextField("Search sessions", text: $searchText)
                    .textFieldStyle(.plain)
                if !searchText.isEmpty {
                    Button {
                        searchText = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel("Clear search")
                }
            }
            .padding(.horizontal, 9)
            .frame(height: 28)
            .background(.fill.tertiary, in: RoundedRectangle(cornerRadius: 7))
        }
        .padding(.horizontal, 12)
        .padding(.top, 10)
        .padding(.bottom, 11)
        .background(.bar)
    }
    #else
    private var navigationContainer: some View {
        NavigationStack(path: $path) {
            loadingOrList
                .inlineTitleBarCompat()
                .toolbar {
                    ToolbarItem(placement: .topLeadingCompat) {
                        Button {
                            showSettings = true
                        } label: {
                            RepoTile(name: "opensession", size: 44, round: true)
                        }
                        .accessibilityLabel("Settings")
                        // Hiding the glass background leaves the padding the
                        // capsule reserved, so the bare tile sat at ~34pt while
                        // every visible thing under it — repo icons, status
                        // dots, PR glyphs — starts at 20pt. Pull it back onto
                        // that column.
                        .padding(.leading, -14)
                    }
                    // The bare app tile is the control; the toolbar's glass
                    // circle around it read as a stray border.
                    .sharedBackgroundVisibility(.hidden)
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button {
                            showDesk = true
                        } label: {
                            Image(systemName: "lamp.desk")
                                .foregroundStyle(OS1VisualStyle.text)
                        }
                        .accessibilityLabel("Open the Desk")
                    }
                    ToolbarItem(placement: .topTrailingCompat) {
                        filterMenu
                    }
                    // New session lives in the top bar; search moved into the
                    // system bottom search field, which owns the bottom edge.
                    ToolbarItem(placement: .topTrailingCompat) {
                        Button {
                            newSessionRequest = NewSessionRequest()
                        } label: {
                            Image(systemName: "plus")
                                // Neutral, not the red accent: the plus is
                                // chrome, not an alert.
                                .foregroundStyle(OS1VisualStyle.text)
                        }
                        .accessibilityLabel("New session")
                    }
                }
                .sheet(isPresented: $showSettings) {
                    SettingsView()
                }
                .sheet(isPresented: $showDesk) {
                    DeskSheet()
                        .presentationDetents([.large])
                        .presentationDragIndicator(.visible)
                }
                .sheet(item: $newSessionRequest) { request in
                    NewSessionView(
                        initialRepo: request.repo,
                        initialWorkspaceId: request.workspaceId
                    ) { session, seed in
                        openOptimistic(session, seed: seed)
                    } onResolved: { tempId, result in
                        resolveCreate(tempId: tempId, result: result)
                    }
                }
                .sheet(isPresented: $showArchived) {
                    ArchivedSessionsView(
                        sessions: visibleArchivedSessions,
                        onRestore: viewModel.unarchive
                    )
                }
                .safeAreaInset(edge: .bottom) {
                    errorBanner
                }
        }
    }
    #endif

    @ViewBuilder
    private var loadingOrList: some View {
        if !viewModel.hasLoaded {
            loadingState
        } else if hasNoRows {
            if let failure = viewModel.loadFailure {
                unreachableState(failure)
            } else {
                emptyState
            }
        } else {
            list
        }
    }

    private var hasNoRows: Bool {
        viewModel.sessions.isEmpty && viewModel.archivedSessions.isEmpty
    }

    /// True while the whole screen is given over to a failed load — which is
    /// also the one time the banner has nothing to add.
    private var showsFailureScreen: Bool {
        viewModel.hasLoaded && hasNoRows && viewModel.loadFailure != nil
    }

    /// The first load. A tailnet server with the tunnel down answers nothing
    /// for a full minute, and a bare spinner spends that minute saying
    /// nothing — so the diagnosis joins it as soon as there is one.
    private var loadingState: some View {
        VStack(spacing: 14) {
            ProgressView()
            if let failure = viewModel.loadFailure {
                VStack(spacing: 3) {
                    Text(failure.title)
                        .font(.subheadline.weight(.medium))
                        .foregroundStyle(OS1VisualStyle.text)
                    Text(failure.fix ?? failure.detail)
                        .font(.footnote)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .multilineTextAlignment(.center)
                .frame(maxWidth: 300)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .animation(.easeOut(duration: 0.2), value: viewModel.loadFailure)
    }

    /// Floating glass capsule, matching the session view's banner styling,
    /// instead of a full-width opaque bar.
    ///
    /// Silent while the failure screen is up: the same sentence twice, once
    /// mid-screen and once in red at the bottom, reads as two problems.
    @ViewBuilder
    private var errorBanner: some View {
        if let error = viewModel.error, !showsFailureScreen {
            Text(error)
                .font(.footnote)
                .foregroundStyle(.red)
                .lineLimit(2)
                .padding(.horizontal, 14)
                .padding(.vertical, 7)
                .glassSurface(in: Capsule())
                .padding(.bottom, 8)
        }
    }

    /// Follow a `bks-…` link from a transcript. A session we're already
    /// polling opens in place; one we've never seen (archived away, another
    /// server, deleted) can't be pushed, so it hands off to the web app rather
    /// than dropping the tap silently.
    private func openSessionLink(id: String) -> OpenURLAction.Result {
        if let session = viewModel.sessions.first(where: { $0.id == id })
            ?? viewModel.archivedSessions.first(where: { $0.id == id }) {
            #if os(macOS)
            selectedSessionID = session.id
            #else
            path.append(session)
            #endif
            return .handled
        }
        guard let base = ServerConfig.shared.baseURL else { return .handled }
        return .systemAction(
            base.appendingPathComponent("session").appendingPathComponent(id)
        )
    }

    /// Dev convenience for simulator runs: OS1_OPEN_SESSION=<id> jumps straight
    /// into that session once the list has loaded.
    private func autoOpenFromEnvironment() {
        guard let id = ProcessInfo.processInfo.environment["OS1_OPEN_SESSION"],
              let session = viewModel.sessions.first(where: { $0.id == id })
        else { return }
        #if os(macOS)
        if selectedSessionID == nil { selectedSessionID = session.id }
        #else
        if path.isEmpty { path.append(session) }
        #endif
    }

    /// The moment Start is tapped: an optimistic row (temporary `pending-` id)
    /// joins the list and the conversation view opens seeded from the prompt —
    /// no waiting on the server. `resolveCreate` swaps in the real id (or
    /// rolls back) when the background create finishes.
    private func openOptimistic(
        _ session: Session, seed: SessionViewModel.OptimisticSeed
    ) {
        viewModel.addOptimistic(session)
        optimisticSeeds[session.id] = seed
        #if os(macOS)
        selectedSessionID = session.id
        #else
        path.append(session)
        #endif
    }

    /// The tab strip's "+" — a new session in a workspace opens as a tab right
    /// away, with no composer sheet in between. The server mints an EMPTY
    /// sibling that shares this workspace's worktree and branch; it carries no
    /// run until its first message, so there is no prompt to collect up front,
    /// and nothing the sheet would have asked for is still open (repo, branch
    /// and mode all come from the workspace).
    ///
    /// The create is awaited rather than optimistic: writing the session file
    /// is one round trip — no worktree to prepare — so the tab appears with a
    /// real id from its first frame, and a failure lands before there's a tab
    /// to tear down. The row is filed locally so the strip has it immediately
    /// instead of on the next poll.
    private func openSiblingTab(of source: Session) async -> Session? {
        do {
            let created = try await OS1API.newSiblingSession(from: source.id)
            viewModel.addOptimistic(created)
            return created
        } catch {
            createError = error.localizedDescription
            return nil
        }
    }

    /// The background create finished: move the pending row (and the open
    /// conversation) onto the server's real id, or roll the pending row back
    /// and surface the error.
    private func resolveCreate(tempId: String, result: Result<String, Error>) {
        switch result {
        case .success(let id):
            viewModel.resolveOptimistic(tempId: tempId, realId: id)
            sessionPageCache.remove(sessionId: tempId)
            resolvedSessionIds[tempId] = id
            if let seed = optimisticSeeds.removeValue(forKey: tempId) {
                optimisticSeeds[id] = seed
            }
            if let draft = composerDrafts.removeValue(forKey: tempId) {
                composerDrafts[id] = draft
            }
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = id }
            #else
            // Swap the pending entry wherever it sits in the stack, rather
            // than whatever happens to be on top: worktree prep takes seconds,
            // and by the time it lands the person may have gone back and
            // opened a different session — replacing the top would yank them
            // into the session they started earlier.
            if let index = path.firstIndex(where: { $0.id == tempId }),
               let session = viewModel.sessions.first(where: { $0.id == id }) {
                var next = path
                next[index] = session
                // No visible pop/push double transition.
                var transaction = Transaction()
                transaction.disablesAnimations = true
                withTransaction(transaction) {
                    path = next
                }
            }
            #endif
        case .failure(let error):
            viewModel.removeOptimistic(tempId)
            sessionPageCache.remove(sessionId: tempId)
            optimisticSeeds[tempId] = nil
            #if os(macOS)
            if selectedSessionID == tempId { selectedSessionID = nil }
            #else
            // Same care as the success path: drop the failed session's own
            // screen, not whatever the person is looking at now.
            path.removeAll { $0.id == tempId }
            #endif
            createError = error.localizedDescription
        }
    }

    // ── Filtering / grouping ──────────────────────────────────────────────

    private var availableRepos: [String] {
        SessionsListViewModel.repositoryOrder(
            in: viewModel.sessions,
            preferredOrderJSON: preferredRepoOrder
        )
    }

    /// Identity strings that count as "me": display name, its first token
    /// (sessions store first names, e.g. "Jaap"), and the GitHub login.
    private var myNames: Set<String> {
        var names: Set<String> = []
        let user = ServerConfig.shared.userName.trimmingCharacters(in: .whitespaces)
        if !user.isEmpty {
            names.insert(user.lowercased())
            if let first = user.split(separator: " ").first {
                names.insert(first.lowercased())
            }
        }
        let login = ServerConfig.shared.githubLogin
        if !login.isEmpty { names.insert(login.lowercased()) }
        return names
    }

    private func isMine(_ session: Session) -> Bool {
        guard !session.isAutomation, let by = session.startedBy?.lowercased() else { return false }
        return myNames.contains(by)
    }

    private var visibleArchivedSessions: [Session] {
        viewModel.archivedSessions.filter { session in
            (peopleFilter != "mine" || isMine(session))
                && (repoFilter == "all" || session.effectiveRepo == repoFilter)
        }
    }

    /// The current lens as one predicate, with its inputs read once.
    ///
    /// Hides stay here rather than in the view model's grouping: the hide map
    /// changes independently of the session list, so a hidden row has to
    /// disappear on the tap, not on the next poll.
    private func visibilityFilter() -> (SidebarWorkspace) -> Bool {
        let people = peopleFilter
        let repo = repoFilter
        let query = searchText.trimmingCharacters(in: .whitespaces).lowercased()
        // Rows this person has hidden drop out of the sidebar — except while
        // a session of theirs is blocked on a question (the poll consumes the
        // hide when that happens), and except while searching, which is how a
        // hidden row is found again so its menu can restore it.
        #if os(iOS)
        let hides = query.isEmpty ? HideStore.shared.hides : [:]
        #endif
        return { workspace in
            #if os(iOS)
            if !hides.isEmpty, workspace.lane != .needsInput,
               hides[SidebarRowKeys.rowKey(for: workspace)] != nil {
                return false
            }
            #endif
            if people == "mine", !workspace.sessions.contains(where: isMine) {
                return false
            }
            if repo != "all", workspace.effectiveRepo != repo { return false }
            guard !query.isEmpty else { return true }
            if workspace.title.lowercased().contains(query) { return true }
            return workspace.sessions.contains { session in
                [session.title, session.effectiveRepo, session.branch, session.id]
                    .compactMap { $0 }
                    .contains { $0.lowercased().contains(query) }
            }
        }
    }

    /// Whether anything survives the lens — the empty-state overlay's
    /// question. Stops at the first match instead of filtering and sorting
    /// the whole list a second time per body evaluation.
    private var hasVisibleWorkspaces: Bool {
        allSidebarWorkspaces.contains(where: visibilityFilter())
    }

    private var filteredWorkspaces: [SidebarWorkspace] {
        let workspaces = allSidebarWorkspaces.filter(visibilityFilter())
        // Decorated sort: parse each row's date once, not once per
        // comparison — this runs on the main thread on every body
        // evaluation, and the list can be thousands of rows with the
        // people filter set to "everyone".
        return workspaces
            .map { workspace in
                (
                    workspace: workspace,
                    inProgress: workspace.lane == .inProgress,
                    date: sortBy == .updated
                        ? workspace.lastActivityDate
                        : workspace.createdDate
                )
            }
            .sorted {
                if $0.inProgress != $1.inProgress { return $0.inProgress }
                return $0.date > $1.date
            }
            .map(\.workspace)
    }

    /// Grouped once by the view model, not per read: several properties below
    /// (`filteredWorkspaces`, the empty-state overlay, the tab-strip lookup)
    /// each want the rows, and regrouping thousands of sessions inside a body
    /// evaluation is what used to pin the main thread on launch.
    private var allSidebarWorkspaces: [SidebarWorkspace] {
        viewModel.sidebarWorkspaces
    }

    private struct SessionGroup: Identifiable {
        let id: String
        let title: String
        let workspaces: [SidebarWorkspace]
        let repo: String?
    }

    private struct RepoSessionGroup: Identifiable {
        let repo: String
        let workspaces: [SidebarWorkspace]
        /// The sections nested under the repo band: status lanes in "Repo and
        /// status", activity bands in "Repo and inbox".
        let lanes: [SessionGroup]

        var id: String { repo }
    }

    private var groups: [SessionGroup] {
        let workspaces = filteredWorkspaces
        switch groupBy {
        case .recent:
            return workspaces.isEmpty
                ? []
                : [SessionGroup(
                    id: "recent",
                    title: "",
                    workspaces: workspaces,
                    repo: nil
                )]
        case .repo:
            let byRepo = Dictionary(grouping: workspaces, by: \.effectiveRepo)
            return availableRepos.filter { byRepo[$0] != nil }.map {
                SessionGroup(
                    id: "repo-\($0)",
                    title: $0,
                    workspaces: byRepo[$0]!,
                    repo: $0
                )
            }
        case .status:
            return Session.Lane.allCases.compactMap { lane in
                let inLane = workspaces.filter { $0.lane == lane }
                return inLane.isEmpty
                    ? nil
                    : SessionGroup(
                        id: "lane-\(lane.rawValue)",
                        title: lane.label,
                        workspaces: inLane,
                        repo: nil
                    )
            }
        case .repoStatus, .repoInbox:
            // Both nest their sections under repo bands — see
            // repoSessionGroups / repoInboxGroups.
            return []
        }
    }

    private var repoSessionGroups: [RepoSessionGroup] {
        let byRepo = Dictionary(grouping: filteredWorkspaces, by: \.effectiveRepo)
        return availableRepos.compactMap { repo in
            guard let workspaces = byRepo[repo] else { return nil }
            let lanes = Session.Lane.allCases.compactMap { lane in
                let inLane = workspaces.filter { $0.lane == lane }
                return inLane.isEmpty
                    ? nil
                    : SessionGroup(
                        id: "repo-\(repo)-lane-\(lane.rawValue)",
                        title: lane.label,
                        workspaces: inLane,
                        repo: nil
                    )
            }
            return RepoSessionGroup(repo: repo, workspaces: workspaces, lanes: lanes)
        }
    }

    /// "Repo and inbox": the same repo bands, with each repo's rows split into
    /// the Inbox activity bands instead of status lanes.
    private var repoInboxGroups: [RepoSessionGroup] {
        let byRepo = Dictionary(grouping: filteredWorkspaces, by: \.effectiveRepo)
        return availableRepos.compactMap { repo in
            guard let workspaces = byRepo[repo] else { return nil }
            let bands = SessionsListViewModel.inboxBands(workspaces).map { band in
                SessionGroup(
                    id: "repo-\(repo)-band-\(band.band.rawValue)",
                    title: band.band.label,
                    workspaces: band.workspaces,
                    repo: nil
                )
            }
            return RepoSessionGroup(repo: repo, workspaces: workspaces, lanes: bands)
        }
    }

    private var filterMenu: some View {
        Menu {
            Picker("Show", selection: $peopleFilter) {
                Text("My sessions").tag("mine")
                Text("Everyone").tag("all")
            }
            Picker("Group by", selection: $groupByRaw) {
                ForEach(GroupBy.allCases, id: \.rawValue) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
            Picker("Repo", selection: $repoFilter) {
                Text("All repos").tag("all")
                ForEach(availableRepos, id: \.self) { repo in
                    Text(repo).tag(repo)
                }
            }
            .pickerStyle(.menu)
            Picker("Sort by", selection: $sortByRaw) {
                ForEach(SortBy.allCases, id: \.rawValue) { option in
                    Text(option.label).tag(option.rawValue)
                }
            }
        } label: {
            #if os(macOS)
            Image(
                systemName: repoFilter == "all"
                    ? "line.3.horizontal.decrease"
                    : "line.3.horizontal.decrease.circle.fill"
            )
            .font(.system(size: 13, weight: .medium))
            .foregroundStyle(repoFilter == "all" ? OS1VisualStyle.textDim : OS1VisualStyle.accent)
            .frame(width: 26, height: 24)
            .contentShape(Rectangle())
            #else
            WebIcon(
                kind: .filter,
                size: 24,
                color: repoFilter == "all"
                    ? OS1VisualStyle.textDim
                    : OS1VisualStyle.accent
            )
            #endif
        }
        .accessibilityLabel("Filter sessions")
        .accessibilityValue(filterAccessibilityValue)
    }

    private var filterAccessibilityValue: String {
        let people = peopleFilter == "mine" ? "My sessions" : "Everyone"
        let repo = repoFilter == "all" ? "All repositories" : RepoTile.label(for: repoFilter)
        return "\(people), grouped by \(groupBy.label), \(repo), sorted by \(sortBy.label)"
    }

    // ── List body ─────────────────────────────────────────────────────────

    #if os(macOS)
    private var list: some View {
        List(selection: $selectedSessionID) {
            listSections
        }
        .listStyle(.sidebar)
        .overlay { emptyFilterOverlay }
        // Delete key archives the selected session — the Mac-native
        // counterpart to iOS's swipe.
        .onDeleteCommand {
            if let selectedSessionID,
               let workspace = allSidebarWorkspaces.first(where: {
                   $0.sessions.contains { $0.id == selectedSessionID }
               }) {
                archive(workspace)
            }
        }
    }
    #else
    private var list: some View {
        List {
            listSections
        }
        .listStyle(.plain)
        // The 44pt floor exists for rows that don't state their own height;
        // ours all do, and all it did here was inflate the lane headings into
        // full-height rows. Rows carry the touch metrics in their own padding
        // (which is why SessionRow pads to 13 rather than 11).
        .environment(\.defaultMinListRowHeight, 8)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        .listSectionSpacing(10)
        .contentMargins(.top, 4, for: .scrollContent)
        // The system search field: iOS 26 places it at the bottom edge on
        // iPhone (the Liquid Glass search treatment), replacing the old
        // toolbar toggle + inline field.
        .searchable(text: $searchText, prompt: "Search sessions")
        .overlay { emptyFilterOverlay }
        .refreshable {
            await viewModel.refresh()
        }
        .navigationDestination(for: Session.self) { session in
            SessionTabsView(
                session: session,
                tabs: SessionsListViewModel.tabSessions(
                    in: viewModel.sessions,
                    containing: session
                ),
                workspaceNames: viewModel.workspaceNames,
                viewModelForSession: {
                    sessionPageCache.viewModel(
                        for: $0,
                        scope: sessionCacheScope,
                        seed: optimisticSeeds[$0.id],
                        composerDraft: composerDrafts[$0.id]
                    )
                },
                onSaveComposerDraft: { savedSession, draft in
                    let id = resolvedSessionIds[savedSession.id] ?? savedSession.id
                    composerDrafts[id] = draft.isEmpty ? nil : draft
                },
                onNewSession: {
                    // The session's ⋯ → "New session in this workspace": a sibling
                    // tab, not a standalone session. The workspace id comes from
                    // the latest polled copy — the row NavigationPath retained
                    // predates a workspace this session may have joined since.
                    let current = viewModel.sessions.first { $0.id == session.id } ?? session
                    guard current.workspaceId?.isEmpty == false else {
                        // A workspace-less legacy session has no strip to join,
                        // so the composer sheet stays the way in — it's a
                        // standalone session, and its repo/mode are still open
                        // questions.
                        newSessionRequest = NewSessionRequest(repo: session.effectiveRepo)
                        return nil
                    }
                    return await openSiblingTab(of: current)
                },
                onRenameWorkspace: { name in
                    guard let workspace = workspace(containing: session) else { return }
                    viewModel.rename(workspace, to: name)
                },
                onArchiveWorkspace: {
                    guard let workspace = workspace(containing: session) else { return }
                    archive(workspace)
                },
                onCloseTab: { closed in
                    sessionPageCache.remove(sessionId: closed.id)
                    viewModel.archive(closed)
                }
            )
            .id(session.id)
        }
    }
    #endif

    @ViewBuilder
    private func sessionRow(_ workspace: SidebarWorkspace) -> some View {
        let session = workspace.mainSession
        let canArchive = !workspace.isOptimistic
        #if os(macOS)
        // Selection drives the detail column; select by id so rows replaced
        // by polling (fresh struct values every refresh) keep the selection.
        // Archiving is Mac-idiomatic here: hover button on the row, context
        // menu, and the Delete key — swipe also works but isn't the primary.
        SessionRow(
            session: workspace.statusSession,
            title: workspace.title,
            sessions: workspace.sessions,
            onArchive: canArchive ? { archive(workspace) } : nil
        )
        .tag(session.id)
        .swipeActions(edge: .trailing) { archiveButton(workspace, viaSwipe: true) }
        .contextMenu { archiveButton(workspace) }
        #else
        Button {
            path.append(session)
        } label: {
            SessionRow(
                session: workspace.statusSession,
                title: workspace.title,
                sessions: workspace.sessions
            )
        }
        .buttonStyle(.plain)
        .listRowInsets(EdgeInsets(top: 2, leading: 16, bottom: 2, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .swipeActions(edge: .trailing) { archiveButton(workspace, viaSwipe: true) }
        // Swipe right to pin, left to archive: the pin is the reversible one,
        // so it takes the leading edge (and its full swipe just toggles).
        .swipeActions(edge: .leading) { pinButton(workspace) }
        .contextMenu {
            if canArchive { workspaceMenu(workspace) }
        }
        #endif
    }

    #if os(iOS)
    /// Leading swipe (and context menu) action. Non-destructive: the row stays
    /// where it is and gains a copy in the Pinned band, so the cell just closes
    /// — no `.destructive` role, and the toggle animates the band's insert.
    @ViewBuilder
    private func pinButton(_ workspace: SidebarWorkspace) -> some View {
        if !workspace.isOptimistic {
            let pinned = PinStore.shared.isPinned(workspace)
            Button {
                withAnimation(.snappy(duration: 0.28)) {
                    PinStore.shared.toggle(workspace)
                }
            } label: {
                Label(pinned ? "Unpin" : "Pin", systemImage: pinned ? "pin.slash.fill" : "pin.fill")
            }
            .tint(OS1VisualStyle.yellow)
        }
    }

    @ViewBuilder
    private func workspaceMenu(_ workspace: SidebarWorkspace) -> some View {
        // Same action as the leading swipe, for anyone who reaches for the
        // long press instead.
        pinButton(workspace)

        Button {
            detailsWorkspace = workspace
        } label: {
            Label("Worktree details", systemImage: "info.circle")
        }

        Button {
            renameText = workspace.title
            renamingWorkspace = workspace
        } label: {
            Label("Rename", systemImage: "pencil")
        }

        if let link = workspace.shareURL {
            ShareLink(item: link) {
                Label("Share link", systemImage: "square.and.arrow.up")
            }
        }

        let prLink = workspace.statusSession.prUrl ?? workspace.sessions.compactMap(\.prUrl).first
        if let prURL = prLink.flatMap(URL.init(string:)) {
            Link(destination: prURL) {
                Label("Open pull request", systemImage: "arrow.triangle.pull")
            }
        }

        if !workspace.isOptimistic {
            Divider()
            // Hiding is the personal counterpart to archiving: the row leaves
            // YOUR sidebar (here and in the web one) while the session keeps
            // running for everyone else — so it isn't destructive-styled.
            if HideStore.shared.isHidden(workspace) {
                Button {
                    HideStore.shared.clear([SidebarRowKeys.rowKey(for: workspace)])
                } label: {
                    Label("Restore to my sidebar", systemImage: "eye")
                }
            } else {
                Button {
                    hide(workspace)
                } label: {
                    Label("Hide from my sidebar", systemImage: "eye.slash")
                }
            }
            Button(role: .destructive) {
                archive(workspace)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
        }
    }

    private func hide(_ workspace: SidebarWorkspace) {
        withAnimation(.snappy(duration: 0.28)) {
            HideStore.shared.hide(workspace)
        }
    }

    /// The sidebar row a pushed session belongs to, so the session's own overflow
    /// menu can act on the whole worktree. Resolved ids first: a session pushed
    /// while it was still optimistic keeps its temp id in the stack.
    private func workspace(containing session: Session) -> SidebarWorkspace? {
        let id = resolvedSessionIds[session.id] ?? session.id
        return viewModel.sidebarWorkspaces.first { workspace in
            workspace.sessions.contains { $0.id == id }
        }
    }
    #endif

    /// Trailing swipe (and Mac context-menu) action. Hidden for optimistic
    /// rows — even after create returns a real id, the server may not have
    /// exposed the session through its cached list yet.
    ///
    /// The swipe variant is `role: .destructive` and skips our own
    /// `withAnimation`: the destructive role tells the List the row is going
    /// away, so a full swipe runs the system's native delete choreography
    /// (row slides off, neighbors close up). A non-destructive button first
    /// snaps the cell shut and then our animation re-ran the whole
    /// inset-grouped section reflow — visibly morphing iOS 26's
    /// position-dependent corner radii at our curve's pace.
    @ViewBuilder
    private func archiveButton(
        _ workspace: SidebarWorkspace,
        viaSwipe: Bool = false
    ) -> some View {
        if !workspace.isOptimistic {
            Button(role: viaSwipe ? .destructive : nil) {
                archive(workspace, animated: !viaSwipe)
            } label: {
                // A Label, not our own icon+text stack: a swipe action lays
                // out the system's label shape (glyph over caption, dropping
                // to the glyph alone in a short swipe), and a custom view is
                // rendered as its text only — which is why the archive glyph
                // never appeared. `archivebox` is the metaphor the overflow
                // menus here and in the session already use.
                Label("Archive", systemImage: "archivebox.fill")
            }
            // Red, matching the web sidebar's own swipe action at phone width
            // (.sidebar-swipe-action--archive, var(--red)): the same gesture on
            // the same row should not change colour between the two clients.
            // Our own palette rather than stock .red — see OS1VisualStyle.
            .tint(OS1VisualStyle.red)
        }
    }

    private func archive(_ workspace: SidebarWorkspace, animated: Bool = true) {
        workspace.sessions.forEach {
            sessionPageCache.remove(sessionId: $0.id)
        }
        #if os(iOS)
        // The server unpins archived work for everyone (`unpinEverywhere`);
        // dropping it locally too keeps the Pinned band from holding a row
        // that just left the list.
        PinStore.shared.unpin(workspace)
        #endif
        #if os(macOS)
        if workspace.sessions.contains(where: { $0.id == selectedSessionID }) {
            selectedSessionID = nil
        }
        #endif
        if animated {
            // Mac hover button / Delete key / context menu: collapse the row
            // instead of blinking it out.
            withAnimation(.snappy(duration: 0.28)) {
                workspace.sessions.forEach(viewModel.archive)
            }
        } else {
            // Swipe path: the List's destructive-role delete animation owns
            // the removal; wrapping the mutation would fight it.
            workspace.sessions.forEach(viewModel.archive)
        }
    }

    private var sessionCacheScope: SessionViewModelCache.Scope {
        let config = ServerConfig.shared
        return SessionViewModelCache.Scope(
            serverURL: config.baseURLString,
            token: config.token
        )
    }

    /// Rows this person pinned, lifted to the top of the list in their own pin
    /// order. They also stay in their normal band below: pinning is quick
    /// access, not a status — the rule the web sidebar's Pinned band follows.
    /// Built from the filtered rows, so the search field and the repo/people
    /// filters narrow the band like everything else.
    #if os(iOS)
    private var pinnedWorkspaces: [SidebarWorkspace] {
        let store = PinStore.shared
        guard !store.pins.isEmpty else { return [] }
        return filteredWorkspaces
            .compactMap { workspace in store.rank(workspace).map { (workspace, $0) } }
            .sorted { $0.1 < $1.1 }
            .map(\.0)
    }
    #endif

    private var listSections: some View {
        Group {
            #if os(iOS)
            if !pinnedWorkspaces.isEmpty {
                Section {
                    ForEach(
                        visibleWorkspaces(pinnedWorkspaces, collapsedKey: "pinned")
                    ) { workspace in
                        sessionRow(workspace)
                    }
                } header: {
                    groupHeader(
                        title: "Pinned",
                        count: pinnedWorkspaces.count,
                        collapseKey: "pinned"
                    )
                }
            }
            #endif

            if groupBy == .repoStatus || groupBy == .repoInbox {
                ForEach(groupBy == .repoInbox ? repoInboxGroups : repoSessionGroups) { repoGroup in
                    // Folding a repo band takes its lane headings with it —
                    // the band's own heading is the one thing left standing.
                    let bandKey = repoBandKey(repoGroup.repo)
                    Section {
                        if !isCollapsed(bandKey) {
                            ForEach(repoGroup.lanes) { laneGroup in
                                statusLaneHeader(laneGroup)
                                ForEach(
                                    visibleWorkspaces(
                                        laneGroup.workspaces,
                                        collapsedKey: laneGroup.id
                                    )
                                ) { workspace in
                                    sessionRow(workspace)
                                }
                            }
                        }
                    } header: {
                        groupHeader(
                            title: repoGroup.repo,
                            count: repoGroup.workspaces.count,
                            repo: repoGroup.repo,
                            collapseKey: bandKey
                        )
                    }
                }
            } else {
                ForEach(groups) { group in
                    Section {
                        ForEach(
                            visibleWorkspaces(group.workspaces, collapsedKey: group.id)
                        ) { workspace in
                            sessionRow(workspace)
                        }
                    } header: {
                        if !group.title.isEmpty {
                            groupHeader(
                                title: group.title,
                                count: group.workspaces.count,
                                repo: group.repo,
                                collapseKey: group.id
                            )
                        }
                    }
                }
            }

            if !visibleArchivedSessions.isEmpty {
                Section {
                    Button {
                        showArchived = true
                    } label: {
                        HStack(spacing: 9) {
                            #if os(iOS)
                            WebIcon(kind: .archive, size: 22, color: OS1VisualStyle.textDim)
                                .frame(width: 22, height: 22)
                            #else
                            WebIcon(kind: .archive, size: 16, color: OS1VisualStyle.textDim)
                                .frame(width: 16, height: 16)
                            #endif
                            Text("Archived")
                                #if os(iOS)
                                // Same type as a repo band: it's a row that
                                // leads somewhere, not a caption.
                                .font(.callout.weight(.medium))
                                #else
                                .font(.body)
                                #endif
                                .foregroundStyle(OS1VisualStyle.textDim)
                            Spacer()
                            Text("\(visibleArchivedSessions.count)")
                                .font(.footnote.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.textFaint)
                                #if os(iOS)
                                // Same trailing column as a row's run clock.
                                .padding(.trailing, 7)
                                #endif
                        }
                        #if os(iOS)
                        // Same reason as SessionRow's 13: no 44pt floor now.
                        .padding(.vertical, 11)
                        #else
                        .padding(.vertical, 3)
                        #endif
                        .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    #if os(iOS)
                    .listRowInsets(EdgeInsets(top: 2, leading: 12, bottom: 2, trailing: 16))
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
                    #endif
                }
            }
        }
    }

    @ViewBuilder
    private var emptyFilterOverlay: some View {
        if !hasVisibleWorkspaces && visibleArchivedSessions.isEmpty {
            if !searchText.isEmpty {
                ContentUnavailableView.search(text: searchText)
            } else if peopleFilter == "mine" {
                // Same look as the other two states on this screen: three
                // different placeholder styles on one list is what makes a
                // surface read as unfinished.
                ListPlaceholder(
                    symbol: "person.crop.circle",
                    title: "No sessions of yours yet",
                    message: "Sessions you start appear here."
                ) {
                    Button("New session") {
                        newSessionRequest = NewSessionRequest()
                    }
                    .buttonStyle(PlaceholderActionStyle())
                    Button("Show everyone's") { peopleFilter = "all" }
                        .buttonStyle(PlaceholderActionStyle(prominent: false))
                }
            }
        }
    }

    // Section and lane headings carry no status glyph of their own — like the
    // web sidebar, they're dividers, and the rows under them already wear the
    // status marks. What they do carry is the fold control: the heading is a
    // button, and its chevron says which way the section sits.
    private func groupHeader(
        title: String,
        count: Int,
        repo: String? = nil,
        collapseKey: String
    ) -> some View {
        HStack(spacing: 6) {
            // Only the naming half of the heading toggles the fold — the
            // repo's "+" stays its own target, and a Button nested inside
            // another swallows its taps on iOS.
            Button {
                toggleCollapsed(collapseKey)
            } label: {
                HStack(spacing: 6) {
                    if let repo {
                        #if os(iOS)
                        RepoTile(name: repo, size: 24)
                        #else
                        RepoTile(name: repo)
                        #endif
                    }
                    Text(repo.map { RepoTile.label(for: $0) } ?? title)
                        #if os(iOS)
                        // A repo band leads somewhere, so it's typed like the
                        // rows under it (web phone: 16px medium), not like the
                        // captions that only label them.
                        .font(.callout.weight(.medium))
                        #else
                        .font(.caption.weight(.semibold))
                        #endif
                    Text("\(count)")
                        #if os(iOS)
                        .font(.footnote.weight(.medium))
                        #else
                        .font(.caption.monospacedDigit())
                        #endif
                    collapseChevron(collapseKey)
                    // Without a trailing "+" to push against, stretch the
                    // heading so the whole line takes the tap.
                    if repo == nil {
                        Spacer(minLength: 0)
                    }
                }
                .foregroundStyle(OS1VisualStyle.textDim)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(collapseLabel(repo.map { RepoTile.label(for: $0) } ?? title, collapseKey))
            if let repo {
                Spacer(minLength: 8)
                Button {
                    newSessionRequest = NewSessionRequest(repo: repo)
                } label: {
                    Image(systemName: "plus")
                        #if os(iOS)
                        .font(.system(size: 18, weight: .medium))
                        .frame(width: 30, height: 30)
                        #else
                        .font(.system(size: 12, weight: .medium))
                        .frame(width: 20, height: 20)
                        #endif
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .buttonStyle(.borderless)
                .accessibilityLabel("New session in \(RepoTile.label(for: repo))")
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .textCase(nil)
        .padding(.top, 4)
        #if os(iOS)
        // Lopsided on purpose, like the lane headings below it: a band leads
        // the rows under it, so it sits nearer to them than to whatever came
        // before. The list's own header inset is what's being trimmed, hence
        // the negative value.
        .padding(.bottom, -3)
        #endif
    }

    /// A lane heading labels the rows under it, so its own insets are
    /// lopsided on purpose: air above to separate it from the previous lane,
    /// less below so the label reads as attached to its rows. The pair is
    /// measured off the web sidebar at phone width, where the same caption
    /// sits 19pt below the previous lane's last row and 9pt above its own
    /// first one (`.sidebar-lane-group` header: 8px group margin + 9/5px
    /// padding); the rows' own 2pt insets make up the rest. Those insets only
    /// bite because the list drops its 44pt minimum row height (see `list`) —
    /// that floor stretched the caption to a full row and left the label
    /// marooned in the middle of it.
    private func statusLaneHeader(_ group: SessionGroup) -> some View {
        Button {
            toggleCollapsed(group.id)
        } label: {
            HStack(spacing: 5) {
                // Captions, a size below the rows — the web's
                // `.sidebar-lane-group` pair at its phone step (13px semibold
                // label, 12px count).
                Text(group.title)
                    .font(.footnote.weight(.semibold))
                Text("\(group.workspaces.count)")
                    .font(.caption.monospacedDigit())
            }
            .foregroundStyle(OS1VisualStyle.textDim)
            .frame(maxWidth: .infinity, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(collapseLabel(group.title, group.id))
        .listRowInsets(EdgeInsets(top: 17, leading: 16, bottom: 7, trailing: 16))
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
    }

    /// The fold marker: points down when the section is open, right when it's
    /// shut — same language as the web sidebar's group chevron.
    private func collapseChevron(_ key: String) -> some View {
        Image(systemName: "chevron.down")
            #if os(iOS)
            .font(.system(size: 11, weight: .semibold))
            #else
            .font(.system(size: 9, weight: .semibold))
            #endif
            .foregroundStyle(OS1VisualStyle.textFaint)
            .rotationEffect(.degrees(isCollapsed(key) ? -90 : 0))
    }

    private func collapseLabel(_ title: String, _ key: String) -> String {
        isCollapsed(key) ? "\(title), collapsed" : "\(title), expanded"
    }

    private var emptyState: some View {
        ListPlaceholder(
            symbol: "bubble.left.and.bubble.right",
            title: "No sessions",
            message: "Start one and it shows up here."
        ) {
            // The only thing worth offering here. Settings used to sit under
            // it, but the app tile in the corner is already that door — a
            // placeholder shouldn't spend its one moment of attention
            // pointing at chrome that never left the screen.
            Button("New session") { newSessionRequest = NewSessionRequest() }
                .buttonStyle(PlaceholderActionStyle())
        }
    }

    /// The list is empty because nothing came back, which is a different
    /// screen from an empty list: "No sessions" reads as a server with
    /// nothing on it, when the truth is a dropped tailnet or a dead signal
    /// and the fix is nowhere near Settings. So the failure gets the
    /// headline, the server we couldn't reach gets named, and the first
    /// button is the one that answers a connection problem.
    private func unreachableState(_ failure: Reachability.Diagnosis) -> some View {
        ListPlaceholder(
            symbol: failure.isConnection
                ? "wifi.exclamationmark"
                : "exclamationmark.triangle",
            title: failure.title,
            message: failureMessage(failure)
        ) {
            // One button, the one the diagnosis asks for. A wrong address
            // doesn't heal by being retried, and a timeout isn't fixed in
            // Settings — offering both would just make you pick.
            switch failure.remedy {
            case .retry:
                // The poll keeps trying underneath either way; this is for
                // the person who just turned the VPN back on and doesn't
                // want to wonder whether the app noticed.
                Button(action: retryLoad) {
                    if isRetrying {
                        // Same footprint as the label it replaces, so the
                        // capsule doesn't resize when the retry starts.
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Try again")
                    }
                }
                .buttonStyle(PlaceholderActionStyle())
                .disabled(isRetrying)
            case .settings:
                settingsButton
            }
        }
    }

    /// The one line under the headline: the fix when the diagnosis knows one,
    /// otherwise the server that stayed silent — naming it is what tells you
    /// whether the app is pointed where you think it is. The system's own
    /// wording is the last resort, for failures that aren't about the
    /// network at all.
    private func failureMessage(_ failure: Reachability.Diagnosis) -> String {
        if let fix = failure.fix { return fix }
        guard failure.isConnection,
              let host = ServerConfig.shared.baseURL?.host(), !host.isEmpty
        else { return failure.detail }
        return "\(host) didn't answer."
    }

    /// Only shown where Settings is the actual fix — a server that can't be
    /// found, a token that isn't accepted — so it wears the full weight.
    @ViewBuilder
    private var settingsButton: some View {
        #if os(macOS)
        SettingsLink { Text("Open Settings") }
            .buttonStyle(PlaceholderActionStyle())
        #else
        Button("Open Settings") { showSettings = true }
            .buttonStyle(PlaceholderActionStyle())
        #endif
    }

    private func retryLoad() {
        guard !isRetrying else { return }
        isRetrying = true
        Task {
            await viewModel.refresh()
            isRetrying = false
        }
    }
}

private struct ArchivedSessionsView: View {
    let sessions: [Session]
    let onRestore: (Session) -> Void
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                if sessions.isEmpty {
                    ContentUnavailableView(
                        "Nothing archived",
                        systemImage: "archivebox"
                    )
                } else {
                    ForEach(sessions) { session in
                        HStack(spacing: 10) {
                            RepoTile(name: session.effectiveRepo, size: 24)
                            VStack(alignment: .leading, spacing: 2) {
                                Text(session.displayTitle)
                                    .font(.body.weight(.medium))
                                    .lineLimit(2)
                                Text(RepoTile.label(for: session.effectiveRepo))
                                    .font(.footnote)
                                    .foregroundStyle(OS1VisualStyle.textDim)
                            }
                            Spacer(minLength: 8)
                            Button {
                                onRestore(session)
                            } label: {
                                HStack(spacing: 5) {
                                    WebIcon(kind: .unarchive, size: 18)
                                    Text("Restore")
                                }
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            #if os(iOS)
            .scrollContentBackground(.hidden)
            .background(OS1VisualStyle.background)
            #endif
            .navigationTitle("Archived")
            .inlineTitleBarCompat()
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

extension Session.Lane {
    /// Dot colors matching the web sidebar's lane dots.
    var color: Color {
        switch self {
        case .needsInput: OS1VisualStyle.blue
        case .inProgress: OS1VisualStyle.yellow
        case .inReview: OS1VisualStyle.green
        case .done: OS1VisualStyle.purple
        case .backlog: OS1VisualStyle.textFaint.opacity(0.7)
        }
    }
}

struct SessionRow: View {
    let session: Session
    var title: String? = nil
    /// Every session the row stands for. Unread emphasis is per ROW, like the web
    /// sidebar's `.sidebar-item-unread`: one session with activity past your read
    /// mark bolds the whole workspace. Empty falls back to `session` alone.
    var sessions: [Session] = []
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Mac: hover-revealed archive button (nil hides it).
    var onArchive: (() -> Void)? = nil

    #if os(macOS)
    @State private var hovering = false
    #endif

    var body: some View {
        #if os(macOS)
        content
            .overlay(alignment: .trailing) {
                if hovering, let onArchive {
                    Button(action: onArchive) {
                        WebIcon(kind: .archive, size: 20, color: .secondary)
                    }
                    .buttonStyle(.borderless)
                    .help("Archive")
                    // Keep the action legible over a long title.
                    .padding(4)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 5))
                }
            }
            // onHover must wrap the overlay, not sit under it: with the button
            // on top of the hover target, reaching it ended the content's
            // hover, which unmounted the button under the cursor (flicker).
            .onHover { hovering = $0 }
        #else
        content
        #endif
    }

    /// Mac sidebar rows are compact and body-sized like Finder/System
    /// Settings; iOS keeps the roomier touch metrics.
    private var content: some View {
        HStack(spacing: 9) {
            statusMark
                .frame(width: markSize, height: markSize)
            Text(rowTitle)
                #if os(iOS)
                // The web sidebar's phone type, exactly: 16px titles (callout)
                // in medium, dimmed — and, when the row has activity you
                // haven't read, semibold at full strength. Same Slack-style
                // pair as `.sidebar-item-title` / `.sidebar-item-unread`.
                .font(.callout.weight(unread ? .semibold : .medium))
                .foregroundStyle(unread ? OS1VisualStyle.text : OS1VisualStyle.textDim)
                #else
                .font(.body.weight(unread ? .semibold : .regular))
                .foregroundStyle(.primary)
                #endif
                .lineLimit(1)
                .frame(maxWidth: .infinity, alignment: .leading)
            if session.lane == .inProgress && showsElapsedTime {
                WorkspaceRunElapsedLabel(since: session.runStartedDate)
                    #if os(iOS)
                    // The repo header's "+" is an 18pt glyph centred in a 30pt
                    // tap target, so its ink stops ~8pt inside the shared 16pt
                    // row margin (minus the digits' own side bearing). Without
                    // this pad the running clock juts past the plus above it
                    // instead of sharing its column.
                    .padding(.trailing, 7)
                    #endif
            }
        }
        #if os(iOS)
        // 13, not 11: the list no longer imposes a 44pt minimum row height,
        // so the row's own padding is what keeps its touch target.
        .padding(.vertical, 13)
        #else
        .padding(.vertical, 3)
        #endif
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityLabel(rowTitle)
        .accessibilityValue(accessibilityStatus)
        #if os(macOS)
        .help(rowTitle)
        #endif
    }

    /// Read here rather than at the call site on purpose: `ReadsStore` is
    /// `@Observable`, so a mark landing invalidates the rows that read it
    /// instead of the whole list body.
    private var unread: Bool {
        ReadsStore.shared.isUnread(sessions.isEmpty ? [session] : sessions)
    }

    private var markSize: CGFloat {
        #if os(iOS)
        22
        #else
        14
        #endif
    }

    private var rowTitle: String {
        (title ?? session.displayTitle).replacingOccurrences(
            of: #"^PR\s*#\d+(:|\s*[—–-])\s*"#,
            with: "",
            options: [.regularExpression, .caseInsensitive]
        )
    }

    private var showsElapsedTime: Bool {
        #if os(iOS)
        !dynamicTypeSize.isAccessibilitySize
        #else
        true
        #endif
    }

    @ViewBuilder
    private var statusMark: some View {
        if session.lane == .needsInput {
            PulsingDot(color: OS1VisualStyle.blue, active: animatesStatus)
        } else if session.lane == .inProgress {
            PulsingDot(color: OS1VisualStyle.yellow, active: animatesStatus)
        } else if session.prState == "MERGED" {
            WebIcon(kind: .gitMerge, size: markSize, color: OS1VisualStyle.purple)
        } else if session.prState == "OPEN" {
            WebIcon(kind: .pullRequest, size: markSize, color: OS1VisualStyle.green)
        } else if session.prState == "CLOSED" {
            WebIcon(kind: .pullRequest, size: markSize, color: OS1VisualStyle.red)
        } else {
            PulsingDot(color: OS1VisualStyle.textFaint, active: false)
        }
    }

    private var animatesStatus: Bool {
        #if os(iOS)
        true
        #else
        false
        #endif
    }

    private var accessibilityStatus: String {
        var parts = [session.lane.label, RepoTile.label(for: session.effectiveRepo)]
        // The bold title is the only sighted cue for unread; say it out loud.
        if unread { parts.insert("unread", at: 0) }
        if let prState = session.prState?.lowercased() {
            parts.append("pull request \(prState)")
        }
        return parts.joined(separator: ", ")
    }
}

/// Web workspace rows reserve their trailing slot for a live run clock; idle
/// rows intentionally show no last-used timestamp.
private struct WorkspaceRunElapsedLabel: View {
    let since: Date?

    var body: some View {
        Group {
            if let since {
                TimelineView(.periodic(from: .now, by: 1)) { context in
                    Text(label(context.date.timeIntervalSince(since)))
                }
            } else {
                Text("Running")
            }
        }
        #if os(iOS)
        // 12px, like the web's `.sidebar-ws-ticker` on a phone.
        .font(.caption.weight(.medium).monospacedDigit())
        #else
        .font(.caption.monospacedDigit())
        #endif
        .foregroundStyle(OS1VisualStyle.yellow)
        .fixedSize(horizontal: true, vertical: false)
    }

    private func label(_ elapsed: TimeInterval) -> String {
        let total = max(0, Int(elapsed))
        if total < 60 { return "\(total)s" }
        if total < 3_600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3_600)h \((total % 3_600) / 60)m"
    }
}

/// Status dot that softly pulses while `active` — mirrors the web's
/// `.pulse-dot` (1.4s opacity cycle).
struct PulsingDot: View {
    let color: Color
    var active: Bool = true
    var size: CGFloat = 8
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let dot = Circle()
            .fill(color)
            .frame(width: size, height: size)
        if active && !reduceMotion {
            dot.phaseAnimator([1.0, 0.35]) { view, opacity in
                view.opacity(opacity)
            } animation: { _ in
                .easeInOut(duration: 0.7)
            }
        } else {
            dot
        }
    }
}
