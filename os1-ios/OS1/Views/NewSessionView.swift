import SwiftUI

/// Compose a new session, laid out like the palette on the desktop: what the
/// session IS — the repo, and what it's created from — reads across the top,
/// the prompt fills the middle, and how it runs sits in the footer with the
/// attach button. Only the controls this app actually carries appear; the rest
/// of the palette's row (plan mode, connected services, run environment) has
/// no native equivalent yet, so it stays absent rather than half-present.
/// Screenshots paste straight into the attachments (Cmd+V on the Mac,
/// long-press Paste on iOS).
///
/// The prompt lives in a plain `TextEditor` inside a custom layout (not a
/// grouped Form): Form re-diffs every row on each keystroke, which is what
/// made typing lag in the old sheet.
struct NewSessionView: View {
    @Environment(\.dismiss) private var dismiss

    /// Preset repo (the per-repo "+" in the sessions list); nil = remembered.
    var initialRepo: String?

    /// Workspace this session joins as a new tab (the session's ⋯ → "New
    /// session in this workspace"); nil starts a standalone session in its own
    /// workspace.
    var initialWorkspaceId: String?

    /// Called the moment Start is tapped, with an optimistic session row
    /// (temporary `pending-` id) plus the prompt/images to seed the
    /// conversation view instantly.
    let onCreated: (Session, SessionViewModel.OptimisticSeed) -> Void

    /// Called when the background create finishes: the temp id and either
    /// the server's real session id or the error to surface.
    let onResolved: (String, Result<String, Error>) -> Void

    @State private var prompt = ""
    @State private var mode = "code"
    @State private var repos: [OS1API.RepoInfo] = []
    @State private var repo = ""
    @State private var catalog: ModelCatalog?
    @State private var model = ""
    @State private var effort = ""
    @State private var fastMode = false
    @State private var images: [AttachedImage] = []
    @FocusState private var promptFocused: Bool

    /// The universal "+" reopens on whatever repo was used last.
    @AppStorage("os1.newSession.repo") private var lastRepo = ""
    @AppStorage("os1.composer.defaultModel") private var preferredModel = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                header
                editor
                if !images.isEmpty {
                    AttachedImagesRow(images: images) { image in
                        images.removeAll { $0.id == image.id }
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 6)
                }
                Divider()
                controls
            }
            .background(OS1VisualStyle.background)
            .navigationTitle("New session")
            .inlineTitleBarCompat()
            #if os(macOS)
            .frame(minWidth: 560, minHeight: 440)
            #endif
            .toolbar {
                #if os(iOS)
                // Both ends draw their own circle, so both hide the toolbar's
                // glass: a capsule around the send disc read as a white ring on
                // the black accent, and the ✕'s glass — white on a white sheet —
                // was nearly invisible next to it. Hiding it on one side only
                // also cost 4pt of symmetry: iOS insets a glass item and a bare
                // one differently.
                ToolbarItem(placement: .confirmationAction) { startButton }
                    .sharedBackgroundVisibility(.hidden)
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                    .sharedBackgroundVisibility(.hidden)
                #else
                ToolbarItem(placement: .confirmationAction) { startButton }
                ToolbarItem(placement: .cancellationAction) { cancelButton }
                #endif
            }
            .task { await load() }
        }
    }

    // ── Prompt editor ─────────────────────────────────────────────────────

    private var startDisabled: Bool {
        prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && images.isEmpty
    }

    /// Starting a session is the same gesture as sending a message, so on iOS
    /// it wears the composer's send disc rather than the word "Start", with the
    /// ✕ that dismisses the sheet as its pair. The Mac keeps text buttons — a
    /// bare glyph in a sheet toolbar reads as unfinished there.
    @ViewBuilder
    private var startButton: some View {
        #if os(iOS)
        Button { create() } label: {
            Image(systemName: "arrow.up")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(
                    startDisabled ? OS1VisualStyle.textDim : OS1VisualStyle.onAccent
                )
                // 44pt, not the composer's 32: this disc replaces a toolbar
                // item's own glass circle, and iOS draws that at 44 — the ✕
                // across the bar measures exactly that. At 32 the pair read as
                // two different kinds of control, and the primary action was
                // the one below the tap-target floor.
                .frame(width: 44, height: 44)
                .background(
                    startDisabled
                        ? AnyShapeStyle(OS1VisualStyle.hover)
                        : AnyShapeStyle(OS1VisualStyle.accent),
                    in: Circle()
                )
        }
        .buttonStyle(.plain)
        .disabled(startDisabled)
        // A bare toolbar item sits 20pt off the edge; the sheet's own column —
        // the chips below, and the prompt under them — is 16. Pull both circles
        // onto it so the header has one left and one right edge.
        .padding(.trailing, -4)
        .keyboardShortcut(.return, modifiers: .command)
        .accessibilityLabel("Start session")
        #else
        Button("Start") { create() }
            .keyboardShortcut(.return, modifiers: .command)
            .disabled(startDisabled)
        #endif
    }

    @ViewBuilder
    private var cancelButton: some View {
        #if os(iOS)
        // The send disc's twin: same 44pt circle, same glyph size, and the
        // neutral fill the sheet's own chips wear. Only the role colour differs,
        // so the bar reads as a pair — a bare glyph opposite a solid accent disc
        // left the sheet lopsided.
        Button { dismiss() } label: {
            Image(systemName: "xmark")
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.text)
                .frame(width: 44, height: 44)
                .background(OS1VisualStyle.hover, in: Circle())
        }
        .buttonStyle(.plain)
        .padding(.leading, -4)
        .accessibilityLabel("Cancel")
        #else
        Button("Cancel") { dismiss() }
        #endif
    }

    private var editor: some View {
        ZStack(alignment: .topLeading) {
            TextEditor(text: $prompt)
                .font(.body)
                .scrollContentBackground(.hidden)
                .padding(.horizontal, 11)
                .padding(.top, 8)
                .focused($promptFocused)
                // Cmd+V with a copied screenshot attaches it; text pastes
                // flow through to the editor untouched.
                .pastesImages(into: $images)
            if prompt.isEmpty {
                Text("What should this session do?")
                    .font(.body)
                    .foregroundStyle(.tertiary)
                    .padding(.horizontal, 16)
                    .padding(.top, placeholderTopPadding)
                    .allowsHitTesting(false)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        #if os(iOS)
        .contentShape(Rectangle())
        .onTapGesture { promptFocused = true }
        #endif
    }

    /// Lines the placeholder up with the editor's real text origin: the outer
    /// padding plus the platform text view's own insets. UITextView adds an
    /// 8pt top container inset (8 outer + 8 = 16); NSTextView adds none.
    /// Horizontally both add 5pt fragment padding (11 outer + 5 = 16).
    private var placeholderTopPadding: CGFloat {
        #if os(macOS)
        8
        #else
        16
        #endif
    }

    // ── Header: what the session is ───────────────────────────────────────

    /// Repo left, what-it's-created-from right, as on the desktop. These two
    /// decide what the session can touch, so they sit above the prompt rather
    /// than among the run settings below it.
    private var header: some View {
        HStack(spacing: 8) {
            repoChip
            Spacer(minLength: 8)
            modeChip
        }
        // 16, the column the prompt below already uses (11 outer + the text
        // view's own 5pt fragment padding) and the toolbar circles now sit on.
        .padding(.horizontal, 16)
        .padding(.vertical, 8)
    }

    /// Sized off the chip's text rather than the tile's own default, so the
    /// icon reads as part of the label.
    private var repoTileSize: CGFloat {
        #if os(macOS)
        18
        #else
        16
        #endif
    }

    private var repoLabel: String {
        if let match = repos.first(where: { $0.id == repo }) {
            return match.label ?? match.id
        }
        return repo.isEmpty ? "No repository" : repo
    }

    private var repoChip: some View {
        Menu {
            ForEach(repos) { repoInfo in
                Button {
                    repo = repoInfo.id
                } label: {
                    Label {
                        Text(repoInfo.label ?? repoInfo.id)
                    } icon: {
                        // The checkmark takes the slot when it's the current
                        // repo — a menu row has one glyph, and which repo is
                        // selected outranks showing its icon twice (the chip
                        // above the menu already wears it).
                        if repo == repoInfo.id {
                            Image(systemName: "checkmark")
                        } else if let icon = RepoTile.cachedIcon(for: repoInfo.id) {
                            icon
                        }
                    }
                }
            }
        } label: {
            if repo.isEmpty {
                chipLabel(icon: "folder", text: repoLabel, strong: true)
            } else {
                chipLabel(text: repoLabel, strong: true) {
                    RepoTile(name: repo, size: repoTileSize)
                }
            }
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
        .disabled(repos.isEmpty)
    }

    /// Joining a workspace changes what code mode means: the session shares
    /// that workspace's worktree and branch rather than cutting a new one, so the
    /// chip says so instead of promising a branch it won't create.
    private var codeModeLabel: String {
        initialWorkspaceId == nil ? "New branch" : "Same branch"
    }

    /// The palette calls this "what to create from", and its two entries that
    /// exist here are a fresh branch (code) and Ask; the same words are used so
    /// the two screens describe one choice. Worktrees and scratch sessions have
    /// no native equivalent, so they aren't offered.
    private var modeChip: some View {
        Menu {
            Button {
                mode = "code"
            } label: {
                Label {
                    Text(codeModeLabel)
                    Text(
                        initialWorkspaceId == nil
                            ? "Isolated worktree, can open a PR"
                            : "Shares this workspace's worktree"
                    )
                } icon: {
                    if mode == "code" { Image(systemName: "checkmark") }
                }
            }
            Button {
                mode = "ask"
            } label: {
                Label {
                    Text("Ask")
                    Text("Read-only on the main checkout")
                } icon: {
                    if mode == "ask" { Image(systemName: "checkmark") }
                }
            }
        } label: {
            chipLabel(
                icon: mode == "code" ? "arrow.branch" : "text.magnifyingglass",
                text: mode == "code" ? codeModeLabel : "Ask"
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    // ── Footer: how it runs ───────────────────────────────────────────────

    private var selectedModelOption: ModelOption? {
        catalog?.option(for: model)
    }

    private var availableEfforts: [String] {
        selectedModelOption?.efforts ?? []
    }

    private var fastSupported: Bool {
        selectedModelOption?.fastModeSupported == true
    }

    private var modelChipText: String {
        let id = model.isEmpty ? catalog?.defaultModel : model
        #if os(iOS)
        if id == "dial/opus-fable" { return "Opus/Fable/Oracle" }
        #endif
        return catalog?.label(for: id) ?? "Model"
    }

    /// Attach on the left, model on the right — the palette's footer. iOS folds
    /// reasoning effort and fast mode into the model menu, so the row stays two
    /// controls wide and needs no sideways scrolling; the Mac has the width to
    /// show them as their own chips.
    private var controls: some View {
        HStack(spacing: 8) {
            AttachImagesButton(images: $images)
            Spacer(minLength: 8)
            #if os(macOS)
            if !availableEfforts.isEmpty { effortChip }
            if fastSupported { fastChip }
            #endif
            modelChip
        }
        .padding(.horizontal, 12)
        .padding(.vertical, controlsVerticalPadding)
    }

    /// The iOS attach button carries its own 44pt tap target, so the row only
    /// needs air on the Mac.
    private var controlsVerticalPadding: CGFloat {
        #if os(macOS)
        10
        #else
        4
        #endif
    }

    private var modelChip: some View {
        Menu {
            #if os(iOS)
            if !availableEfforts.isEmpty {
                Section("Reasoning") {
                    ForEach(availableEfforts, id: \.self) { level in
                        Button {
                            effort = level
                        } label: {
                            if effort == level {
                                Label(EffortLevel.label(level), systemImage: "checkmark")
                            } else {
                                Text(EffortLevel.label(level))
                            }
                        }
                    }
                }
            }
            if fastSupported {
                Button {
                    fastMode.toggle()
                } label: {
                    if fastMode {
                        Label("Fast mode", systemImage: "checkmark")
                    } else {
                        Text("Fast mode")
                    }
                }
            }
            #endif
            if let catalog {
                if !catalog.presets.isEmpty {
                    Section("Presets") {
                        ForEach(catalog.presets) { option in
                            modelButton(option)
                        }
                    }
                }
                Section(catalog.presets.isEmpty ? "Model" : "Models") {
                    ForEach(catalog.regular) { option in
                        modelButton(option)
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "cpu",
                text: modelChipText
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private func modelButton(_ option: ModelOption) -> some View {
        Button {
            selectModel(option)
        } label: {
            let selected = option.id == model
            if let subtitle = option.description, !subtitle.isEmpty {
                Label {
                    Text(option.displayLabel)
                    Text(subtitle)
                } icon: {
                    if selected { Image(systemName: "checkmark") }
                }
            } else if selected {
                Label(option.displayLabel, systemImage: "checkmark")
            } else {
                Text(option.displayLabel)
            }
        }
    }

    private var effortChip: some View {
        Menu {
            ForEach(availableEfforts, id: \.self) { level in
                Button {
                    effort = level
                } label: {
                    if effort == level {
                        Label(EffortLevel.label(level), systemImage: "checkmark")
                    } else {
                        Text(EffortLevel.label(level))
                    }
                }
            }
        } label: {
            chipLabel(
                icon: "gauge.with.needle",
                text: effort.isEmpty ? "Effort" : EffortLevel.label(effort)
            )
        }
        .menuStyle(.button)
        .buttonStyle(.plain)
    }

    private var fastChip: some View {
        Button {
            fastMode.toggle()
        } label: {
            chipLabel(icon: "bolt.fill", text: "Fast", highlighted: fastMode)
        }
        .buttonStyle(.plain)
    }

    /// `strong` is the repo's treatment: full-strength ink, as the desktop
    /// palette gives its repository trigger — the one choice on the screen you
    /// should be able to read without looking for it.
    private func chipLabel(
        icon: String, text: String, highlighted: Bool = false, strong: Bool = false
    ) -> some View {
        chipLabel(text: text, highlighted: highlighted, strong: strong) {
            Image(systemName: icon)
                #if os(iOS)
                .font(.caption2)
                #else
                .font(.caption)
                #endif
        }
    }

    /// Same chip with a view in the glyph's place, so the repo can wear its
    /// own icon rather than a folder standing in for it.
    private func chipLabel<Icon: View>(
        text: String,
        highlighted: Bool = false,
        strong: Bool = false,
        @ViewBuilder icon: () -> Icon
    ) -> some View {
        HStack(spacing: 5) {
            icon()
            Text(text)
                #if os(iOS)
                .font(.caption.weight(strong ? .medium : .regular))
                #else
                .font(.callout.weight(strong ? .medium : .regular))
                #endif
                .lineLimit(1)
        }
        .foregroundStyle(
            highlighted
                ? AnyShapeStyle(.tint)
                : (strong ? AnyShapeStyle(OS1VisualStyle.text) : AnyShapeStyle(.secondary))
        )
        #if os(iOS)
        .padding(.horizontal, 7)
        .padding(.vertical, 5)
        #else
        .padding(.horizontal, 10)
        .padding(.vertical, 6)
        #endif
        .background(
            highlighted ? AnyShapeStyle(.tint.opacity(0.15)) : AnyShapeStyle(.fill.tertiary),
            in: Capsule()
        )
        #if os(iOS)
        .frame(minHeight: 44)
        .contentShape(Rectangle())
        #else
        .contentShape(Capsule())
        #endif
    }

    // ── Data ──────────────────────────────────────────────────────────────

    private func load() async {
        promptFocused = true
        repo = initialRepo ?? lastRepo
        async let reposFetch = OS1API.repos()
        async let modelsFetch = OS1API.models()
        repos = (try? await reposFetch) ?? []
        if !repos.isEmpty, !repos.contains(where: { $0.id == repo }) {
            repo = repos.first(where: { $0.isDefault == true })?.id ?? repos[0].id
        }
        // The picker's rows can only show an icon the cache already holds, so
        // fetch them here rather than when the menu opens.
        for repoInfo in repos { RepoTile.prefetchIcon(for: repoInfo.id) }
        if let fetched = try? await modelsFetch {
            catalog = fetched
            let livePreferred = (try? await SettingsAPI.uiPrefs(
                user: ServerConfig.shared.userName
            ))?["default-model"] ?? preferredModel
            preferredModel = livePreferred
            if model.isEmpty {
                model = fetched.option(for: livePreferred) != nil
                    ? livePreferred
                    : (fetched.defaultModel ?? "")
            }
            defaultEffortForCurrentModel()
        }
    }

    private func selectModel(_ option: ModelOption) {
        model = option.id
        defaultEffortForCurrentModel()
        if !(option.fastModeSupported == true) { fastMode = false }
    }

    /// "High" is the palette's default where supported; presets (dial) have
    /// no effort dimension so the chip hides.
    private func defaultEffortForCurrentModel() {
        let efforts = availableEfforts
        if efforts.isEmpty {
            effort = ""
        } else if !efforts.contains(effort) {
            effort = efforts.contains("high") ? "high" : efforts[0]
        }
    }

    /// Optimistic create: the sheet closes immediately and the conversation
    /// opens seeded with the prompt under a temporary id, while the real
    /// create (worktree prep — seconds) runs in the background. The list
    /// swaps the temp id for the server's when it resolves.
    private func create() {
        let text = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        let imageURLs = images.map(\.dataURL)
        lastRepo = repo
        let pending = Session.optimistic(
            id: "pending-\(UUID().uuidString)",
            title: String((text.components(separatedBy: "\n").first ?? text).prefix(80)),
            repo: repo,
            mode: mode,
            model: model.isEmpty ? nil : model,
            effort: effort.isEmpty ? nil : effort,
            fastMode: fastMode,
            startedBy: ServerConfig.shared.userName,
            workspaceId: initialWorkspaceId
        )
        dismiss()
        onCreated(
            pending,
            SessionViewModel.OptimisticSeed(prompt: text, images: imageURLs)
        )
        Task {
            do {
                let id = try await OS1API.createSession(
                    prompt: text,
                    repo: repo,
                    mode: mode,
                    model: model.isEmpty ? nil : model,
                    effort: effort.isEmpty ? nil : effort,
                    fastMode: fastMode,
                    images: imageURLs,
                    workspaceId: initialWorkspaceId
                )
                onResolved(pending.id, .success(id))
            } catch {
                onResolved(pending.id, .failure(error))
            }
        }
    }
}
