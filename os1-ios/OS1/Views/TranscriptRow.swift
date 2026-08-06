import SwiftUI

/// Renders one transcript block: prompts as right-aligned bubbles, answers as
/// plain left-aligned markdown, a turn's work as a collapsible fold, and
/// system events as centered pills toned by severity.
struct TranscriptRow: View {
    let block: TranscriptBlock
    let sessionId: String
    /// Repo root for tidying paths inside nested views (the sub-agent sheet).
    var worktreeDir: String?
    /// Resolves fold/expansion state that has to outlive the row scrolling
    /// out of the lazy stack.
    let foldState: (WorkTurn) -> TurnFoldState
    let expansionState: (String) -> TurnFoldState

    var body: some View {
        switch block {
        case .message(let entry):
            if entry.isUser {
                UserBubble(entry: entry, sessionId: sessionId)
            } else if entry.isAssistant {
                AssistantMessage(
                    entry: entry,
                    sessionId: sessionId,
                    state: expansionState("body-\(entry.id)")
                )
            } else {
                SystemNoticeRow(entry: entry, state: expansionState("notice-\(entry.id)"))
            }
        case .tool(let item):
            ToolCallRow(
                item: item,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: expansionState(item.id)
            )
        case .work(let turn):
            TurnBlockView(
                turn: turn,
                sessionId: sessionId,
                worktreeDir: worktreeDir,
                state: foldState(turn),
                detailState: { expansionState($0.id) }
            )
        case .footer(let footer):
            TurnFooterView(footer: footer)
        case .walkthrough(let walkthrough):
            WalkthroughCard(walkthrough: walkthrough)
        }
    }
}

// MARK: - Messages

/// The person's own message. No name label — the right alignment already
/// says who wrote it.
struct UserBubble: View {
    let entry: TranscriptEntry
    let sessionId: String

    var body: some View {
        HStack(alignment: .bottom, spacing: 8) {
            Spacer(minLength: 40)
            VStack(alignment: .trailing, spacing: 6) {
                ConversationImageRow(sources: entry.images ?? [], sessionId: sessionId)
                if !entry.text.isEmpty {
                    Text(entry.text)
                        .font(.body)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .foregroundStyle(OS1VisualStyle.text)
                        .userMessagePanelCompat(
                            in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                        )
                        .overlay {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .stroke(OS1VisualStyle.border, lineWidth: 0.5)
                        }
                        .textSelection(.enabled)
                        .contextMenu {
                            Button {
                                copyToPasteboard(entry.text)
                            } label: {
                                Label("Copy message", systemImage: "doc.on.doc")
                            }
                            TimestampLabel(date: entry.timestampDate)
                        }
                }
            }
            .frame(maxWidth: userMessageMaxWidth, alignment: .trailing)
        }
        .frame(maxWidth: .infinity, alignment: .trailing)
    }

    private var userMessageMaxWidth: CGFloat {
        #if os(macOS)
        520
        #else
        .infinity
        #endif
    }
}

/// The agent's answer renders plain — no bubble, the shape modern AI chat
/// apps converge on, since only the person's own messages need containing.
struct AssistantMessage: View {
    let entry: TranscriptEntry
    let sessionId: String
    let state: TurnFoldState

    /// Markdown parsing is superlinear, so only this much is parsed up front;
    /// the rest waits behind an explicit tap. Phones are the constrained end
    /// of this — a 200 KB answer would otherwise block the main thread on
    /// every re-render.
    private static let eagerCharacters = 6_000
    /// Past this the expanded body renders as preformatted text: markdown at
    /// that size costs more than it adds.
    private static let markdownCeiling = 32 * 1024

    @State private var fullText: String?
    @State private var loadingFull = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            ConversationImageRow(sources: entry.images ?? [], sessionId: sessionId)
            if !entry.text.isEmpty || state.expanded {
                bodyContent
            }
            if let label = expanderLabel {
                Button {
                    expand()
                } label: {
                    HStack(spacing: 5) {
                        if loadingFull {
                            ProgressView().controlSize(.mini)
                        }
                        Text(loadingFull ? "Loading…" : label)
                    }
                    .font(.footnote.weight(.medium))
                }
                .buttonStyle(.plain)
                .foregroundStyle(OS1VisualStyle.link)
                .padding(.top, 2)
            }
        }
        .padding(.vertical, 2)
        .padding(.trailing, 24)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contextMenu {
            Button {
                copyToPasteboard(fullText ?? entry.text)
            } label: {
                Label("Copy message", systemImage: "doc.on.doc")
            }
            TimestampLabel(date: entry.timestampDate)
            if let model = entry.model, !model.isEmpty {
                Label(
                    "Written by \(TranscriptFormat.modelLabel(model))",
                    systemImage: "sparkles"
                )
            }
        }
    }

    @ViewBuilder
    private var bodyContent: some View {
        let text = visibleText
        if state.expanded, text.count > Self.markdownCeiling {
            // Preformatted, and scrollable in its own right: an enormous
            // answer should not stretch the transcript to its full height.
            ScrollView {
                Text(text)
                    .font(.system(.footnote, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .frame(maxHeight: 520)
        } else {
            MarkdownBody(text)
        }
    }

    /// What's on screen right now: the whole message when it fits or has been
    /// expanded, otherwise a head cut at a line boundary so the preview never
    /// ends mid-word.
    private var visibleText: String {
        let text = fullText ?? entry.text
        guard !state.expanded, text.count > Self.eagerCharacters else { return text }
        let head = text.prefix(Self.eagerCharacters)
        if let lastBreak = head.lastIndex(of: "\n"), lastBreak > head.startIndex {
            return String(head[head.startIndex..<lastBreak])
        }
        return String(head)
    }

    private var isClamped: Bool {
        entry.contentClamped == true && fullText == nil
    }

    private var expanderLabel: String? {
        if state.expanded, !isClamped { return "Collapse" }
        let known = entry.contentLength ?? (fullText ?? entry.text).count
        guard isClamped || known > Self.eagerCharacters else { return nil }
        return "Show full message · \(TranscriptFormat.size(known))"
    }

    private func expand() {
        if state.expanded {
            state.toggle()
            return
        }
        // A wire-clamped entry only carries a head; the rest lives on the
        // server and is fetched the first time someone asks for it.
        guard isClamped else {
            state.toggle()
            return
        }
        guard !loadingFull else { return }
        loadingFull = true
        Task {
            fullText = try? await OS1API.fullEntryContent(
                sessionId: sessionId,
                entryId: entry.id
            )
            loadingFull = false
            state.expanded = true
        }
    }
}

/// Timestamps have no hover home on a phone, so they live in the menu.
private struct TimestampLabel: View {
    let date: Date?

    var body: some View {
        if let date {
            Label(
                date.formatted(date: .abbreviated, time: .shortened),
                systemImage: "clock"
            )
        }
    }
}

private struct ConversationImageRow: View {
    let sources: [String]
    let sessionId: String

    var body: some View {
        if !sources.isEmpty {
            HStack(spacing: 6) {
                ForEach(Array(sources.enumerated()), id: \.offset) { _, source in
                    ConversationImage(source: source, sessionId: sessionId)
                        .frame(width: 96, height: 96)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
            }
        }
    }
}

// MARK: - System notices

/// System events as a centered pill. Severity is carried by tone rather than
/// by more text: a failure that reads identically to "model changed" is a
/// failure nobody notices.
struct SystemNoticeRow: View {
    let entry: TranscriptEntry
    let state: TurnFoldState

    /// Longer than this and the pill folds — a multi-paragraph restart
    /// explanation should not push the conversation off the screen.
    private static let foldThreshold = 220

    private var tone: NoticeTone { NoticeTone.of(entry) }
    private var isFoldable: Bool { entry.text.count > Self.foldThreshold }

    var body: some View {
        VStack(spacing: 6) {
            HStack(alignment: .firstTextBaseline, spacing: 5) {
                if let symbol = tone.symbol {
                    Image(systemName: symbol)
                        .font(.caption2)
                }
                Text(headline)
                    .lineLimit(isFoldable && !state.expanded ? 2 : nil)
                if isFoldable {
                    Text(state.expanded ? "hide" : "show")
                        .foregroundStyle(OS1VisualStyle.link)
                }
            }
            .font(.footnote)
            .foregroundStyle(tone.color)
            .multilineTextAlignment(isFoldable ? .leading : .center)

            if isFoldable, state.expanded {
                Text(entry.text)
                    .font(.footnote)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 7)
        .frame(maxWidth: 520)
        .background(
            tone.background,
            in: RoundedRectangle(cornerRadius: 12, style: .continuous)
        )
        .frame(maxWidth: .infinity)
        .contentShape(Rectangle())
        .onTapGesture {
            guard isFoldable else { return }
            withAnimation(.snappy(duration: 0.2, extraBounce: 0)) { state.toggle() }
        }
        .accessibilityAddTraits(tone == .error ? .isStaticText : [])
    }

    /// Folded notices show their first line — server notices lead with the
    /// headline and explain underneath.
    private var headline: String {
        guard isFoldable, !state.expanded else { return entry.text }
        return entry.text
            .components(separatedBy: "\n")
            .first?
            .trimmingCharacters(in: .whitespaces) ?? entry.text
    }
}

enum NoticeTone: Equatable {
    case info, warn, error

    static func of(_ entry: TranscriptEntry) -> NoticeTone {
        if entry.isError == true { return .error }
        let text = entry.text.lowercased()
        for marker in ["failed", "failure", "error", "denied", "crashed", "could not"]
        where text.contains(marker) {
            return .error
        }
        for marker in [
            "warning", "interrupted", "timed out", "timeout", "stopped",
            "cancelled", "canceled", "restart", "compacted", "retry",
        ] where text.contains(marker) {
            return .warn
        }
        return .info
    }

    var color: Color {
        switch self {
        case .info: OS1VisualStyle.textDim
        case .warn: OS1VisualStyle.yellow
        case .error: OS1VisualStyle.red
        }
    }

    var symbol: String? {
        switch self {
        case .info: nil
        case .warn: "exclamationmark.triangle"
        case .error: "exclamationmark.octagon"
        }
    }

    var background: Color {
        switch self {
        case .info: OS1VisualStyle.panel.opacity(0.6)
        case .warn: OS1VisualStyle.yellow.opacity(0.12)
        case .error: OS1VisualStyle.red.opacity(0.12)
        }
    }
}

// MARK: - Streaming

/// Assistant text streaming in over `stream_text` frames, before the durable
/// transcript entry exists. Only rendered once text is available.
struct StreamingBubble: View {
    let text: String

    var body: some View {
        StreamingMarkdownBody(text)
            .padding(.vertical, 2)
            .padding(.trailing, 24)
            .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// Ticking elapsed-run clock ("8.3s", "2m 14s", "1h 5m") — the web viewer's
/// BusyElapsed format. Falls back to "Running" with no anchor.
struct RunElapsedLabel: View {
    let since: Date?

    var body: some View {
        if let since {
            TimelineView(.periodic(from: .now, by: 0.1)) { context in
                Text(label(elapsed: context.date.timeIntervalSince(since)))
                    .monospacedDigit()
            }
        } else {
            Text("Running")
        }
    }

    private func label(elapsed: TimeInterval) -> String {
        let s = max(0, elapsed)
        if s < 60 { return String(format: "%.1fs", s) }
        let total = Int(s)
        if total < 3600 { return "\(total / 60)m \(total % 60)s" }
        return "\(total / 3600)h \((total % 3600) / 60)m"
    }
}
