import Foundation

/// One `@`-mention target from `GET /api/files`: a file, directory, skill,
/// session or teammate. `insert` is what follows the "@" in a prompt (a
/// repo-relative path, `repo:path` for an attached repo, or `session:<id>`);
/// `display` is the readable form the picker lists.
struct FileMention: Decodable, Sendable, Identifiable, Equatable {
    var display: String
    var insert: String
    /// Set only when more than one repo was searched, so the row can say which.
    var repo: String?
    /// Absent means a file.
    var kind: String?

    var id: String { "\(kind ?? "file"):\(insert)" }

    var symbol: String {
        switch kind {
        case "dir": "folder"
        case "session": "bubble.left.and.bubble.right"
        case "skill": "sparkles"
        case "person": "person.crop.circle"
        default: "doc.text"
        }
    }
}
