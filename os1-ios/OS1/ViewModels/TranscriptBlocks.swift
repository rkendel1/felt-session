import Foundation

/// One rendered unit of the transcript. The flat entry list groups into these
/// the way the web viewer's `TranscriptBlocks` does: a turn's tool calls (and
/// the prose between them) collapse into one fold, the turn's FINAL answer
/// escapes that fold and reads as a normal message, and a metadata footer
/// closes a settled turn.
///
/// The point of the shape is the reading rhythm it produces:
/// question → [work] → answer → meta.
enum TranscriptBlock: Identifiable, Equatable {
    /// A standalone message: a prompt, a system notice, or a turn's answer.
    case message(TranscriptEntry)
    /// A lone tool call outside any turn (an orphan result after a reload).
    case tool(ToolCallItem)
    /// The collapsible work fold.
    case work(WorkTurn)
    /// Duration / model / touched files under a settled answer.
    case footer(TurnFooter)
    /// The agent-published walkthrough, at the point it was published.
    case walkthrough(SessionWalkthrough)

    var id: String {
        switch self {
        case .message(let entry): entry.id
        case .tool(let item): item.id
        case .work(let turn): turn.id
        case .footer(let footer): footer.id
        case .walkthrough(let walkthrough): "walkthrough:\(walkthrough.publishedAt)"
        }
    }

    /// Where a scroll restore should land. A turn keys on its FIRST item so
    /// its identity is stable while it grows, but anchors on its LAST — a
    /// history page can merge older entries into the topmost turn, which
    /// moves the first item without moving the last.
    var anchorId: String {
        if case .work(let turn) = self { return turn.anchorId }
        return id
    }

    /// Every transcript entry this block renders, for anchor resolution.
    var entryIds: [String] {
        switch self {
        case .message(let entry): [entry.id]
        case .tool(let item): [item.use?.id, item.result?.id].compactMap { $0 }
        case .work(let turn): turn.items.flatMap(\.entryIds)
        case .footer(let footer): [footer.entryId]
        // A walkthrough is not a transcript entry, so it can never be a
        // scroll anchor.
        case .walkthrough: []
        }
    }
}

/// One tool call merged with its result, plus the identity/summary the row
/// draws. The presentation is built during the display pass so no view body
/// ever parses tool input.
struct ToolCallItem: Identifiable, Equatable {
    var id: String
    var use: TranscriptEntry?
    var result: TranscriptEntry?
    /// Only a stream entry is eligible for the "expand while running" mode; a
    /// reloaded transcript can hold old uses with no persisted result.
    var isLive: Bool
    var presentation: ToolPresentation

    var isError: Bool { use?.isError == true || result?.isError == true }
    var isPending: Bool { result == nil && use != nil }
    var mediaSources: [String] { result?.images ?? [] }
    var hasMedia: Bool { !mediaSources.isEmpty }

    /// The worker this Task call spawned, when it announced one — the key
    /// that opens its transcript. The engine reports it either as the
    /// result's `agentId` or inside the result body as `<task id="ses_…">`.
    var subagentId: String? {
        guard presentation.family == .agent else { return nil }
        if let id = result?.agentId ?? use?.agentId, !id.isEmpty { return id }
        guard let text = result?.text,
              let range = text.range(
                  of: "<task id=\"ses_[A-Za-z0-9]+\"",
                  options: .regularExpression
              ),
              let idRange = text[range].range(
                  of: "ses_[A-Za-z0-9]+",
                  options: .regularExpression
              )
        else { return nil }
        return String(text[range][idRange])
    }
}

enum TurnItem: Identifiable, Equatable {
    /// Intermediate assistant prose — narration between tool calls.
    case message(TranscriptEntry)
    case tool(ToolCallItem)

    var id: String {
        switch self {
        case .message(let entry): entry.id
        case .tool(let item): item.id
        }
    }

    var entryIds: [String] {
        switch self {
        case .message(let entry): [entry.id]
        case .tool(let item): [item.use?.id, item.result?.id].compactMap { $0 }
        }
    }
}

/// The collapsed work of one turn, pre-summarized so the header renders
/// without touching the items.
struct WorkTurn: Identifiable, Equatable {
    var id: String
    var anchorId: String
    var items: [TurnItem]
    /// The turn is still producing output — the header says "Working".
    var isLive: Bool
    var duration: TimeInterval?
    /// Distinct tool families in first-use order: the fold's fingerprint.
    var families: [ToolFamily]
    var toolCount: Int
    var failureCount: Int
    var touchedFiles: [TouchedFile]
    var lineStats: ToolLineStats
    /// A result carried an image — the fold opens so it isn't hidden.
    var hasMedia: Bool
    /// "Bash: bun test" — what the fold is doing right now, shown while it is
    /// live and collapsed so the work never looks stalled.
    var livePreview: String?

    var hasFailure: Bool { failureCount > 0 }

    /// A fold this long is a wall on a phone. Media and failures still pull a
    /// short turn open — that's how you see a screenshot or a stack trace
    /// without hunting — but past this many steps the header's own signals
    /// (the failure count, the edited files) carry it instead, and opening
    /// stays the reader's choice.
    private static let pinOpenStepLimit = 8

    /// How the fold should start out, before any manual toggle.
    func defaultExpanded(preference: String) -> Bool {
        if hasMedia || hasFailure, toolCount <= Self.pinOpenStepLimit { return true }
        switch preference {
        case "expanded": return true
        case "auto": return isLive
        default: return false
        }
    }
}

/// The metadata row under a settled turn's answer.
struct TurnFooter: Identifiable, Equatable {
    var id: String
    var entryId: String
    /// Raw markdown of the answer, for "Copy message".
    var text: String
    var timestamp: Date?
    /// Per-message model, when the server recorded one.
    var model: String?
    var duration: TimeInterval?
    var files: [TouchedFile]

    var isEmpty: Bool {
        duration == nil && model == nil && files.isEmpty
    }
}

// MARK: - Grouping

@MainActor
enum TranscriptGrouping {
    /// Merge each `tool_use` with its `tool_result` (matched on `toolUseId`,
    /// or the server's `tr-<id>` convention) into one item; orphan results
    /// stay standalone. The transcript FILE is the order authority, so this
    /// preserves the order it was given.
    ///
    /// Shared with the sub-agent viewer, which renders a worker's transcript
    /// through exactly the same pipeline as the main session.
    static func displayItems(
        from all: [TranscriptEntry],
        liveIds: Set<String> = []
    ) -> [SessionViewModel.DisplayItem] {
        var resultByUseId: [String: TranscriptEntry] = [:]
        for entry in all where entry.type == "tool_result" {
            let key = entry.toolUseId ?? String(entry.id.dropFirst("tr-".count))
            if resultByUseId[key] == nil { resultByUseId[key] = entry }
        }
        let useIds = Set(
            all.filter { $0.type == "tool_use" }.map { $0.toolUseId ?? $0.id }
        )
        var items: [SessionViewModel.DisplayItem] = []
        for entry in all {
            switch entry.type {
            case "tool_use":
                let key = entry.toolUseId ?? entry.id
                items.append(.toolCall(
                    use: entry,
                    result: resultByUseId[key],
                    isLive: liveIds.contains(entry.id)
                ))
            case "tool_result":
                // Only orphans render standalone — a result whose use exists
                // anywhere in the transcript is folded into that item.
                let key = entry.toolUseId ?? String(entry.id.dropFirst("tr-".count))
                if !useIds.contains(key) {
                    items.append(.entry(entry))
                }
            default:
                items.append(.entry(entry))
            }
        }
        return items
    }

    /// Fold the flat display list into blocks. Pure and O(n) — it runs in the
    /// view model's rebuild pass, never in a view body.
    ///
    /// `live` marks the session as still running, which keeps the trailing
    /// turn labelled "Working" and suppresses its footer (a turn that hasn't
    /// finished has no duration worth showing).
    static func blocks(
        from items: [SessionViewModel.DisplayItem],
        live: Bool,
        worktreeDir: String?,
        walkthrough: SessionWalkthrough? = nil
    ) -> [TranscriptBlock] {
        var blocks: [TranscriptBlock] = []
        var turn: [TurnItem] = []

        func flush(isTrailing: Bool) {
            defer { turn = [] }
            guard !turn.isEmpty else { return }
            let tools = turn.compactMap { item -> ToolCallItem? in
                if case .tool(let call) = item { return call }
                return nil
            }
            // No tools: nothing worth hiding, so every message stands alone.
            guard !tools.isEmpty else {
                blocks.append(contentsOf: turn.map { item in
                    switch item {
                    case .message(let entry): TranscriptBlock.message(entry)
                    case .tool(let call): TranscriptBlock.tool(call)
                    }
                })
                return
            }
            // The answer is the last item only when it is prose; a turn that
            // ended mid-tools folds entirely.
            var final: TranscriptEntry?
            if case .message(let entry)? = turn.last { final = entry }
            let folded = final == nil ? turn : Array(turn.dropLast())
            let isLive = live && isTrailing

            if let first = folded.first, let last = folded.last {
                blocks.append(.work(makeTurn(
                    items: folded,
                    firstId: first.id,
                    lastId: last.id,
                    tools: tools.filter { call in folded.contains { $0.id == call.id } },
                    isLive: isLive
                )))
            }
            guard let final else { return }
            blocks.append(.message(final))
            // A running turn's footer would show a duration that is still
            // ticking; wait for it to settle.
            guard !isLive else { return }
            let start = turn.first.flatMap(startTimestamp)
            let end = final.timestampDate
            let footer = TurnFooter(
                id: "\(final.id):footer",
                entryId: final.id,
                text: final.text,
                timestamp: end,
                model: final.model,
                duration: duration(from: start, to: end),
                files: mergeTouchedFiles(tools)
            )
            if !footer.isEmpty { blocks.append(.footer(footer)) }
        }

        for (index, item) in items.enumerated() {
            let isLast = index == items.count - 1
            switch item {
            case .toolCall(let use, let result, let isLive):
                turn.append(.tool(ToolCallItem(
                    id: "tool-\(use.id)",
                    use: use,
                    result: result,
                    isLive: isLive,
                    presentation: ToolPresentation.make(
                        toolName: use.toolName,
                        input: use.toolInput,
                        worktreeDir: worktreeDir
                    )
                )))
            case .entry(let entry) where entry.isAssistant:
                turn.append(.message(entry))
            case .entry(let entry) where entry.isTool:
                // Orphan tool_result — same compact treatment inside the fold.
                turn.append(.tool(ToolCallItem(
                    id: "tool-\(entry.id)",
                    use: nil,
                    result: entry,
                    isLive: false,
                    presentation: ToolPresentation.make(
                        toolName: entry.toolName,
                        input: entry.toolInput,
                        worktreeDir: worktreeDir
                    )
                )))
            case .entry(let entry):
                flush(isTrailing: false)
                blocks.append(.message(entry))
            }
            if isLast { flush(isTrailing: true) }
        }
        return place(walkthrough, into: blocks)
    }

    /// Drop the walkthrough card straight after the turn that published it —
    /// that's where the reader was when it appeared, and it reads as the
    /// result of that work rather than a floating attachment. When the
    /// publishing call has been trimmed out of the loaded window, fall back to
    /// its publish time, and to the end of the transcript if even that is
    /// unusable.
    private static func place(
        _ walkthrough: SessionWalkthrough?, into blocks: [TranscriptBlock]
    ) -> [TranscriptBlock] {
        guard let walkthrough else { return blocks }
        var out = blocks
        if let publishing = blocks.lastIndex(where: publishesWalkthrough) {
            // Past the turn's answer and footer, not straight after the fold:
            // the card summarizes the work, so splitting the turn from the
            // reply it ended with would read as an interruption.
            var at = publishing + 1
            if at < blocks.count, case .message = blocks[at] { at += 1 }
            if at < blocks.count, case .footer = blocks[at] { at += 1 }
            out.insert(.walkthrough(walkthrough), at: at)
            return out
        }
        guard let published = walkthrough.publishedDate else {
            out.append(.walkthrough(walkthrough))
            return out
        }
        let after = blocks.firstIndex { (blockTime($0) ?? .distantPast) > published }
        out.insert(.walkthrough(walkthrough), at: after ?? blocks.count)
        return out
    }

    /// Whether this block contains the `publish_walkthrough` tool call, under
    /// whatever name the engine gave it (`opensession-walkthrough_publish…`,
    /// `mcp__…__publish_walkthrough`).
    private static func publishesWalkthrough(_ block: TranscriptBlock) -> Bool {
        func isPublish(_ item: ToolCallItem) -> Bool {
            let name = item.use?.toolName ?? item.presentation.canonical
            return name.hasSuffix("publish_walkthrough")
        }
        switch block {
        case .tool(let item): return isPublish(item)
        case .work(let turn):
            return turn.items.contains { item in
                if case .tool(let call) = item { return isPublish(call) }
                return false
            }
        default: return false
        }
    }

    private static func blockTime(_ block: TranscriptBlock) -> Date? {
        switch block {
        case .message(let entry): entry.timestampDate
        case .tool(let item): (item.result ?? item.use)?.timestampDate
        case .work(let turn): turn.items.last.flatMap(endTimestamp)
        case .footer(let footer): footer.timestamp
        case .walkthrough(let walkthrough): walkthrough.publishedDate
        }
    }

    private static func makeTurn(
        items: [TurnItem],
        firstId: String,
        lastId: String,
        tools: [ToolCallItem],
        isLive: Bool
    ) -> WorkTurn {
        var families: [ToolFamily] = []
        for tool in tools where !families.contains(tool.presentation.family) {
            families.append(tool.presentation.family)
        }
        let files = mergeTouchedFiles(tools)
        let stats = files.reduce(into: ToolLineStats()) {
            $0 = $0 + ToolLineStats(additions: $1.additions, deletions: $1.deletions)
        }
        let start = items.first.flatMap(startTimestamp)
        let end = items.last.flatMap(endTimestamp)
        var preview: String?
        if isLive, let last = tools.last {
            let summary = last.presentation.summary
            preview = summary.isEmpty
                ? last.presentation.displayName
                : "\(last.presentation.displayName): \(summary)"
        }
        return WorkTurn(
            id: firstId,
            anchorId: lastId,
            items: items,
            isLive: isLive,
            duration: isLive ? nil : duration(from: start, to: end),
            families: Array(families.prefix(6)),
            toolCount: tools.count,
            failureCount: tools.filter(\.isError).count,
            touchedFiles: files,
            lineStats: stats,
            hasMedia: tools.contains(where: \.hasMedia),
            livePreview: preview
        )
    }

    /// Same path touched twice keeps its first position and sums its counts.
    private static func mergeTouchedFiles(_ tools: [ToolCallItem]) -> [TouchedFile] {
        var order: [String] = []
        var merged: [String: TouchedFile] = [:]
        for file in tools.flatMap(\.presentation.touchedFiles) {
            if var existing = merged[file.path] {
                existing.additions += file.additions
                existing.deletions += file.deletions
                existing.hunks += file.hunks
                merged[file.path] = existing
            } else {
                order.append(file.path)
                merged[file.path] = file
            }
        }
        return order.compactMap { merged[$0] }
    }

    private static func startTimestamp(_ item: TurnItem) -> Date? {
        switch item {
        case .message(let entry): entry.timestampDate
        case .tool(let call): (call.use ?? call.result)?.timestampDate
        }
    }

    private static func endTimestamp(_ item: TurnItem) -> Date? {
        switch item {
        case .message(let entry): entry.timestampDate
        case .tool(let call): (call.result ?? call.use)?.timestampDate
        }
    }

    private static func duration(from start: Date?, to end: Date?) -> TimeInterval? {
        guard let start, let end else { return nil }
        let elapsed = end.timeIntervalSince(start)
        return elapsed >= 1 ? elapsed : nil
    }
}

/// Fold open/closed, held per turn OUTSIDE the view tree.
///
/// A `@State` flag inside a `LazyVStack` row is destroyed the moment the row
/// scrolls out of the realization window, so a fold the reader deliberately
/// opened silently snaps shut when they scroll back. One small observable
/// object per turn keeps the state alive and keeps invalidation scoped: a
/// toggle re-evaluates that fold's body, not every visible fold (which is
/// what a single dictionary on the view model would do).
@Observable
@MainActor
final class TurnFoldState {
    var expanded: Bool
    /// Once the human decides, later default changes stop overriding them.
    private(set) var userToggled = false

    init(expanded: Bool) {
        self.expanded = expanded
    }

    func toggle() {
        userToggled = true
        expanded.toggle()
    }

    /// Re-apply a computed default (preference change, a failure landing in a
    /// live turn) unless the human has taken control of this fold.
    func syncDefault(_ value: Bool) {
        guard !userToggled, expanded != value else { return }
        expanded = value
    }
}

/// Every fold's state for one transcript, keyed by block id.
///
/// Deliberately NOT observable: reading the map must not subscribe a row to
/// every other row's expansion. The individual `TurnFoldState` objects it
/// hands out are observable, so a toggle invalidates exactly one fold.
@MainActor
final class FoldStateStore {
    private var states: [String: TurnFoldState] = [:]

    /// The open/closed state for one work fold, created on first sight with
    /// the preference-derived default and reused forever after.
    func fold(for turn: WorkTurn, preference: String) -> TurnFoldState {
        let fallback = turn.defaultExpanded(preference: preference)
        if let existing = states[turn.id] {
            // Only the live tail may re-derive its default afterwards; a
            // settled fold above the reader must never change height on its
            // own (see the transcript's scroll notes in SessionView).
            if turn.isLive { existing.syncDefault(fallback) }
            return existing
        }
        let state = TurnFoldState(expanded: fallback)
        states[turn.id] = state
        return state
    }

    /// Expansion for anything else that folds inside a row — a tool call's
    /// detail, a clamped message's body, a long system notice.
    func expansion(id: String, defaultExpanded: Bool = false) -> TurnFoldState {
        if let existing = states[id] { return existing }
        let state = TurnFoldState(expanded: defaultExpanded)
        states[id] = state
        return state
    }
}
