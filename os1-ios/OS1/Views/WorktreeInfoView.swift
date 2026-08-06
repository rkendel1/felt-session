import SwiftUI

#if os(iOS)
/// Native counterpart of mobile web's title-opened workspace info page.
struct WorktreeInfoView: View {
    @Bindable var viewModel: SessionViewModel
    let sessions: [Session]
    let catalog: ModelCatalog?

    @Environment(\.dismiss) private var dismiss
    @State private var gitStatus: OS1API.GitStatus?
    @State private var diff: OS1API.SessionDiff?
    @State private var overview: OS1API.WorkspaceOverview?
    @State private var loading = true
    @State private var loadFailed = false
    @State private var showPrPanel = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    hero
                    worktreeSection
                    gitSection
                    pullRequestSection
                    changesSection
                    overviewSection
                    runSettingsSection
                }
                .padding(.horizontal, 16)
                .padding(.bottom, 28)
            }
            .background(OS1VisualStyle.background)
            .navigationTitle("Workspace")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task(id: loadIdentity) { await load() }
            .refreshable { await load() }
            .onChange(of: viewModel.isRunning) { wasRunning, isRunning in
                if wasRunning && !isRunning {
                    Task { await loadGitDetails() }
                }
            }
            .sheet(isPresented: $showPrPanel) {
                PrPanelView(viewModel: viewModel)
            }
        }
    }

    private var hero: some View {
        VStack(spacing: 9) {
            RepoTile(name: currentSession.effectiveRepo, size: 52, round: true)
            Text(currentSession.displayTitle)
                .font(.title2.weight(.bold))
                .multilineTextAlignment(.center)
            Text(heroSubtitle)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
                .multilineTextAlignment(.center)
            if let stateLabel {
                Label(stateLabel.text, systemImage: stateLabel.icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(stateLabel.color)
                    .padding(.horizontal, 10)
                    .padding(.vertical, 5)
                    .background(stateLabel.color.opacity(0.12), in: Capsule())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 18)
    }

    private var worktreeSection: some View {
        InfoSection(title: "Worktree") {
            InfoRow(label: "Repository", value: repoLabel, icon: "shippingbox")
            if let branch = gitStatus?.branch ?? currentSession.branch, !branch.isEmpty {
                InfoRow(label: "Branch", value: branch, icon: "arrow.triangle.branch")
            }
            if let path = currentSession.worktreeDir, !path.isEmpty {
                InfoRow(label: "Path", value: path, icon: "folder", monospaced: true)
            }
            InfoRow(
                label: "Mode",
                value: (currentSession.mode ?? "ask").capitalized,
                icon: "terminal"
            )
            InfoRow(
                label: "Sessions",
                value: "\(sessions.count)",
                icon: "bubble.left.and.bubble.right"
            )
            if let startedBy = oldestSession?.startedBy, !startedBy.isEmpty {
                InfoRow(label: "Started by", value: startedBy, icon: "person")
            }
            ForEach(currentSession.attachedRepos ?? []) { repo in
                InfoRow(
                    label: "Attached",
                    value: "\(RepoTile.label(for: repo.repo)) · \(repo.branch)",
                    icon: "link"
                )
            }
        }
    }

    @ViewBuilder
    private var gitSection: some View {
        if loading && gitStatus == nil {
            InfoSection(title: "Git status") {
                HStack(spacing: 9) {
                    ProgressView().controlSize(.small)
                    Text("Checking worktree…")
                        .font(.subheadline)
                        .foregroundStyle(OS1VisualStyle.textDim)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
        } else if let gitStatus {
            InfoSection(title: "Git status") {
                FlowLayout(spacing: 7) {
                    if gitStatus.uncommittedFiles > 0 {
                        StatusPill(
                            text: "\(gitStatus.uncommittedFiles) uncommitted",
                            icon: "pencil",
                            color: OS1VisualStyle.yellow
                        )
                    }
                    if gitStatus.ahead > 0 {
                        StatusPill(
                            text: "\(gitStatus.ahead) ahead",
                            icon: "arrow.up",
                            color: OS1VisualStyle.blue
                        )
                    }
                    if gitStatus.behind > 0 {
                        StatusPill(
                            text: "\(gitStatus.behind) behind upstream",
                            icon: "arrow.down",
                            color: OS1VisualStyle.yellow
                        )
                    } else if gitStatus.behindBase > 0,
                              currentSession.prState != "MERGED" {
                        StatusPill(
                            text: "\(gitStatus.behindBase) behind \(gitStatus.baseBranch)",
                            icon: "arrow.down",
                            color: OS1VisualStyle.yellow
                        )
                    }
                    if gitStatus.uncommittedFiles == 0,
                       gitStatus.ahead == 0,
                       gitStatus.behind == 0,
                       (gitStatus.behindBase == 0 || currentSession.prState == "MERGED") {
                        StatusPill(
                            text: "Up to date",
                            icon: "checkmark",
                            color: OS1VisualStyle.green
                        )
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(12)
            }
        }
    }

    @ViewBuilder
    private var changesSection: some View {
        if let diff, !diff.files.isEmpty {
            InfoSection(
                title: "\(diff.files.count) file\(diff.files.count == 1 ? "" : "s") changed",
                trailing: AnyView(diffTotals(diff))
            ) {
                ForEach(diff.files.prefix(8)) { file in
                    HStack(spacing: 10) {
                        Image(systemName: fileIcon(file.status))
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(fileColor(file.status))
                            .frame(width: 20)
                        Text(file.path)
                            .font(.footnote.monospaced())
                            .lineLimit(1)
                            .truncationMode(.middle)
                        Spacer(minLength: 8)
                        if file.additions > 0 {
                            Text("+\(file.additions)")
                                .foregroundStyle(OS1VisualStyle.green)
                        }
                        if file.deletions > 0 {
                            Text("−\(file.deletions)")
                                .foregroundStyle(OS1VisualStyle.red)
                        }
                    }
                    .font(.caption.monospacedDigit())
                    .padding(.horizontal, 12)
                    .frame(minHeight: 44)
                    if file.id != diff.files.prefix(8).last?.id { Divider() }
                }
                if diff.files.count > 8 {
                    Text("\(diff.files.count - 8) more files are available in the web Changes view.")
                        .font(.caption)
                        .foregroundStyle(OS1VisualStyle.textDim)
                        .padding(12)
                }
            }
        }
    }

    @ViewBuilder
    private var pullRequestSection: some View {
        if let number = viewModel.prDetails?.number ?? currentSession.prNumber {
            InfoSection(title: "Pull request") {
                Button {
                    showPrPanel = true
                } label: {
                    HStack(spacing: 10) {
                        Image(systemName: "arrow.triangle.pull")
                            .foregroundStyle(OS1VisualStyle.blue)
                            .frame(width: 20)
                        VStack(alignment: .leading, spacing: 2) {
                            Text(viewModel.prDetails?.title ?? "Pull request")
                                .font(.subheadline.weight(.medium))
                                .foregroundStyle(OS1VisualStyle.text)
                                .lineLimit(1)
                            Text(viewModel.prDetails?.summary.label ?? "View status and checks")
                                .font(.caption)
                                .foregroundStyle(OS1VisualStyle.textDim)
                        }
                        Spacer(minLength: 8)
                        PrChipLabel(number: number, summary: viewModel.prDetails?.summary)
                            .foregroundStyle(OS1VisualStyle.text)
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.textFaint)
                    }
                    .padding(.horizontal, 12)
                    .frame(minHeight: 52)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var overviewSection: some View {
        if let overview, overview.prompt != nil || overview.lastMessage != nil {
            InfoSection(title: "Overview") {
                if let prompt = overview.prompt {
                    SummaryBlock(label: "Started with", content: prompt.content)
                }
                if let lastMessage = overview.lastMessage {
                    if overview.prompt != nil { Divider() }
                    SummaryBlock(label: "Latest update", content: lastMessage.content)
                }
            }
        } else if loadFailed {
            InfoSection(title: "Overview") {
                Text("Some worktree details could not be loaded. Pull down to retry.")
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .padding(12)
            }
        }
    }

    private var runSettingsSection: some View {
        InfoSection(title: "Run settings") {
            Menu {
                if let catalog {
                    ForEach(catalog.presets + catalog.regular) { option in
                        Button {
                            viewModel.changeModel(to: option.id)
                        } label: {
                            if option.id == currentModel {
                                Label(option.displayLabel, systemImage: "checkmark")
                            } else {
                                Text(option.displayLabel)
                            }
                        }
                    }
                }
            } label: {
                SettingsRow(
                    label: "Model",
                    value: catalog?.label(for: currentModel) ?? currentModel,
                    icon: "cpu"
                )
            }
            .buttonStyle(.plain)

            if let efforts = catalog?.option(for: currentModel)?.efforts,
               !efforts.isEmpty {
                Divider()
                Menu {
                    ForEach(efforts, id: \.self) { effort in
                        Button {
                            viewModel.effort = effort
                        } label: {
                            if viewModel.effort == effort {
                                Label(EffortLevel.label(effort), systemImage: "checkmark")
                            } else {
                                Text(EffortLevel.label(effort))
                            }
                        }
                    }
                } label: {
                    SettingsRow(
                        label: "Reasoning",
                        value: EffortLevel.label(viewModel.effort),
                        icon: "brain"
                    )
                }
                .buttonStyle(.plain)
            }

            if catalog?.option(for: currentModel)?.fastModeSupported == true {
                Divider()
                Toggle(isOn: $viewModel.fastMode) {
                    Label("Fast mode", systemImage: "bolt")
                        .font(.subheadline)
                }
                .padding(.horizontal, 12)
                .frame(minHeight: 48)
            }
        }
    }

    private var currentModel: String {
        viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
    }

    private var oldestSession: Session? {
        sessions.min { ($0.createdAt ?? "") < ($1.createdAt ?? "") }
    }

    private var repoLabel: String {
        var label = RepoTile.label(for: viewModel.session.effectiveRepo)
        let attached = currentSession.attachedRepos?.count ?? 0
        if attached > 0 { label += " +\(attached)" }
        return label
    }

    private var heroSubtitle: String {
        [repoLabel, catalog?.label(for: currentModel) ?? currentModel]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    private var stateLabel: (text: String, icon: String, color: Color)? {
        if viewModel.pendingQuestion != nil {
            return ("Waiting for input", "questionmark", OS1VisualStyle.blue)
        }
        if viewModel.isRunning {
            return ("Working", "sparkles", OS1VisualStyle.green)
        }
        switch currentSession.prState {
        case "OPEN": return ("In review", "arrow.triangle.pull", OS1VisualStyle.yellow)
        case "MERGED": return ("Merged", "checkmark", OS1VisualStyle.purple)
        default: return nil
        }
    }

    private func load() async {
        loading = true
        loadFailed = false
        async let gitResult = try? OS1API.gitStatus(
            sessionId: currentSession.id,
            repo: currentSession.effectiveRepo
        )
        async let diffResult = try? OS1API.sessionDiff(sessionId: currentSession.id)
        async let overviewResult = loadOverview()
        let (nextGit, nextDiffResponse, nextOverview) = await (
            gitResult,
            diffResult,
            overviewResult
        )
        guard !Task.isCancelled else { return }
        if let nextGit { gitStatus = nextGit }
        if let nextDiffResponse {
            diff = nextDiffResponse.repos.first(where: \.primary)?.diff
        }
        if let nextOverview { overview = nextOverview }
        loadFailed = gitStatus == nil && diff == nil && overview == nil
        loading = false
    }

    private func loadOverview() async -> OS1API.WorkspaceOverview? {
        if let id = currentSession.workspaceId, !id.isEmpty {
            return try? await OS1API.workspaceOverview(workspaceId: id)
        }

        var transcripts: [(Session, [TranscriptEntry]?)] = []
        for session in sessions {
            transcripts.append((
                session,
                try? await OS1API.transcript(sessionId: session.id)
            ))
        }
        let ordered = transcripts.sorted {
            ($0.0.createdAt ?? "") < ($1.0.createdAt ?? "")
        }
        var prompt: OS1API.WorkspaceOverview.Message?
        var lastMessage: OS1API.WorkspaceOverview.Message?
        for (session, entries) in ordered {
            guard let entries else { continue }
            if prompt == nil,
               let entry = entries.first(where: {
                   $0.isUser && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                       && !$0.text.hasPrefix("/")
               }) {
                prompt = .init(
                    content: entry.text,
                    sessionId: session.id,
                    at: entry.timestamp ?? session.createdAt ?? ""
                )
            }
            if let entry = entries.last(where: {
                $0.isAssistant && !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }) {
                let candidate = OS1API.WorkspaceOverview.Message(
                    content: entry.text,
                    sessionId: session.id,
                    at: entry.timestamp ?? session.lastActivity ?? ""
                )
                if lastMessage == nil || candidate.at > lastMessage!.at {
                    lastMessage = candidate
                }
            }
        }
        return .init(prompt: prompt, lastMessage: lastMessage)
    }

    private func loadGitDetails() async {
        async let gitResult = try? OS1API.gitStatus(
            sessionId: currentSession.id,
            repo: currentSession.effectiveRepo
        )
        async let diffResult = try? OS1API.sessionDiff(sessionId: currentSession.id)
        let (nextGit, nextDiffResponse) = await (gitResult, diffResult)
        guard !Task.isCancelled else { return }
        if let nextGit { gitStatus = nextGit }
        if let nextDiffResponse {
            diff = nextDiffResponse.repos.first(where: \.primary)?.diff
        }
    }

    /// The navigation value is a snapshot. Prefer the latest polled row so an
    /// optimistic session gains its worktree metadata without being reopened.
    private var currentSession: Session {
        sessions.first(where: { $0.id == viewModel.session.id }) ?? viewModel.session
    }

    private var loadIdentity: String {
        [
            currentSession.id,
            currentSession.workspaceId ?? "",
            currentSession.worktreeDir ?? "",
            currentSession.branch ?? "",
            String(currentSession.attachedRepos?.count ?? 0),
        ].joined(separator: "|")
    }

    private func diffTotals(_ diff: OS1API.SessionDiff) -> some View {
        HStack(spacing: 6) {
            if diff.totalAdditions > 0 {
                Text("+\(diff.totalAdditions)").foregroundStyle(OS1VisualStyle.green)
            }
            if diff.totalDeletions > 0 {
                Text("−\(diff.totalDeletions)").foregroundStyle(OS1VisualStyle.red)
            }
        }
        .font(.caption.weight(.semibold).monospacedDigit())
    }

    private func fileIcon(_ status: String) -> String {
        switch status {
        case "added", "untracked": "plus"
        case "deleted": "minus"
        case "renamed": "arrow.right"
        default: "pencil"
        }
    }

    private func fileColor(_ status: String) -> Color {
        switch status {
        case "added", "untracked": OS1VisualStyle.green
        case "deleted": OS1VisualStyle.red
        case "renamed": OS1VisualStyle.blue
        default: OS1VisualStyle.yellow
        }
    }
}

/// Opens workspace details directly from a list-row context menu while still
/// giving its model controls the live session socket they use in SessionView.
struct WorktreeInfoSheet: View {
    @State private var viewModel: SessionViewModel
    @State private var catalog: ModelCatalog?
    @Bindable private var listViewModel: SessionsListViewModel
    private let fallbackWorkspace: SidebarWorkspace

    init(workspace: SidebarWorkspace, listViewModel: SessionsListViewModel) {
        _viewModel = State(initialValue: SessionViewModel(session: workspace.mainSession))
        self.listViewModel = listViewModel
        fallbackWorkspace = workspace
    }

    var body: some View {
        let workspace = SessionsListViewModel.sidebarWorkspaces(
            in: listViewModel.sessions,
            workspaceNames: listViewModel.workspaceNames
        ).first { workspace in
            workspace.sessions.contains { $0.id == viewModel.session.id }
        } ?? fallbackWorkspace

        WorktreeInfoView(viewModel: viewModel, sessions: workspace.sessions, catalog: catalog)
            .task {
                viewModel.start()
                catalog = try? await OS1API.models()
            }
            .onDisappear { viewModel.stop() }
    }
}

private struct InfoSection<Content: View>: View {
    let title: String
    var trailing: AnyView? = nil
    @ViewBuilder let content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text(title)
                    .font(.footnote.weight(.semibold))
                    .foregroundStyle(OS1VisualStyle.textDim)
                Spacer()
                trailing
            }
            VStack(spacing: 0) { content }
                .background(
                    OS1VisualStyle.raised,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
        }
    }
}

private struct InfoRow: View {
    let label: String
    let value: String
    let icon: String
    var monospaced = false

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Label(label, systemImage: icon)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
            Spacer(minLength: 12)
            Text(value)
                .font(monospaced ? .caption.monospaced() : .subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                .multilineTextAlignment(.trailing)
                .textSelection(.enabled)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 46)
    }
}

private struct SettingsRow: View {
    let label: String
    let value: String
    let icon: String

    var body: some View {
        HStack(spacing: 10) {
            Label(label, systemImage: icon)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
            Spacer()
            Text(value)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.textDim)
                .lineLimit(1)
            Image(systemName: "chevron.up.chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
        }
        .padding(.horizontal, 12)
        .frame(minHeight: 48)
        .contentShape(Rectangle())
    }
}

private struct StatusPill: View {
    let text: String
    let icon: String
    let color: Color

    var body: some View {
        Label(text, systemImage: icon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(color)
            .padding(.horizontal, 9)
            .padding(.vertical, 6)
            .background(color.opacity(0.12), in: Capsule())
    }
}

private struct SummaryBlock: View {
    let label: String
    let content: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textDim)
            Text(content)
                .font(.subheadline)
                .foregroundStyle(OS1VisualStyle.text)
                .lineLimit(5)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
    }
}

private struct FlowLayout: Layout {
    let spacing: CGFloat

    func sizeThatFits(
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) -> CGSize {
        let width = proposal.width ?? 0
        var rowWidth: CGFloat = 0
        var rowHeight: CGFloat = 0
        var height: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if rowWidth > 0, rowWidth + spacing + size.width > width {
                height += rowHeight + spacing
                rowWidth = 0
                rowHeight = 0
            }
            rowWidth += (rowWidth == 0 ? 0 : spacing) + size.width
            rowHeight = max(rowHeight, size.height)
        }
        return CGSize(width: width, height: height + rowHeight)
    }

    func placeSubviews(
        in bounds: CGRect,
        proposal: ProposedViewSize,
        subviews: Subviews,
        cache: inout ()
    ) {
        var point = bounds.origin
        var rowHeight: CGFloat = 0
        for view in subviews {
            let size = view.sizeThatFits(.unspecified)
            if point.x > bounds.minX, point.x + size.width > bounds.maxX {
                point.x = bounds.minX
                point.y += rowHeight + spacing
                rowHeight = 0
            }
            view.place(at: point, proposal: ProposedViewSize(size))
            point.x += size.width + spacing
            rowHeight = max(rowHeight, size.height)
        }
    }
}
#endif
