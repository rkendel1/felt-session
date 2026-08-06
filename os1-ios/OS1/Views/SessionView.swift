import SwiftUI
#if os(macOS)
import AppKit
#endif

struct SessionView: View {
    @State private var viewModel: SessionViewModel
    private let tabs: [Session]
    /// Canonical workspace names, id-keyed, as the sessions list holds them.
    /// Regrouping `tabs` here rebuilds the sidebar row this session sits in,
    /// and without these the row would be titled by whatever the fallback
    /// chain finds instead of the workspace's actual name.
    private let workspaceNames: [String: String]
    private let onSelectTab: ((Session) -> Void)?
    private let onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)?
    /// Opens the new-session composer from the iOS navigation bar.
    private let onNewSession: (() -> Void)?
    /// Worktree-level actions behind the iOS overflow menu. They belong to the
    /// sessions list, which owns the optimistic row removal and the refresh
    /// that follows — nil simply leaves those entries out of the menu.
    private let onRenameWorkspace: ((String) -> Void)?
    private let onArchiveWorkspace: (() -> Void)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// The appearance the conversation itself is drawn in — read out here,
    /// where it's still the app's, so the input bar can be pinned to it.
    @Environment(\.colorScheme) private var appColorScheme

    /// Full-window-width session text is unreadable on the Mac; cap the content
    /// column (transcript AND composer) and center it, like other chat apps.
    private let contentMaxWidth = OS1VisualStyle.sessionMaxWidth

    /// Mobile web uses a tighter 12pt content rail; regular-width iPad and Mac
    /// keep more breathing room while sharing the same 780pt reading column.
    private var contentInset: CGFloat {
        horizontalSizeClass == .compact ? 12 : 20
    }

    /// Anchor for restoring the scroll position after a requested history
    /// prepend: the ENTRY that was topmost stays where the reader left it.
    /// An entry id, not a block id — a prepended page can merge older entries
    /// into the topmost turn, which changes that block's id and would leave a
    /// block-keyed anchor pointing at nothing.
    @State private var prependAnchorEntryId: String?

    /// How work folds start out: collapsed / expanded / auto (open while the
    /// turn is live). Shared with the rest of the app's appearance settings.
    @AppStorage("os1.appearance.turnActivity") private var turnActivity = "collapsed"

    /// Output arrived while the reader was scrolled up. Turns the return pill
    /// from a navigation aid into a notification.
    @State private var newBelow = false

    /// Keep the view welded to the latest for a moment after opening.
    ///
    /// A conversation opens at the bottom, but its rows keep settling for a
    /// second or two afterwards — markdown parses asynchronously and the lazy
    /// stack realizes rows as it goes — and every one of those height changes
    /// nudges the bottom further down than the anchor recovers. The hold
    /// re-pins through that window, and any real scroll gesture ends it
    /// immediately so it can never fight the reader.
    @State private var holdingAtLatest = true
    @State private var holdTask: Task<Void, Never>?
    private let initialHoldSeconds: Double = 2.5

    /// Whether the reader is at (or near) the bottom, from live scroll
    /// geometry. New AI output only auto-scrolls while true; scrolling up to
    /// read releases the pin so streams don't yank the reader back down.
    @State private var pinnedToBottom = true

    /// How close to the bottom (pt) still counts as pinned.
    ///
    /// `scrollToBottom` aligns the LAST BLOCK's bottom edge with the visible
    /// bottom, so "as far down as this view ever scrolls itself" already sits
    /// the transcript's trailing padding short of the content's end. The
    /// tolerance has to clear that, plus slack for keyboard/inset transitions
    /// and lazy rows settling.
    private let pinTolerance: CGFloat = 76

    /// Model/effort catalog for the toolbar picker; fetched on first open.
    @State private var catalog: ModelCatalog?

    /// PR details sheet — the macOS toolbar PR chip, the iOS overflow menu.
    @State private var showPrPanel = false

    /// Native counterpart of mobile web's title-opened workspace info page.
    @State private var showWorktreeInfo = false

    #if os(iOS)
    /// Rename prompt, raised from the overflow menu.
    @State private var renamingWorkspace = false
    @State private var renameText = ""

    /// Web link tapped in the transcript, shown over the session. The
    /// enclosing action — the one `SessionsListView` installs to turn
    /// `bks-…` links into a push — stays in charge of everything else.
    @State private var safariLink: SafariLink?
    @Environment(\.openURL) private var enclosingOpenURL
    #endif

    init(
        session: Session,
        seed: SessionViewModel.OptimisticSeed? = nil,
        tabs: [Session]? = nil,
        workspaceNames: [String: String] = [:],
        composerDraft: SessionViewModel.ComposerDraft? = nil,
        onSelectTab: ((Session) -> Void)? = nil,
        onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)? = nil,
        onNewSession: (() -> Void)? = nil,
        onRenameWorkspace: ((String) -> Void)? = nil,
        onArchiveWorkspace: (() -> Void)? = nil
    ) {
        _viewModel = State(initialValue: SessionViewModel(
            session: session,
            seed: seed,
            composerDraft: composerDraft
        ))
        self.tabs = tabs ?? [session]
        self.workspaceNames = workspaceNames
        self.onSelectTab = onSelectTab
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        self.onRenameWorkspace = onRenameWorkspace
        self.onArchiveWorkspace = onArchiveWorkspace
    }

    init(
        viewModel: SessionViewModel,
        tabs: [Session],
        workspaceNames: [String: String] = [:],
        onSaveComposerDraft: ((SessionViewModel.ComposerDraft) -> Void)? = nil,
        onNewSession: (() -> Void)? = nil,
        onRenameWorkspace: ((String) -> Void)? = nil,
        onArchiveWorkspace: (() -> Void)? = nil
    ) {
        _viewModel = State(initialValue: viewModel)
        self.tabs = tabs
        self.workspaceNames = workspaceNames
        self.onSelectTab = nil
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        self.onRenameWorkspace = onRenameWorkspace
        self.onArchiveWorkspace = onArchiveWorkspace
    }

    var body: some View {
        ScrollViewReader { proxy in
            Group {
                if viewModel.isLoadingConversation {
                    conversationLoader
                } else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            if viewModel.canLoadEarlier || viewModel.loadingEarlier {
                                historyLoader
                            }
                            ForEach(viewModel.displayBlocks) { block in
                                TranscriptRow(
                                    block: block,
                                    sessionId: viewModel.session.id,
                                    worktreeDir: viewModel.session.worktreeDir,
                                    foldState: {
                                        viewModel.foldState(
                                            for: $0,
                                            preference: turnActivity
                                        )
                                    },
                                    expansionState: { viewModel.expansionState(id: $0) }
                                )
                                .id(block.id)
                            }
                            if !viewModel.liveText.isEmpty {
                                StreamingBubble(text: viewModel.liveText)
                                    .id("live-stream")
                            }
                            if let ask = viewModel.pendingQuestion {
                                AskQuestionCard(ask: ask) { answers in
                                    viewModel.answer(question: ask, answers: answers)
                                }
                                .id("ask-\(ask.id)")
                            }
                            // A small child at the very end, and the reason is
                            // not spacing: a `LazyVStack` realizes the children
                            // that intersect the visible window, and a session
                            // opened mid-work groups its whole loaded transcript
                            // into ONE block (a single long turn, whose opening
                            // prompt has scrolled out of the loaded window). That
                            // giant child is then the only thing in the stack,
                            // and landing on the bottom anchor leaves it
                            // unrealized: the scroll geometry is right —
                            // measured on an iPhone 17 Pro, content 3022pt,
                            // offset 2239, 9pt from the end — while the screen
                            // stays BLANK until a touch forces a layout pass.
                            // Something small down here always intersects the
                            // window at the bottom, which keeps the stack
                            // realizing its neighbour.
                            Color.clear
                                .frame(height: 1)
                                .id("transcript-end")
                        }
                        .padding(.horizontal, contentInset)
                        .padding(.vertical, 8)
                        .frame(maxWidth: contentMaxWidth)
                        .frame(maxWidth: .infinity)
                    }
                    // Initial render lands at the bottom and stays pinned while
                    // lazy rows settle. The pin releases when the person scrolls
                    // up to read, so new output does not yank them back.
                    .softScrollEdges()
                    .defaultScrollAnchor(.bottom)
                    .defaultScrollAnchor(.bottom, for: .sizeChanges)
                    .scrollDismissesKeyboardCompat()
                    // Pin state from real scroll geometry: pinned while the
                    // visible bottom edge is within pinTolerance of the
                    // content's end. Precise on release (unlike deriving it
                    // from a sentinel row's `onAppear`, whose realization
                    // window lags actual visibility — that's a different thing
                    // from the `transcript-end` child above, which exists to
                    // keep the lazy stack realizing and is never read here) and
                    // it costs a state write only when the Bool flips, not per
                    // scroll tick.
                    .onScrollGeometryChange(for: Bool.self) { geometry in
                        // The predicate itself lives in TranscriptScroll, which
                        // documents why it reads `visibleRect` rather than
                        // `contentOffset + containerSize` — and is tested
                        // against the numbers a real iPhone reports.
                        TranscriptScroll.isNearBottom(
                            TranscriptScroll.Geometry(
                                visibleMaxY: geometry.visibleRect.maxY,
                                contentHeight: geometry.contentSize.height,
                                insetBottom: geometry.contentInsets.bottom
                            ),
                            tolerance: pinTolerance
                        )
                    } action: { _, isNearBottom in
                        pinnedToBottom = isNearBottom
                        if isNearBottom { newBelow = false }
                    }
                    // A way back down. Without it the only route out of a
                    // scrolled-up transcript is flicking through everything
                    // that arrived meanwhile.
                    .overlay(alignment: .bottom) {
                        if !pinnedToBottom, !holdingAtLatest,
                           !viewModel.displayBlocks.isEmpty {
                            ScrollToLatestPill(hasNewOutput: newBelow) {
                                newBelow = false
                                scrollToBottom(proxy, animated: true)
                            }
                            .padding(.bottom, 10)
                            .transition(.opacity.combined(with: .move(edge: .bottom)))
                        }
                    }
                    .animation(.snappy(duration: 0.22, extraBounce: 0), value: pinnedToBottom)
                    // A scroll gesture is the reader taking over: the
                    // opening hold ends the moment they touch the transcript.
                    .onScrollPhaseChange { _, phase in
                        if phase == .interacting { endHold() }
                    }
                    // Both entry points into a conversation arm the hold: a
                    // cached one is already loaded when the view appears, so
                    // waiting on the loading flag alone would leave the hold
                    // armed forever and the return pill permanently hidden.
                    .onAppear { beginHold(proxy) }
                    // The transcript exists now: hold it at the latest
                    // while its rows settle.
                    .onChange(of: viewModel.isLoadingConversation) { _, loading in
                        if !loading { beginHold(proxy) }
                    }
                    .onChange(of: viewModel.pendingQuestion) {
                        // A question needs eyes even if they've scrolled away.
                        scrollToBottom(proxy, animated: true)
                    }
                    .onChange(of: viewModel.sendSeq) {
                        // Your own send always lands in view. The bottom
                        // size-change anchor alone doesn't re-pin once the
                        // reader has scrolled up (or the keyboard resized the
                        // viewport), leaving the just-sent bubble below the fold.
                        scrollToBottom(proxy, animated: true)
                    }
                    // The size-change anchor alone doesn't reliably hold the
                    // bottom while new output arrives (keyboard insets + lazy
                    // row settling knock it loose), so follow explicitly while
                    // pinned: new items animated, per-chunk stream growth not
                    // (an animation every ~120ms flush reads as rubber-banding).
                    // `displayItems` stays flat behind the folded blocks
                    // precisely so this trigger keeps working: a tool call
                    // landing inside an existing turn leaves the BLOCK count
                    // unchanged, and following new output would stop.
                    .onChange(of: viewModel.displayItems.count) {
                        if pinnedToBottom || holdingAtLatest {
                            scrollToBottom(proxy, animated: true)
                        } else {
                            newBelow = true
                        }
                    }
                    .onChange(of: viewModel.liveText) {
                        if pinnedToBottom {
                            scrollToBottom(proxy, animated: false)
                        } else if !viewModel.liveText.isEmpty {
                            newBelow = true
                        }
                    }
                    .onChange(of: viewModel.historyPrependSeq) {
                        // Keep the reader where they were: the entry that was
                        // at the top of the viewport stays there. Resolved
                        // through the entry, since the block that now renders
                        // it may be a different (merged) turn.
                        if let entryId = prependAnchorEntryId,
                           let blockId = viewModel.blockId(containing: entryId) {
                            proxy.scrollTo(blockId, anchor: .top)
                        }
                        prependAnchorEntryId = nil
                    }
                }
            }
            // Web links from the transcript open on top of it, not instead of
            // it. Scoped to the transcript rather than the whole session so
            // that only agent output is rerouted — a sign-in URL from settings
            // still belongs to the system browser.
            #if os(iOS)
            .environment(\.openURL, OpenURLAction { url in
                guard SafariLink.isWeb(url) else {
                    // Session links and custom schemes stay with the action
                    // the sessions list installed above us.
                    enclosingOpenURL(url)
                    return .handled
                }
                safariLink = SafariLink(url: url)
                return .handled
            })
            .sheet(item: $safariLink) { link in
                SafariSheet(url: link.url)
                    .ignoresSafeArea()
            }
            #endif
        }
        .safeAreaInset(edge: .top, spacing: 0) {
            VStack(spacing: 0) {
                #if os(iOS)
                if tabs.count > 1, let onSelectTab {
                    SessionTabBar(
                        tabs: tabs,
                        activeId: viewModel.session.id,
                        onSelect: onSelectTab
                    )
                }
                #endif
                statusBanner
            }
        }
        .background(OS1VisualStyle.background.ignoresSafeArea())
        // Bottom inset, not an overlay: the scroll viewport still extends
        // beneath the composer (content scrolls under the floating glass),
        // while the content inset tracks the composer's real height and the
        // keyboard — a fixed overlay padding hid the newest messages behind
        // both.
        // A BAR, not a plain inset: `safeAreaBar` is what tells the scroll view
        // that its content travels behind the composer, which is what draws the
        // soft scroll edge effect there (see `softScrollEdges`). With a plain
        // `safeAreaInset` the transcript simply stopped above the composer and
        // nothing ever passed under it, so nothing faded.
        #if os(iOS)
        .safeAreaBar(edge: .bottom) { inputBar }
        #else
        .safeAreaInset(edge: .bottom) { inputBar }
        #endif
        #if os(macOS)
        .navigationTitle("")
        .macWindowTitle(viewModel.session.displayTitle)
        #else
        .navigationTitle(viewModel.session.displayTitle)
        #endif
        .inlineTitleBarCompat()
        #if os(iOS)
        .toolbarBackground(.hidden, for: .navigationBar)
        #endif
        .toolbar {
            #if os(iOS)
            ToolbarItem(placement: .principal) {
                sessionIdentityButton
            }
            #endif
            #if os(iOS)
            ToolbarItem(placement: .topTrailingCompat) {
                SessionActionsMenu(
                    viewModel: viewModel,
                    tabs: tabs,
                    workspaceNames: workspaceNames,
                    onNewSession: onNewSession,
                    onRenameWorkspace: onRenameWorkspace,
                    onArchiveWorkspace: onArchiveWorkspace,
                    showWorktreeInfo: $showWorktreeInfo,
                    showPrPanel: $showPrPanel,
                    renaming: $renamingWorkspace,
                    renameText: $renameText
                )
            }
            #else
            // macOS retains the PR chip in its roomier toolbar; on iOS the
            // same panel lives in the title-opened workspace sheet.
            if let prNumber = viewModel.prDetails?.number ?? viewModel.session.prNumber {
                ToolbarItem(placement: .topTrailingCompat) {
                    Button {
                        showPrPanel = true
                    } label: {
                        PrChipLabel(number: prNumber, summary: viewModel.prDetails?.summary)
                    }
                    .accessibilityLabel(Text(verbatim: "Pull request #\(prNumber)"))
                }
            }
            #endif
            #if os(macOS)
            ToolbarItem(placement: .principal) { macSessionTitle }
            ToolbarItem(placement: .topTrailingCompat) {
                modelMenu
                    .help("Model and reasoning settings")
            }
            #endif
        }
        .sheet(isPresented: $showPrPanel) {
            PrPanelView(viewModel: viewModel)
        }
        #if os(iOS)
        .alert("Rename workspace", isPresented: $renamingWorkspace) {
            TextField("Workspace name", text: $renameText)
            Button("Cancel", role: .cancel) {}
            Button("Rename") { onRenameWorkspace?(renameText) }
                .disabled(
                    viewModel.session.workspaceId != nil
                        && renameText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                )
        } message: {
            Text("Choose a name for this workspace.")
        }
        .sheet(isPresented: $showWorktreeInfo) {
            WorktreeInfoView(
                viewModel: viewModel,
                sessions: tabs,
                catalog: catalog
            )
            .presentationDetents([.large])
            .presentationDragIndicator(.visible)
        }
        #endif
        .task {
            let owner = UUID()
            viewModel.start(owner: owner)
            defer { viewModel.stop(owner: owner) }
            catalog = try? await OS1API.models()
            #if DEBUG && os(iOS)
            if ProcessInfo.processInfo.environment["OS1_OPEN_WORKTREE_INFO"] == "1" {
                showWorktreeInfo = true
            }
            #endif
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(3_600))
            }
        }
        .onDisappear {
            onSaveComposerDraft?(SessionViewModel.ComposerDraft(
                text: viewModel.draft,
                images: viewModel.attachedImages
            ))
        }
        .onChange(of: scenePhase) { _, phase in
            // Backgrounding leaves the socket half-open more often than not;
            // resync (and reconnect if dead) the moment we're visible again.
            if phase == .active { viewModel.appDidBecomeActive() }
        }
    }

    /// A separate view struct on purpose: typing mutates `viewModel.draft` on
    /// every keystroke, and any read of it (or `canSend`) inside
    /// SessionView.body would re-evaluate this whole body — transcript
    /// included — per key. Keep per-keystroke reads out of SessionView.body.
    private var inputBar: some View {
        SessionInputBar(
            viewModel: viewModel,
            contentMaxWidth: contentMaxWidth,
            horizontalInset: contentInset
        )
        // The system treats a bottom `safeAreaBar` as adaptive chrome: when
        // dark content scrolls under it, it hands the bar's subtree a DARK
        // colour scheme, and every dynamic colour inside follows — so a black
        // code block passing under the composer turned the pill, the queue
        // flap and their text near-black in a light-mode app (measured: the
        // pill's mean luminance 223 → 120, and the page-coloured wash painted
        // black). Pin the appearance the rest of the screen is using; the
        // glass keeps its own look, it just stops repainting the app.
        .environment(\.colorScheme, appColorScheme)
    }

    private var conversationLoader: some View {
        VStack(spacing: 10) {
            ProgressView()
                .controlSize(.small)
            Text("Loading conversation…")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    /// Sits above the oldest rendered entry; scrolling it into view pages in
    /// the previous window of history (with a button as the manual fallback).
    private var historyLoader: some View {
        HStack(spacing: 6) {
            if viewModel.loadingEarlier {
                ProgressView()
                    .controlSize(.small)
                Text("Loading earlier…")
            } else {
                Button("Load earlier history") { requestEarlier() }
                    .buttonStyle(.borderless)
            }
        }
        .font(.caption)
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .onAppear { requestEarlier() }
    }

    private func requestEarlier() {
        guard viewModel.canLoadEarlier, !viewModel.loadingEarlier else { return }
        prependAnchorEntryId = viewModel.topmostEntryId
        viewModel.loadEarlier()
    }

    @ViewBuilder
    private var statusBanner: some View {
        switch viewModel.connectionState {
        case .connected:
            EmptyView()
        case .connecting:
            bannerText("Connecting…", color: .secondary)
        case .reconnecting(let reason):
            bannerText(reason.map { "\($0) — reconnecting…" } ?? "Reconnecting…", color: .orange)
        }
    }

    /// Floating glass capsule under the nav bar, instead of a full-width bar.
    private func bannerText(_ text: String, color: Color) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(color)
            .padding(.horizontal, 12)
            .padding(.vertical, 5)
            .glassSurface(in: Capsule())
            .padding(.top, 6)
            .frame(maxWidth: .infinity)
    }

    /// Model / reasoning-effort / fast-mode controls, mirroring the web
    /// composer's pill: effort levels and fast toggle up top, the model list
    /// behind a submenu. Model switches route through `/model` (persisted +
    /// noticed); effort/fast ride the next send.
    private var modelMenu: some View {
        Menu {
            modelMenuContents
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
    }

    #if os(macOS)
    /// Own the detail title instead of accepting NavigationSplitView's
    /// automatic circular title-menu control, which had no useful action.
    private var macSessionTitle: some View {
        HStack(spacing: 8) {
            RepoTile(name: viewModel.session.effectiveRepo, size: 20)
            Text(viewModel.session.displayTitle)
                .font(.headline)
                .lineLimit(1)
            if viewModel.isRunning {
                PulsingDot(color: OS1VisualStyle.yellow, size: 6)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 4)
        .frame(maxWidth: 520, alignment: .leading)
        .help(headerSubtitle)
        .accessibilityElement(children: .combine)
    }
    #endif

    #if os(iOS)
    /// Mobile web opens workspace details when its title is tapped. Keep the
    /// same identity in native navigation and present a SwiftUI details sheet.
    private var sessionIdentityButton: some View {
        Button {
            showWorktreeInfo = true
        } label: {
            HStack(spacing: 8) {
                // 24pt, the same tile the sessions list uses. At 32 it stood
                // as tall as the whole title/subtitle stack and read as the
                // loudest thing in the bar — especially on the colored letter
                // fallback that stands in until the repo icon loads.
                RepoTile(name: viewModel.session.effectiveRepo, size: 24)
                VStack(alignment: .leading, spacing: 1) {
                    HStack(spacing: 5) {
                        Text(viewModel.session.displayTitle)
                            .font(.callout.weight(.semibold))
                            .foregroundStyle(OS1VisualStyle.text)
                            .lineLimit(1)
                        if viewModel.isRunning {
                            PulsingDot(color: .green, size: 6)
                        }
                    }
                    if !dynamicTypeSize.isAccessibilitySize {
                        Text(headerSubtitle)
                            .font(.footnote)
                            .foregroundStyle(OS1VisualStyle.textDim)
                            .lineLimit(1)
                    }
                }
            }
            // Same glass pill the bar's own back and "+" controls wear, so the
            // identity reads as the third control up there rather than loose
            // text — and carries the tappability the dropped chevron used to
            // hint at.
            .padding(.leading, 8)
            .padding(.trailing, 14)
            .padding(.vertical, 6)
            .frame(maxWidth: 220, alignment: .leading)
            .contentShape(Capsule())
            .glassSurface(in: Capsule(), interactive: true)
        }
        .buttonStyle(.plain)
        .tint(.primary)
        .accessibilityLabel("Workspace details")
    }
    #endif

    private var currentModel: String {
        viewModel.model.isEmpty ? (catalog?.defaultModel ?? "") : viewModel.model
    }

    private var headerSubtitle: String {
        let label = catalog?.label(for: currentModel) ?? currentModel
        return [RepoTile.label(for: viewModel.session.effectiveRepo), label]
            .filter { !$0.isEmpty }
            .joined(separator: " · ")
    }

    @ViewBuilder
    private var modelMenuContents: some View {
        if let option = catalog?.option(for: currentModel),
           let efforts = option.efforts, !efforts.isEmpty {
            Section("Reasoning") {
                ForEach(efforts, id: \.self) { level in
                    Button {
                        viewModel.effort = level
                    } label: {
                        if viewModel.effort == level {
                            Label(EffortLevel.label(level), systemImage: "checkmark")
                        } else {
                            Text(EffortLevel.label(level))
                        }
                    }
                }
            }
        }
        if catalog?.option(for: currentModel)?.fastModeSupported == true {
            Button {
                viewModel.fastMode.toggle()
            } label: {
                if viewModel.fastMode {
                    Label("Fast mode", systemImage: "checkmark")
                } else {
                    Text("Fast mode")
                }
            }
        }
        if let catalog {
            Menu {
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
            } label: {
                Label(
                    "Model — \(catalog.label(for: currentModel))",
                    systemImage: "cpu"
                )
            }
        }
    }

    /// Re-pin to the latest for a beat while the opening transcript settles.
    private func beginHold(_ proxy: ScrollViewProxy) {
        holdTask?.cancel()
        holdingAtLatest = true
        holdTask = Task {
            // Re-assert during the window, not just at its end: a row that
            // grows at 0.4s pushes the bottom away, and one scroll at 2.5s
            // would leave the reader looking at the wrong place until then.
            for _ in 0..<Int(initialHoldSeconds / 0.25) {
                try? await Task.sleep(for: .milliseconds(250))
                guard !Task.isCancelled, holdingAtLatest else { return }
                scrollToBottom(proxy, animated: false)
            }
            holdingAtLatest = false
        }
    }

    private func endHold() {
        holdTask?.cancel()
        holdTask = nil
        holdingAtLatest = false
    }

    private func scrollToBottom(_ proxy: ScrollViewProxy, animated: Bool) {
        let target: String
        if viewModel.pendingQuestion != nil {
            target = "ask-\(viewModel.pendingQuestion!.id)"
        } else if !viewModel.liveText.isEmpty {
            target = "live-stream"
        } else if let last = viewModel.displayBlocks.last {
            target = last.id
        } else {
            return
        }
        if animated {
            withAnimation(.snappy) { proxy.scrollTo(target, anchor: .bottom) }
        } else {
            proxy.scrollTo(target, anchor: .bottom)
        }
    }
}

#if os(iOS)
/// The session's overflow menu — the trailing nav-bar control, a native `Menu` so
/// iOS renders (and animates) it as a real UIMenu.
///
/// It carries the worktree actions the sidebar row offers under long-press, so
/// the session isn't a dead end for them: details, its pull request, rename, share,
/// hide and archive — plus "New session", which used to be the bare `+` this menu
/// replaced.
///
/// Its own view struct on purpose. The menu reads `prDetails` and the hide
/// store, and reading either inside `SessionView.body` would re-evaluate the
/// whole body — transcript included — every time one of them moved.
private struct SessionActionsMenu: View {
    let viewModel: SessionViewModel
    /// The sessions of this worktree — the sidebar row, regrouped below.
    let tabs: [Session]
    /// Workspace names for that regrouping; see `SessionView.workspaceNames`.
    let workspaceNames: [String: String]
    let onNewSession: (() -> Void)?
    let onRenameWorkspace: ((String) -> Void)?
    let onArchiveWorkspace: (() -> Void)?
    @Binding var showWorktreeInfo: Bool
    @Binding var showPrPanel: Bool
    @Binding var renaming: Bool
    @Binding var renameText: String

    var body: some View {
        Menu {
            if let onNewSession {
                Button(action: onNewSession) {
                    // Two words, because the workspace it lands in is the one
                    // you're already looking at — spelling it out wrapped the
                    // row onto two lines to say what the tab strip then shows
                    // anyway. VoiceOver keeps the long form, where naming the
                    // scope costs no space: the same split as the web tab
                    // strip's bare "+" and its aria-label.
                    Label("New session", systemImage: "plus")
                }
                .accessibilityLabel(
                    // A workspace-less legacy session has nothing to join, so
                    // the plain wording stays honest there.
                    viewModel.session.workspaceId == nil
                        ? "New session"
                        : "New session in this workspace"
                )
            }
            Button {
                showWorktreeInfo = true
            } label: {
                Label("Worktree details", systemImage: "info.circle")
            }
            if let number = viewModel.prDetails?.number ?? viewModel.session.prNumber {
                Button {
                    showPrPanel = true
                } label: {
                    Label {
                        Text(verbatim: "Pull request #\(number)")
                    } icon: {
                        Image(systemName: "arrow.triangle.pull")
                    }
                }
            }

            Section {
                // The rename itself runs from SessionView's alert; the menu
                // only raises it, so the callback's presence is the gate.
                if onRenameWorkspace != nil {
                    Button {
                        renameText = workspace?.title ?? viewModel.session.displayTitle
                        renaming = true
                    } label: {
                        Label("Rename", systemImage: "pencil")
                    }
                }
                if let link = workspace?.shareURL {
                    ShareLink(item: link) {
                        Label("Share link", systemImage: "square.and.arrow.up")
                    }
                }
            }

            if let workspace, !workspace.isOptimistic {
                Section {
                    // Hiding is the personal counterpart to archiving: the row
                    // leaves YOUR sidebar while the session keeps running for
                    // everyone else — so it isn't destructive-styled.
                    if HideStore.shared.isHidden(workspace) {
                        Button {
                            // `unhide` rather than clearing this row's key:
                            // it drops every key the session could sit under,
                            // which is deliberately safe (over-clearing only
                            // ever restores a row) and keeps the menu off the
                            // row-key helper.
                            HideStore.shared.unhide(for: viewModel.session)
                        } label: {
                            Label("Restore to my sidebar", systemImage: "eye")
                        }
                    } else {
                        Button {
                            HideStore.shared.hide(workspace)
                        } label: {
                            Label("Hide from my sidebar", systemImage: "eye.slash")
                        }
                    }
                    if let onArchiveWorkspace {
                        Button(role: .destructive, action: onArchiveWorkspace) {
                            Label("Archive", systemImage: "archivebox")
                        }
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .foregroundStyle(OS1VisualStyle.text)
        }
        .accessibilityLabel("Session actions")
    }

    /// The sidebar row these sessions form. `tabs` is exactly one worktree's
    /// sessions, so regrouping them reproduces the row — and, crucially, the row
    /// KEY that hides are stored under — without reaching for the list's model.
    private var workspace: SidebarWorkspace? {
        SessionsListViewModel.sidebarWorkspaces(
            in: tabs,
            workspaceNames: workspaceNames
        ).first { workspace in
            workspace.sessions.contains { $0.id == viewModel.session.id }
        }
    }
}
#endif

/// The way back to the bottom of a transcript the reader scrolled away from.
///
/// It doubles as the "there is output you haven't seen" signal: when new
/// content landed below the fold it says so in the accent colour instead of
/// quietly offering navigation, which is the difference between a control and
/// a notification.
private struct ScrollToLatestPill: View {
    let hasNewOutput: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 5) {
                Image(systemName: "arrow.down")
                    .font(.system(size: 11, weight: .semibold))
                Text(hasNewOutput ? "New messages" : "Scroll to bottom")
                    .font(.footnote.weight(.medium))
            }
            .foregroundStyle(
                hasNewOutput ? OS1VisualStyle.accent : OS1VisualStyle.textDim
            )
            .padding(.horizontal, 14)
            .padding(.vertical, 8)
            // Opaque, not just glass: the pill floats over the transcript, and
            // clear glass over body text left the label barely readable.
            .background(OS1VisualStyle.background.opacity(0.75), in: Capsule())
            .background(.thickMaterial, in: Capsule())
            .glassSurface(in: Capsule(), interactive: true)
            .overlay {
                Capsule().stroke(OS1VisualStyle.border, lineWidth: 0.5)
            }
            .contentShape(Capsule())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(
            hasNewOutput ? "New messages below. Scroll to latest" : "Scroll to latest"
        )
    }
}

#if os(iOS)
/// Keeps the tab strip anchored while sibling conversations move horizontally
/// according to their order. Recently visited conversations reuse their loaded
/// view model; SessionView still disconnects each socket while it is off-screen.
struct SessionTabsView: View {
    let initialSession: Session
    let tabs: [Session]
    /// Passed straight through to SessionView; see its `workspaceNames`.
    let workspaceNames: [String: String]
    let viewModelForSession: (Session) -> SessionViewModel
    let onSaveComposerDraft: (Session, SessionViewModel.ComposerDraft) -> Void
    /// Open a new session in this workspace. Answers with the session that was
    /// created — this view focuses it as a tab — or nil when there was nothing
    /// to open as one (a workspace-less session falls back to the composer
    /// sheet, and a failed create has already surfaced its error).
    let onNewSession: () async -> Session?
    /// Rename the worktree these sessions share, from the session's overflow menu.
    let onRenameWorkspace: (String) -> Void
    /// Archive every session of the worktree, from the session's overflow menu.
    let onArchiveWorkspace: () -> Void
    /// Close (archive) a session closed from the tab strip.
    let onCloseTab: (Session) -> Void

    @State private var activeId: String
    @State private var transitionEdge = Edge.trailing
    /// Sessions closed from the strip during this visit. Archiving alone doesn't
    /// retire the pushed session's tab: `tabSessions` deliberately keeps the
    /// session the stack was pushed with even once it's archived (so a session
    /// opened from the archive sheet still renders), which would leave the tab
    /// you just closed sitting in the strip.
    @State private var closedIds: Set<String> = []
    /// A "+" that hasn't answered yet, so a second tap can't mint a second tab.
    @State private var openingTab = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dismiss) private var dismiss
    /// The appearance outside the bar, to pin the floating tab strip to.
    @Environment(\.colorScheme) private var tabsColorScheme

    init(
        session: Session,
        tabs: [Session],
        workspaceNames: [String: String] = [:],
        viewModelForSession: @escaping (Session) -> SessionViewModel,
        onSaveComposerDraft: @escaping (Session, SessionViewModel.ComposerDraft) -> Void,
        onNewSession: @escaping () async -> Session?,
        onRenameWorkspace: @escaping (String) -> Void,
        onArchiveWorkspace: @escaping () -> Void,
        onCloseTab: @escaping (Session) -> Void
    ) {
        initialSession = session
        self.tabs = tabs
        self.workspaceNames = workspaceNames
        self.viewModelForSession = viewModelForSession
        self.onSaveComposerDraft = onSaveComposerDraft
        self.onNewSession = onNewSession
        self.onRenameWorkspace = onRenameWorkspace
        self.onArchiveWorkspace = onArchiveWorkspace
        self.onCloseTab = onCloseTab
        _activeId = State(initialValue: session.id)
    }

    private var visibleTabs: [Session] {
        tabs.filter { !closedIds.contains($0.id) }
    }

    private var activeSession: Session {
        visibleTabs.first(where: { $0.id == activeId })
            ?? visibleTabs.first
            ?? initialSession
    }

    private var conversationTransition: AnyTransition {
        guard !reduceMotion else { return .opacity }
        let removalEdge: Edge = transitionEdge == .trailing ? .leading : .trailing
        return .asymmetric(
            insertion: .move(edge: transitionEdge).combined(with: .opacity),
            removal: .move(edge: removalEdge).combined(with: .opacity)
        )
    }

    var body: some View {
        ZStack {
            ForEach([activeSession]) { session in
                SessionView(
                    viewModel: viewModelForSession(session),
                    tabs: visibleTabs,
                    workspaceNames: workspaceNames,
                    onSaveComposerDraft: { draft in
                        onSaveComposerDraft(session, draft)
                    },
                    onNewSession: openNewTab,
                    onRenameWorkspace: onRenameWorkspace,
                    // Archiving the worktree from within it leaves nothing to
                    // show here, so pop back to the sessions list — the same
                    // landing as closing the last tab.
                    onArchiveWorkspace: {
                        onArchiveWorkspace()
                        dismiss()
                    }
                )
                .transition(conversationTransition)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        // No .clipped() here: this container sits within the safe area, so a
        // clip cuts the transcript's edge-to-edge rendering at the safe-area
        // bounds — an opaque-looking nav bar and a dead strip above the home
        // indicator. Tab-switch slides may draw offscreen; that's invisible
        // on a full-screen push.
        // A BAR, not a plain inset — the same reason the composer is one (see
        // SessionView.body): `safeAreaBar` is what tells the scroll view its
        // content travels behind the strip, which is what makes the tabs float
        // over the transcript and draws the soft scroll edge effect there. With
        // a plain inset the transcript simply started below an opaque band.
        .safeAreaBar(edge: .top, spacing: 0) {
            if visibleTabs.count > 1 {
                SessionTabBar(
                    tabs: visibleTabs,
                    activeId: activeId,
                    onSelect: select,
                    onClose: close
                )
                // Same reason the composer bar is pinned (see
                // SessionView.inputBar): a `safeAreaBar` is adaptive chrome,
                // and dark content travelling under it repaints the strip and
                // its labels in the other appearance.
                .environment(\.colorScheme, tabsColorScheme)
            }
        }
        // Reading a session clears its unread mark, and keeps clearing it while
        // you stay in it: `activeSession` is re-read from the sessions poll,
        // so each new `lastActivity` re-marks the open session instead of bolding
        // its row behind you. Same rule as the web viewer's markRead tick.
        .onChange(of: activeSession, initial: true) { _, session in
            ReadsStore.shared.open(session)
        }
        .onDisappear { ReadsStore.shared.close(activeSession.id) }
        .onChange(of: visibleTabs) { _, updatedTabs in
            guard !updatedTabs.contains(where: { $0.id == activeId }),
                  let fallback = updatedTabs.first
            else { return }

            var transaction = Transaction()
            transaction.disablesAnimations = true
            withTransaction(transaction) {
                activeId = fallback.id
            }
        }
    }

    /// Close a session from the strip: archive it, then land on a neighbour —
    /// the tab to its right, or the one to its left when it was last. Closing
    /// the only remaining session leaves nothing to show, so the stack pops back
    /// to the sessions list.
    private func close(_ session: Session) {
        let strip = visibleTabs
        let next = SessionsListViewModel.tabAfterClosing(session, in: strip)
        onCloseTab(session)

        guard let next else {
            dismiss()
            return
        }
        withAnimation(tabSwitchAnimation) {
            if session.id == activeId {
                let closedIndex = strip.firstIndex { $0.id == session.id } ?? 0
                let nextIndex = strip.firstIndex { $0.id == next.id } ?? 0
                transitionEdge = nextIndex > closedIndex ? .trailing : .leading
                activeId = next.id
            }
            _ = closedIds.insert(session.id)
        }
    }

    /// One conversation giving way to another: a tab closed, tapped, or newly
    /// opened at the end of the strip. They're the same move, so they share a
    /// curve.
    private var tabSwitchAnimation: Animation {
        reduceMotion
            ? .easeOut(duration: 0.16)
            : .snappy(duration: 0.26, extraBounce: 0)
    }

    /// The overflow menu's "New session in this workspace": open the tab, don't
    /// ask about it. The session is created empty, so the new tab lands on its
    /// own composer — the sheet had nothing left to collect. It joins `tabs`
    /// through the list's optimistic overlay before this returns, so switching
    /// to it is an ordinary tab selection.
    private func openNewTab() {
        guard !openingTab else { return }
        openingTab = true
        Task {
            let created = await onNewSession()
            openingTab = false
            guard let created else { return }
            withAnimation(tabSwitchAnimation) {
                // A new session sorts last, so it always arrives from the right.
                transitionEdge = .trailing
                activeId = created.id
            }
        }
    }

    private func select(_ session: Session) {
        guard session.id != activeId,
              let targetIndex = visibleTabs.firstIndex(where: { $0.id == session.id })
        else { return }

        let currentIndex = visibleTabs.firstIndex(where: { $0.id == activeId }) ?? 0
        withAnimation(tabSwitchAnimation) {
            transitionEdge = targetIndex > currentIndex ? .trailing : .leading
            activeId = session.id
        }
    }
}

/// Workspace session tabs, as individually floating glass pills under the
/// navigation bar. Not one bar: each tab is its own capsule with its own
/// surface, so the row reads as chips over the session rather than a second band
/// of chrome. The transcript passes BEHIND them (the strip is attached as a
/// `safeAreaBar`) and dissolves through the soft scroll edge effect plus
/// `tabStripTopWash`.
///
/// The active tab is centered when the strip opens, while horizontal overflow
/// remains native touch scrolling.
private struct SessionTabBar: View {
    let tabs: [Session]
    let activeId: String
    let onSelect: (Session) -> Void
    /// Close (archive) a session from the strip. Nil leaves the tabs read-only.
    var onClose: ((Session) -> Void)? = nil
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Namespace private var activeTabIndicator

    /// Every pill wears this shape — its glass, its material, and the active
    /// tab's fill — so the three layers share one silhouette.
    private var pillShape: Capsule { Capsule(style: .continuous) }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView(.horizontal) {
                HStack(spacing: 6) {
                    ForEach(tabs) { session in
                        tab(session)
                    }
                }
                // The rail lives on the CONTENT, not the scroll view: pills
                // stay on the composer's 12pt line at rest and still scroll
                // out to the screen edges, where the wash takes them.
                .padding(.horizontal, 12)
                .padding(.vertical, 2)
            }
            .scrollIndicators(.hidden)
            // No top padding: the pills are the session's own chrome rather than
            // a second band, so they ride tight under the navigation bar.
            .padding(.bottom, 4)
            .tabStripTopWash()
            .onAppear {
                proxy.scrollTo(activeId, anchor: .center)
            }
            .onChange(of: activeId) { _, id in
                if reduceMotion {
                    proxy.scrollTo(id, anchor: .center)
                } else {
                    withAnimation(.snappy) { proxy.scrollTo(id, anchor: .center) }
                }
            }
        }
    }

    /// One tab pill. The close affordance is attached here rather than in the
    /// strip so an optimistic session — which the server can't archive yet — is
    /// simply left without one, instead of long-pressing into an empty menu.
    @ViewBuilder
    private func tab(_ session: Session) -> some View {
        let pill = tabPill(session, close: closeAction(for: session))
        if let close = closeAction(for: session) {
            pill.contextMenu {
                Button(role: .destructive) {
                    close(session)
                } label: {
                    Label("Close session", systemImage: "xmark")
                }
            }
        } else {
            pill
        }
    }

    private func closeAction(for session: Session) -> ((Session) -> Void)? {
        session.isOptimistic ? nil : onClose
    }

    private func tabPill(
        _ session: Session,
        close: ((Session) -> Void)?
    ) -> some View {
        let isActive = session.id == activeId
        // The × rides on the OPEN tab only, matching the web strip's "close the
        // session you're in" gesture without spending an extra 32pt of a phone's
        // strip on every sibling — those close through the long-press menu.
        let showsClose = isActive && close != nil
        return HStack(spacing: 0) {
            Button {
                if !isActive { onSelect(session) }
            } label: {
                HStack(spacing: 7) {
                    if session.waitingForInput == true {
                        PulsingDot(
                            color: OS1VisualStyle.blue,
                            size: 6
                        )
                    } else if session.isRunning == true {
                        PulsingDot(
                            color: OS1VisualStyle.yellow,
                            size: 6
                        )
                    }
                    Text(session.displayTitle)
                        .font(.footnote.weight(
                            isActive ? .semibold : .medium
                        ))
                        .lineLimit(1)
                }
                .foregroundStyle(
                    isActive
                        ? OS1VisualStyle.text
                        : OS1VisualStyle.textDim
                )
                .padding(.leading, 12)
                // The × supplies the trailing inset when it's there.
                .padding(.trailing, showsClose ? 2 : 12)
                .frame(minWidth: 44, minHeight: 44)
                .frame(maxWidth: dynamicTypeSize.isAccessibilitySize ? 260 : 180)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityAddTraits(
                isActive ? .isSelected : []
            )
            .accessibilityValue(tabAccessibilityValue(session))

            if showsClose, let close {
                Button {
                    close(session)
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 11, weight: .bold))
                        .foregroundStyle(OS1VisualStyle.textDim)
                        // A full-height 32pt box: the glyph stays small, the
                        // tappable area clears Apple's 44pt guidance vertically
                        // and sits comfortably wide of the title.
                        .frame(width: 32, height: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Close session")
            }
        }
        // The active tab's fill sits INSIDE its own glass, above the material:
        // with every pill carrying its own surface there is no shared band for
        // an indicator to slide along, so "selected" is a tint on the pill.
        .background {
            if isActive {
                let indicator = pillShape.fill(OS1VisualStyle.hover)

                if reduceMotion {
                    indicator
                } else {
                    indicator.matchedGeometryEffect(
                        id: "active-session-tab",
                        in: activeTabIndicator
                    )
                }
            }
        }
        // Near-solid, exactly like the composer: the transcript passes behind
        // each pill, and bare glass took on the luminance of whatever scrolled
        // under it — a dark code block dragged the whole tab dark. The page
        // colour over a thick material holds it at a stable brightness; the
        // session still shows around it, not through it.
        .background(OS1VisualStyle.background.opacity(0.7), in: pillShape)
        .background(.thickMaterial, in: pillShape)
        .glassSurface(in: pillShape, interactive: true)
        .id(session.id)
    }

    private func tabAccessibilityValue(_ session: Session) -> String {
        let state = if session.waitingForInput == true {
            "Needs input"
        } else if session.isRunning == true {
            "Running"
        } else {
            "Idle"
        }
        return session.id == activeId ? "Selected, \(state)" : state
    }
}
#endif

/// The bottom input area: queue/steer/delivering chips, the run-status chip,
/// staged images, and the composer. A SEPARATE view struct on purpose — its
/// body is the only place that reads `viewModel.draft` / `canSend`, so with
/// @Observable's per-body tracking a keystroke invalidates just this bar.
/// When these lived as computed properties of SessionView, every keystroke
/// re-evaluated SessionView.body and re-diffed every visible transcript row
/// on the main thread — typing visibly hitched on long sessions even with
/// nothing streaming.
private struct SessionInputBar: View {
    @Bindable var viewModel: SessionViewModel
    @AppStorage("os1.composer.sendKey") private var sendKey = "enter"
    @AppStorage("os1.composer.busySend") private var busySend = "queue"
    /// Matches the transcript column cap so the bar centers with it.
    let contentMaxWidth: CGFloat
    let horizontalInset: CGFloat
    @FocusState private var inputFocused: Bool
    /// What the "+" menu opened, if anything. One `@State` and one `.sheet`
    /// on purpose: stacking sheet modifiers on a single view leaves only the
    /// last one working.
    private enum ComposerSheet: Identifiable {
        case goal, reference, schedule
        /// Rewriting a message that's still waiting in the server's queue.
        case editQueued(QueueItem)

        var id: String {
            switch self {
            case .goal: "goal"
            case .reference: "reference"
            case .schedule: "schedule"
            case .editQueued(let item): "edit-\(item.id)"
            }
        }
    }
    @State private var sheet: ComposerSheet?
    /// In-flight promote — the row says so rather than looking inert, since
    /// cutting a worktree isn't always instant.
    @State private var promoting = false
    /// Latched once the draft has wrapped past one line, cleared when the
    /// draft empties. It has to latch: the multi-line layout hands the field
    /// the whole width, so text that just wrapped between the round buttons
    /// usually fits on one line again once it opens — an unlatched height
    /// test would oscillate between the two forms on a single keystroke.
    @State private var draftWrapped = false
    /// Roughly the height of a one-line `.body` field, scaled with Dynamic
    /// Type. The wrap test compares against 1.6× this, comfortably between
    /// one line and two whatever internal padding the field carries.
    @ScaledMetric(relativeTo: .body) private var oneLineFieldHeight: CGFloat = 22

    /// Air above the topmost element in the bar — and where the composer
    /// scrim's dissolve has to finish, so it ends level with that element.
    private static let barTopPadding: CGFloat = 6

    #if os(macOS)
    /// Local key monitor that turns Shift+Return into a newline insert.
    @State private var shiftReturnMonitor: Any?
    #endif

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if viewModel.isRunning
                || (viewModel.queuedCount > 0 && viewModel.queuedItems.isEmpty)
                || visibleNotice != nil {
                // Compact glass chip floating above the composer.
                HStack(spacing: 6) {
                    if viewModel.isRunning {
                        // Pulsing dot + live elapsed clock, like the web
                        // viewer's busy row — not a static "Running" label.
                        PulsingDot(color: .green, size: 7)
                        RunElapsedLabel(since: viewModel.runStartedAt)
                            .foregroundStyle(.secondary)
                    }
                    if viewModel.queuedCount > 0, viewModel.queuedItems.isEmpty {
                        // Pre-handshake count from the sessions list, before
                        // the watch delivers the actual items.
                        Text("\(viewModel.queuedCount) queued")
                            .foregroundStyle(.secondary)
                    }
                    if let notice = visibleNotice {
                        Text(notice)
                            .foregroundStyle(.orange)
                            .lineLimit(1)
                    }
                }
                .font(.caption2)
                .padding(.horizontal, 10)
                .padding(.vertical, 5)
                .glassSurface(in: Capsule())
            }

            if !viewModel.attachedImages.isEmpty {
                AttachedImagesRow(images: viewModel.attachedImages) { image in
                    viewModel.attachedImages.removeAll { $0.id == image.id }
                }
            }

            VStack(spacing: 0) {
                if hasQueueItems {
                    queueFlap
                        // Slides out from behind the composer rather than
                        // jump-cutting: the flap IS the composer's tucked-in
                        // sibling, so it should look like it came from there.
                        .transition(
                            .move(edge: .bottom).combined(with: .opacity)
                        )
                        .zIndex(0)
                }
                composer
                    .zIndex(1)
            }
            // One animation for the whole flap: rows arriving, leaving, being
            // steered from one section to the next, and the bar's own reflow
            // all move together. Keyed on a signature rather than a count so
            // an in-place edit animates too.
            .animation(.smooth(duration: 0.26), value: queueSignature)
        }
        .frame(maxWidth: contentMaxWidth)
        .frame(maxWidth: .infinity)
        .padding(.horizontal, horizontalInset)
        .padding(.top, Self.barTopPadding)
        .padding(.bottom, 8)
        // A session that has never run has nothing to read, so the only thing
        // to do in it is write — open with the keyboard up. This is the tab
        // strip's "+" landing: the tab appears already waiting for the prompt
        // that the sheet used to ask for.
        .onAppear {
            if viewModel.session.neverRan { inputFocused = true }
        }
        // Presented from the bar, not from the "+" itself: the button moves
        // between the collapsed pill and the expanded toolbar, and a sheet
        // anchored to a view that goes away closes with it.
        .sheet(item: $sheet) { which in
            switch which {
            case .goal:
                GoalSheet(
                    initial: viewModel.goal ?? "",
                    hadGoal: viewModel.goal != nil
                ) { goal in
                    viewModel.setGoal(goal)
                }
            case .reference:
                ReferenceFileSheet(sessionId: viewModel.session.id) { match in
                    viewModel.insertMention(match.insert)
                    inputFocused = true
                }
            case .schedule:
                SchedulePromptSheet { at in
                    do {
                        try await viewModel.schedulePrompt(at: at)
                        return nil
                    } catch {
                        return "Couldn't schedule that message."
                    }
                }
            case .editQueued(let item):
                // The raw content, not the chip's cleaned-up body: editing is
                // only offered for messages a person typed, where the two are
                // the same, and saving the stripped form of anything else
                // would quietly drop its routing prefix.
                QueuedMessageEditor(
                    initial: item.content,
                    onSave: { viewModel.editQueued(item, content: $0) },
                    onDelete: { viewModel.deleteQueued(item) }
                )
            }
        }
        // No background: the composer and chips are individual glass elements
        // floating over the transcript, which stays visible behind and below
        // them and dissolves into the bar through the soft scroll edge effect
        // — plus a wash under the pill, where that effect alone left rows
        // legible right down to the home indicator.
        #if os(iOS)
        .composerBottomWash()
        #endif
        #if os(macOS)
        .onAppear { installShiftReturnMonitor() }
        .onDisappear { removeShiftReturnMonitor() }
        #endif
    }

    /// Messages this app is still holding for the server. Read here, in the
    /// input bar, rather than in `SessionView.body` — an outbox change must
    /// not re-evaluate the whole transcript.
    private var unsentItems: [Outbox.Item] {
        viewModel.outbox.items(for: viewModel.session.id)
    }

    private var hasQueueItems: Bool {
        !viewModel.deliveringItems.isEmpty || !viewModel.steeredItems.isEmpty
            || !viewModel.queuedItems.isEmpty || !unsentItems.isEmpty
    }

    private var visibleNotice: String? {
        guard let notice = viewModel.notice else { return nil }
        if case .connected = viewModel.connectionState { return notice }
        let normalized = notice.lowercased()
        return normalized.contains("connect") || normalized.contains("socket")
            ? nil
            : notice
    }

    /// The queue uses the web composer's flap treatment: inset from the input,
    /// rounded at the top, and tucked behind the composer at the bottom.
    private var queueFlap: some View {
        VStack(alignment: .leading, spacing: 0) {
            Text(queueTitle)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
                .padding(.horizontal, 12)
                .padding(.bottom, 4)

            ForEach(viewModel.deliveringItems) { item in
                QueuedMessageRow(
                    item: item, phase: .delivering, showsDivider: item.id != firstRowId
                )
            }
            ForEach(viewModel.steeredItems) { item in
                QueuedMessageRow(
                    item: item,
                    phase: .steering,
                    showsDivider: item.id != firstRowId,
                    // The run keeps the message either way — this only
                    // retires the receipt early.
                    onDelete: { viewModel.dismissSteered(item) }
                )
            }
            ForEach(viewModel.queuedItems) { item in
                QueuedMessageRow(
                    item: item,
                    phase: .queued,
                    showsDivider: item.id != firstRowId,
                    // Steering needs a run to fold into, and the server can't
                    // fold a message that carries files.
                    onSteer: (viewModel.isRunning && !item.hasFiles)
                        ? { viewModel.steerQueued(item) } : nil,
                    onEdit: { sheet = .editQueued(item) },
                    onMove: viewModel.canReorder(item)
                        ? { offset in viewModel.moveQueued(item, by: offset) } : nil,
                    onDelete: { viewModel.deleteQueued(item) }
                )
            }
            // Still ours: written, saved, not yet acknowledged by the server.
            // These sit last because they're the furthest from the transcript.
            ForEach(unsentItems) { item in
                QueuedMessageRow(
                    // Images stay on disk as blobs — the row flags that the
                    // message carries attachments rather than paying a read
                    // per body evaluation to thumbnail them.
                    item: QueueItem(
                        id: item.id,
                        content: item.content,
                        user: item.user,
                        hasFiles: !item.imageFiles.isEmpty
                    ),
                    phase: item.failed ? .failed : .unsent,
                    showsDivider: item.id != firstRowId,
                    detail: item.failed
                        ? item.lastError
                        : (viewModel.outbox.sendingId == item.id ? "Sending…" : nil),
                    // Nothing has been sent yet, so "edit" is literally taking
                    // the message back — it returns to the composer whole,
                    // images included, and the outbox copy goes away.
                    onEdit: viewModel.outbox.sendingId == item.id
                        ? nil : { viewModel.editUnsent(item) },
                    onRetry: item.failed
                        ? { viewModel.outbox.retry(id: item.id) } : nil,
                    onDelete: { viewModel.outbox.delete(id: item.id) }
                )
            }
        }
        .padding(.top, 10)
        .padding(.bottom, 26)
        // Opaque page colour, NOT a material: a material takes its tone from
        // whatever is behind it, so a code block scrolling under the bar
        // turned the flap (and the messages in it) dark in a light-mode app.
        // Chrome you type into has to hold its own colour. `raised` rather
        // than `background` keeps it a shade off the composer, so the two
        // still read as two layers of one piece.
        .background(OS1VisualStyle.raised, in: flapShape)
        .overlay { flapShape.stroke(OS1VisualStyle.border, lineWidth: 0.5) }
        .padding(.horizontal, 18)
        .padding(.bottom, -14)
    }

    private var flapShape: UnevenRoundedRectangle {
        UnevenRoundedRectangle(
            topLeadingRadius: 20,
            bottomLeadingRadius: 0,
            bottomTrailingRadius: 0,
            topTrailingRadius: 20,
            style: .continuous
        )
    }

    /// Identity of the topmost row, so every row below it can draw the
    /// separator that divides them — the flap's sections are one list, not
    /// four, and it should read as one.
    private var firstRowId: String? {
        viewModel.deliveringItems.first?.id
            ?? viewModel.steeredItems.first?.id
            ?? viewModel.queuedItems.first?.id
            ?? unsentItems.first?.id
    }

    private var queueTitle: String {
        let queued = viewModel.queuedItems.count
        let inFlight = viewModel.steeredItems.count + viewModel.deliveringItems.count
        let unsent = unsentItems.count
        // Unsent leads: "waiting on your connection" is the more urgent fact,
        // and it's the one the person can act on.
        if unsent > 0 && queued == 0 && inFlight == 0 {
            return "\(unsent) unsent \(unsent == 1 ? "message" : "messages")"
        }
        var parts: [String] = []
        if queued > 0 { parts.append("\(queued) queued") }
        // Never folded into the "queued" count: these are already committed to
        // the running turn, and calling them queued reads as "my message
        // didn't go through" (the web learned this the hard way).
        if inFlight > 0 { parts.append("\(inFlight) in flight") }
        if unsent > 0 { parts.append("\(unsent) unsent") }
        return parts.joined(separator: " · ")
    }

    /// What the flap currently shows, as a value the animation can key on:
    /// every row's identity and phase, plus queued text so an in-place edit
    /// animates rather than snapping.
    private var queueSignature: String {
        var parts: [String] = []
        parts.append(contentsOf: viewModel.deliveringItems.map { "d\($0.id)" })
        parts.append(contentsOf: viewModel.steeredItems.map { "s\($0.id)" })
        parts.append(contentsOf: viewModel.queuedItems.map { "q\($0.id):\($0.content.count)" })
        parts.append(contentsOf: unsentItems.map { "u\($0.id)\($0.failed ? "!" : "")" })
        return parts.joined(separator: "|")
    }

    /// Phone resting layout: ONE row — [+] [field] [send], the way Slack and
    /// Messages do it, with the controls seated on the pill's bottom edge.
    /// Once the draft passes one line it becomes the Messages multi-line
    /// form instead: the text takes the full width of the box with real air
    /// around it, and the controls drop to their own row underneath. Growing
    /// the field between the buttons instead would keep squeezing long text
    /// into the narrow middle column. Mac always uses the multi-line form.
    private var isSingleRow: Bool {
        #if os(iOS)
        !draftWrapped && viewModel.attachedImages.isEmpty
        #else
        false
        #endif
    }

    /// Insets for the multi-line form. The phone's are Messages-sized: a
    /// wrapped draft is a block of prose and reads as one only with proper
    /// margins. The Mac composer sits in a wider window and keeps its
    /// tighter, longstanding values.
    private var multiLineInset: (horizontal: CGFloat, top: CGFloat, bottom: CGFloat) {
        #if os(iOS)
        (16, 14, 6)
        #else
        (10, 9, 5)
        #endif
    }

    /// Inset for the control row under the field. Smaller than the text's,
    /// because the round buttons carry ~6pt of their own transparent frame —
    /// matching the numbers would push them visibly further in than the text.
    private var controlRowInset: (horizontal: CGFloat, bottom: CGFloat) {
        #if os(iOS)
        (4, 5)
        #else
        (4, 3)
        #endif
    }

    private var composer: some View {
        VStack(alignment: .leading, spacing: 2) {
            // Bottom-aligned: as the draft grows the field rises and the round
            // buttons stay seated on the pill's bottom edge, rather than
            // drifting to the middle of a tall row.
            HStack(alignment: .bottom, spacing: 4) {
                if isSingleRow {
                    addMenu
                }

                TextField(
                    composerPlaceholder,
                    text: $viewModel.draft,
                    axis: .vertical
                )
                .textFieldStyle(.plain)
                .lineLimit(1...10)
                // Measured on the field itself, BEFORE the frame and padding
                // below — so the reading is the text's own height and doesn't
                // move when the surrounding layout does.
                .onGeometryChange(for: CGFloat.self) { $0.size.height } action: { height in
                    if height > oneLineFieldHeight * 1.6 { draftWrapped = true }
                }
                .onChange(of: viewModel.draft) { _, draft in
                    if draft.isEmpty { draftWrapped = false }
                }
                // A vertical-axis TextField is greedy: without an explicit
                // fill it claims the row's whole width in the pill and pushes
                // the send button off the right edge. The minimum height is
                // the round buttons' own, so a one-line draft sits centred
                // between them instead of hugging the bottom alignment.
                .frame(maxWidth: .infinity, minHeight: isSingleRow ? 44 : nil)
                // In the single row the buttons set the pill's height and the
                // field just sits between them. Multi-line, the text owns the
                // full width of the box and gets real air around it — the
                // inset a paragraph needs to read as a paragraph, not the 4pt
                // gap that suits a one-line field between two round buttons.
                .padding(.horizontal, isSingleRow ? 4 : multiLineInset.horizontal)
                .padding(.top, isSingleRow ? 0 : multiLineInset.top)
                .padding(.bottom, isSingleRow ? 0 : multiLineInset.bottom)
                .focused($inputFocused)
                // Mac: Return sends; Shift/Option-Return insert a newline. On
                // iOS the software keyboard's return key just wraps, as before.
                .onSubmit {
                    #if os(iOS)
                    viewModel.sendDraft()
                    #else
                    if sendKey == "enter" { viewModel.sendDraft() }
                    #endif
                }
                // A copied screenshot pastes straight into the attachments
                // (Cmd+V on Mac, long-press Paste on iOS); text pastes flow
                // through to the field untouched.
                .pastesImages(into: $viewModel.attachedImages)

                if isSingleRow {
                    // Stop is the only meaningful action while a turn runs
                    // with nothing typed; once there IS a draft, send joins
                    // it rather than replacing it — queueing the next message
                    // mid-run is the common case, and the two-row layout has
                    // always shown both.
                    if viewModel.isRunning {
                        stopButton
                    }
                    if !viewModel.isRunning || viewModel.canSend {
                        sendButton
                    }
                }
            }
            .padding(isSingleRow ? 4 : 0)

            if !isSingleRow {
                HStack(spacing: 6) {
                    addMenu
                    Spacer(minLength: 8)

                    if viewModel.isRunning {
                        stopButton
                    }

                    sendButton
                }
                .padding(.horizontal, controlRowInset.horizontal)
                .padding(.bottom, controlRowInset.bottom)
            }
        }
        #if os(iOS)
        // Near-solid surface, not a see-through pane: the transcript passes
        // BEHIND the composer, and a washed-out bar over live text made the
        // draft hard to read. The page color on top of a thick material lands
        // on white in light mode and stays dark in dark mode — the session still
        // shows around and below the pill, just not through it.
        .background(
            OS1VisualStyle.background.opacity(0.7),
            in: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        .background(
            .thickMaterial,
            in: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        #endif
        .glassSurface(
            in: RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        #if os(iOS)
        // No focus ring: an accent-coloured border around the input read as a
        // validation/error outline rather than "you can type here". The glass
        // surface and the caret are affordance enough — same call the web
        // composer made.
        .contentShape(
            RoundedRectangle(cornerRadius: composerCornerRadius, style: .continuous)
        )
        .simultaneousGesture(
            TapGesture().onEnded { inputFocused = true }
        )
        // Growth and the one-row → multi-line morph both want to track the
        // text rather than ease behind it — a snappy, short spring so a fast
        // typist never sees the box lagging the caret.
        .animation(.snappy(duration: 0.18), value: viewModel.draft)
        .animation(.snappy(duration: 0.18), value: isSingleRow)
        #endif
    }

    /// The composer's "+": attachments plus the session-level actions
    /// (mentions, goal, promote, scheduling) the web input has always carried
    /// behind the same button.
    private var addMenu: some View {
        ComposerAddMenu(
            images: $viewModel.attachedImages,
            hasGoal: viewModel.goal != nil,
            // `/goal` is a native slash command; a Slack- or Linear-sourced
            // session would just post the text at the agent. "backstage" is the
            // pre-rename source value older servers still send.
            onSetGoal: isNativeSession ? { sheet = .goal } : nil,
            onReferenceFile: { sheet = .reference },
            hasDraft: !viewModel.draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
            // Scheduling is a server-side hold on a native session's own queue;
            // an agent-owned session has no such queue to put it on.
            onSchedule: isNativeSession ? { sheet = .schedule } : nil,
            // Ask mode reads the code but can't change it. Promoting cuts a
            // worktree, so it's one-way — and the server only allows it here.
            onSwitchToCode: (isNativeSession && viewModel.session.mode == "ask")
                ? {
                    promoting = true
                    Task {
                        await viewModel.promoteToCode()
                        promoting = false
                    }
                }
                : nil,
            promoting: promoting
        )
    }

    /// A session this app owns end to end, rather than one mirrored from Slack or
    /// Linear. "backstage" is the pre-rename value older servers still send.
    private var isNativeSession: Bool {
        viewModel.session.source == "opensession"
            || viewModel.session.source == "backstage"
    }

    private var composerPlaceholder: String {
        guard viewModel.isRunning else { return "Message" }
        return busySend == "steer"
            ? "Message — steers this run"
            : "Message — queues for after this run"
    }

    /// Tapping sends the way the person's setting says (queue or steer);
    /// holding offers the other one for this message only. Both verbs are
    /// always one gesture away, the way ⌘/Ctrl+Enter makes them on the web —
    /// before this, steering a fresh message meant sending it, finding its
    /// chip, and tapping Steer. Only a running turn has anything to choose
    /// between, so an idle composer keeps the plain button.
    @ViewBuilder
    private var sendButton: some View {
        if viewModel.isRunning {
            Menu {
                Button {
                    viewModel.sendDraft(busyModeOverride: "steer")
                } label: {
                    Label(
                        "Steer into this run",
                        systemImage: busySend == "steer" ? "checkmark" : "arrow.turn.up.right"
                    )
                }
                Button {
                    viewModel.sendDraft(busyModeOverride: "queue")
                } label: {
                    Label(
                        "Queue for after this run",
                        systemImage: busySend == "steer" ? "clock" : "checkmark"
                    )
                }
            } label: {
                sendButtonFace
            } primaryAction: {
                viewModel.sendDraft()
            }
            .menuOrder(.fixed)
            .buttonStyle(.plain)
            .disabled(!viewModel.canSend)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
            .accessibilityLabel("Send")
            .accessibilityHint(
                busySend == "steer"
                    ? "Steers this run. Touch and hold to queue instead."
                    : "Queues for after this run. Touch and hold to steer instead."
            )
        } else {
            Button {
                viewModel.sendDraft()
            } label: {
                sendButtonFace
            }
            .buttonStyle(.plain)
            .disabled(!viewModel.canSend)
            .frame(width: 44, height: 44)
            .contentShape(Circle())
        }
    }

    /// The disc itself — identical in both forms, so gaining the hold menu
    /// doesn't change how the button looks.
    private var sendButtonFace: some View {
        Image(systemName: "arrow.up")
            .font(.system(size: 13, weight: .semibold))
            // Explicit colours for the resting state, not the semantic
            // `.fill.secondary` / `Color.secondary` pair: both are faint
            // to begin with, and the dimming SwiftUI applies to a disabled
            // button on top of that left the disc invisible against the
            // near-white composer (measured: 242 vs a 252 background).
            .foregroundStyle(
                viewModel.canSend ? OS1VisualStyle.onAccent : OS1VisualStyle.textDim
            )
            .frame(width: 32, height: 32)
            .background(
                viewModel.canSend
                    ? AnyShapeStyle(OS1VisualStyle.accent)
                    : AnyShapeStyle(OS1VisualStyle.hover),
                in: Circle()
            )
            .animation(.easeOut(duration: 0.15), value: viewModel.canSend)
    }

    @ViewBuilder
    private var stopButton: some View {
        #if os(macOS)
        Button {
            viewModel.cancelRun()
        } label: {
            Label("Stop", systemImage: "stop.fill")
                .font(.caption.weight(.medium))
        }
        .buttonStyle(.bordered)
        .tint(OS1VisualStyle.red)
        .controlSize(.small)
        .frame(minWidth: 68, minHeight: 44)
        .help("Stop current turn")
        #else
        Button {
            viewModel.cancelRun()
        } label: {
            Image(systemName: "stop.fill")
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 32, height: 32)
                .background(OS1VisualStyle.red, in: Circle())
        }
        .buttonStyle(.plain)
        .frame(width: 44, height: 44)
        .contentShape(Circle())
        .accessibilityLabel("Stop current turn")
        #endif
    }

    private var composerCornerRadius: CGFloat {
        #if os(macOS)
        18
        #else
        26
        #endif
    }

    #if os(macOS)
    /// Shift+Return inserts a newline while plain Return sends: a local key
    /// monitor routes it to the focused field editor as
    /// `insertNewlineIgnoringFieldEditor` (the same path Option+Return takes
    /// natively), so the break lands at the cursor.
    private func installShiftReturnMonitor() {
        guard shiftReturnMonitor == nil else { return }
        shiftReturnMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { event in
            MainActor.assumeIsolated {
                let mods = event.modifierFlags
                    .intersection(.deviceIndependentFlagsMask)
                    .subtracting(.capsLock)
                guard inputFocused, event.keyCode == 36 || event.keyCode == 76 else {
                    return event
                }
                let preferredSendKey = UserDefaults.standard.string(
                    forKey: "os1.composer.sendKey"
                ) ?? "enter"
                if mods == .command || mods == .control {
                    let mode = UserDefaults.standard.string(
                        forKey: "os1.composer.busySendMod"
                    ) ?? "steer"
                    viewModel.sendDraft(busyModeOverride: mode)
                    return nil
                }
                if mods == .shift || (mods.isEmpty && preferredSendKey == "mod-enter") {
                    NSApp.sendAction(
                        #selector(NSTextView.insertNewlineIgnoringFieldEditor(_:)),
                        to: nil, from: nil
                    )
                    return nil
                }
                return event
            }
        }
    }

    private func removeShiftReturnMonitor() {
        if let monitor = shiftReturnMonitor {
            NSEvent.removeMonitor(monitor)
            shiftReturnMonitor = nil
        }
    }
    #endif

    // MARK: - Queue rows

    /// One message that isn't in the transcript yet. "Unsent" hasn't reached
    /// the server at all (no signal, or it's still being retried) and is held
    /// on disk until it does; "Undelivered" is one the server refused, waiting
    /// on the person. "Queued" holds until the run fully finishes; "Steering"
    /// is already committed to deliver at the run's next turn boundary (a
    /// receipt — no actions left to take); "Delivering" has left the server
    /// queue and is waiting on its transcript echo (~1s file watcher) — inert,
    /// just kept visible.
    private struct QueuedMessageRow: View {
        enum Phase { case queued, steering, delivering, unsent, failed }

        let item: QueueItem
        let phase: Phase
        /// Every row but the first draws the hairline above it.
        var showsDivider = false
        var detail: String?
        var onSteer: (() -> Void)?
        var onEdit: (() -> Void)?
        /// -1 moves the message one place towards the front of the queue,
        /// +1 one place back. Absent when there's nothing to reorder.
        var onMove: ((Int) -> Void)?
        var onRetry: (() -> Void)?
        var onDelete: (() -> Void)?

        /// Sentinels and routing prefixes stripped, plus the "who sent this"
        /// tag — the queue carries agent-to-agent deliveries, not just what
        /// the person typed.
        private var message: QueueMessagePresentation {
            QueueMessagePresentation(content: item.content, user: item.user)
        }

        /// Only the states worth explaining say so. "Queued" is what the
        /// flap's own title already says, and repeating it under every
        /// message was pure noise; the clock beside it is enough.
        private var label: String? {
            switch phase {
            case .queued: nil
            case .steering: "Steering — delivers next turn"
            case .delivering: "Delivering…"
            case .unsent: detail ?? "Unsent — sends when you're back online"
            case .failed: detail ?? "Couldn't send"
            }
        }

        /// Only the states that need the person to know something wear their
        /// colour in words. Queued and in-flight are ordinary — their mark
        /// carries the colour and the label stays quiet, so a flap full of
        /// messages doesn't read as a flap full of warnings.
        private var labelColor: Color {
            switch phase {
            case .unsent: OS1VisualStyle.yellow
            case .failed: OS1VisualStyle.red
            case .queued, .steering, .delivering: OS1VisualStyle.textFaint
            }
        }

        /// The state, as a small tinted mark rather than a bold coloured
        /// sentence per row. In-flight pulses like the run chip above.
        @ViewBuilder
        private var mark: some View {
            switch phase {
            case .queued:
                // Carries the state for VoiceOver too, since the queued row
                // deliberately doesn't spell it out in text.
                Image(systemName: "clock")
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .accessibilityLabel("Queued — delivers after this run")
            case .steering, .delivering:
                PulsingDot(color: OS1VisualStyle.green, size: 6)
            case .unsent:
                Image(systemName: "arrow.up.circle")
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.yellow)
            case .failed:
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.red)
            }
        }

        /// Only a message a person typed is editable in place: a worker
        /// report or a GitHub FYI is routing, and rewriting one would strip
        /// the prefix the server delivers it by.
        private var canEdit: Bool {
            onEdit != nil && message.label == nil && !item.isLocalEcho
        }

        var body: some View {
            // The message leads and wears the text colour; its state is the
            // small mark beside it and one faint line under it. It used to be
            // the other way round — a bold orange banner per row over a dimmed
            // message — which made a queue of two ordinary messages look like
            // a stack of warnings.
            HStack(alignment: .top, spacing: 10) {
                mark
                    .frame(width: 12, height: 16)
                if let first = item.images.first,
                   let thumb = DataImage(dataURL: first) {
                    thumb
                        .frame(width: 32, height: 32)
                        .clipShape(RoundedRectangle(cornerRadius: 7, style: .continuous))
                        .overlay(alignment: .bottomTrailing) {
                            if item.images.count > 1 {
                                Text("+\(item.images.count - 1)")
                                    .font(.system(size: 9, weight: .semibold))
                                    .foregroundStyle(.white)
                                    .padding(.horizontal, 3)
                                    .background(.black.opacity(0.55), in: Capsule())
                                    .padding(2)
                            }
                        }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(message.body)
                        .font(.subheadline)
                        .lineLimit(2)
                        .foregroundStyle(OS1VisualStyle.text)
                    HStack(spacing: 5) {
                        if let label {
                            Text(label)
                                .font(.caption2)
                                .foregroundStyle(labelColor)
                                .lineLimit(1)
                        }
                        if let from = message.label {
                            Text(from)
                                .font(.caption2)
                                .foregroundStyle(OS1VisualStyle.textFaint)
                                .lineLimit(1)
                        }
                        if item.hasFiles {
                            Image(systemName: "paperclip")
                                .font(.caption2)
                                .foregroundStyle(OS1VisualStyle.textFaint)
                        }
                    }
                }
                Spacer(minLength: 6)
                // Glyphs, not words: three peer actions on a two-line row, so
                // they read as a row of controls the way the web's do. Steer
                // wears the composer's own send arrow — folding a held
                // message into the live run IS sending it now, and the arrow
                // says that faster than the word "steer" ever did.
                // Discard, edit, then send: destructive furthest from the
                // thumb's resting path and the primary action rightmost,
                // directly above the composer's own send button.
                //
                // Single-stroke glyphs, so the three read as one set beside
                // the arrow: a bin and a bare pencil were the two densest
                // marks on a row whose point is the message. Discard is an
                // `xmark` — the same dismissal the composer's attachments and
                // the note-mode chip use, and honest about what happens (the
                // message never reached the transcript, so nothing is being
                // destroyed). Edit is the compose square, which unlike a lone
                // pencil reads as "rewrite this message" rather than a
                // generic annotation.
                HStack(spacing: 0) {
                    if let onDelete {
                        rowAction("xmark", "Discard message", onDelete)
                    }
                    if canEdit, let onEdit {
                        rowAction("square.and.pencil", "Edit message", onEdit)
                    }
                    if let onRetry {
                        rowAction("arrow.clockwise", "Try again", onRetry)
                    }
                    if let onSteer {
                        rowAction("arrow.up", "Steer into this run", onSteer)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(alignment: .top) {
                if showsDivider {
                    Rectangle()
                        .fill(OS1VisualStyle.border.opacity(0.6))
                        .frame(height: 0.5)
                        // Inset to the text column, the way a list separator
                        // clears its row's leading icon.
                        .padding(.leading, 34)
                }
            }
            // No whole-row tap: with an edit button right there, a stray tap
            // on a message opening a modal is a trap, not a shortcut. The long
            // press repeats the row's actions and adds reordering.
            .contentShape(Rectangle())
            .contextMenu { rowActions }
        }

        /// One control in the row's trailing cluster. 32pt of hit area around
        /// a 13pt glyph — the most a flap row can give without pushing the
        /// message into a column too narrow to read.
        private func rowAction(
            _ symbol: String,
            _ label: String,
            _ action: @escaping () -> Void
        ) -> some View {
            Button(action: action) {
                Image(systemName: symbol)
                    .font(.system(size: 13, weight: .medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .frame(width: 32, height: 32)
                    .contentShape(Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(label)
        }

        @ViewBuilder
        private var rowActions: some View {
            if canEdit, let onEdit {
                Button("Edit", systemImage: "square.and.pencil", action: onEdit)
            }
            if let onSteer {
                Button("Steer into this run", systemImage: "arrow.up", action: onSteer)
            }
            if let onMove {
                Button("Move up", systemImage: "arrow.up.to.line") { onMove(-1) }
                Button("Move down", systemImage: "arrow.down.to.line") { onMove(1) }
            }
            if let onRetry {
                Button("Try again", systemImage: "arrow.clockwise", action: onRetry)
            }
            if let onDelete {
                Button(role: .destructive, action: onDelete) {
                    Label("Discard", systemImage: "trash")
                }
            }
        }
    }
}

/// Rewrite a message that's still waiting in the server's queue.
///
/// Edited in place rather than pulled back into the composer the way the web
/// does it: the phone's composer usually holds a half-typed draft of its own,
/// and a delete-then-resend would both lose the message's place in the queue
/// and leave a window — one backgrounded app away — where it exists nowhere
/// but a text field.
private struct QueuedMessageEditor: View {
    let onSave: (String) -> Void
    let onDelete: () -> Void

    @State private var text: String
    @FocusState private var focused: Bool
    @Environment(\.dismiss) private var dismiss

    init(
        initial: String,
        onSave: @escaping (String) -> Void,
        onDelete: @escaping () -> Void
    ) {
        _text = State(initialValue: initial)
        self.onSave = onSave
        self.onDelete = onDelete
    }

    private var trimmed: String {
        text.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Edit queued message")
                .font(.headline)
            Text("It keeps its place in the queue.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            TextField("Message", text: $text, axis: .vertical)
                .lineLimit(3...10)
                .textFieldStyle(.roundedBorder)
                .focused($focused)

            HStack {
                Button("Discard message", role: .destructive) {
                    onDelete()
                    dismiss()
                }
                Spacer()
                Button("Cancel") { dismiss() }
                Button("Save") {
                    onSave(trimmed)
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(trimmed.isEmpty)
            }
        }
        .padding(20)
        .frame(minWidth: 320)
        #if os(iOS)
        .presentationDetents([.medium])
        #endif
        .onAppear { focused = true }
    }
}
