import Foundation

/// One worker a session spawned through the Task tool, and its transcript.
///
/// The main session only ever shows the Task CALL — what the worker actually did
/// lives in its own transcript, which is why a `Task` row without a way in is
/// a dead end. Mirrors the server's `SubagentTranscript`
/// (`GET /api/sessions/:id/subagent/:agentId`); decoding is tolerant like
/// every other model here, so server additions never break older builds.
struct SubagentTranscript: Decodable, Sendable {
    struct Meta: Decodable, Sendable {
        var agentId: String?
        var agentType: String?
        var model: String?
        var description: String?
        var toolUseId: String?
        var spawnDepth: Int?
    }

    var meta: Meta?
    var entries: [TranscriptEntry]?
    var sessionRunning: Bool?

    /// What the sheet's title says: the worker's own description, else its
    /// type, else something honest rather than an empty bar.
    var title: String {
        if let description = meta?.description, !description.isEmpty {
            return description
        }
        if let type = meta?.agentType, !type.isEmpty { return type }
        return "Sub-agent"
    }

    var subtitle: String {
        var parts: [String] = []
        if let type = meta?.agentType, !type.isEmpty, type != title { parts.append(type) }
        if let model = meta?.model, !model.isEmpty {
            parts.append(TranscriptFormat.modelLabel(model))
        }
        return parts.joined(separator: " · ")
    }
}
