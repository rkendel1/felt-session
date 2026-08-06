import Foundation

private final class SafeImageRedirectDelegate: NSObject, URLSessionTaskDelegate {
    func urlSession(
        _ session: URLSession,
        task: URLSessionTask,
        willPerformHTTPRedirection response: HTTPURLResponse,
        newRequest request: URLRequest,
        completionHandler: @escaping (URLRequest?) -> Void
    ) {
        var redirected = request
        if let original = task.originalRequest?.url,
           let target = request.url,
           (original.scheme != target.scheme
            || original.host != target.host
            || original.port != target.port) {
            redirected.setValue(nil, forHTTPHeaderField: "Authorization")
        }
        completionHandler(redirected)
    }
}

/// Thin REST client for the Open Session HTTP API: reads, the occasional
/// mutation, and — through `deliverPrompt` — every message this app sends.
@MainActor
enum OS1API {
    private static let imageSession = URLSession(
        configuration: .default,
        delegate: SafeImageRedirectDelegate(),
        delegateQueue: nil
    )

    enum APIError: LocalizedError {
        case notConfigured
        case badURL
        case http(Int)
        case server(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Server URL or token not set — open Settings."
            case .badURL: "Invalid server URL."
            case .http(let code):
                code == 401
                    ? "Not signed in (401) — check your token in Settings."
                    : "Server returned HTTP \(code)."
            case .server(let message): message
            }
        }
    }

    static func sessions() async throws -> [Session] {
        try await get("/api/sessions")
    }

    struct WorkspaceSummary: Decodable, Sendable {
        let id: String
        let name: String
    }

    /// Canonical workspace names for collapsing sibling sessions into one row.
    static func workspaces() async throws -> [WorkspaceSummary] {
        struct WorkspacesResponse: Decodable, Sendable {
            let workspaces: [WorkspaceSummary]
        }
        let response: WorkspacesResponse = try await get("/api/workspaces")
        return response.workspaces
    }

    static func transcript(sessionId: String) async throws -> [TranscriptEntry] {
        try await get("/api/sessions/\(sessionId)/transcript")
    }

    /// One sub-agent's transcript. `agentId` comes off the spawning Task
    /// call — its result's `agentId`, or the `ses_…` the result announces.
    static func subagent(
        sessionId: String,
        agentId: String
    ) async throws -> SubagentTranscript {
        let session = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        let agent = agentId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? agentId
        return try await get("/api/sessions/\(session)/subagent/\(agent)")
    }

    /// `@`-mention targets matching a query, for the composer's "Reference a
    /// file" picker. Scoped to the session, so an attached repo's files come
    /// back too (labelled with their repo).
    static func fileMentions(query: String, sessionId: String) async throws -> [FileMention] {
        struct MentionsResponse: Decodable, Sendable { let files: [FileMention]? }
        let allowed = CharacterSet.urlQueryAllowed.subtracting(CharacterSet(charactersIn: "&+"))
        let q = query.addingPercentEncoding(withAllowedCharacters: allowed) ?? ""
        let response: MentionsResponse = try await get(
            "/api/files?q=\(q)&session=\(sessionId)"
        )
        return response.files ?? []
    }

    /// Promote an ask-mode session to code mode. The server cuts the worktree —
    /// which is why this is one-way, and why the row says so.
    @discardableResult
    static func promoteToCode(sessionId: String) async throws -> String? {
        struct PromoteResponse: Decodable, Sendable { let branch: String? }
        let response: PromoteResponse = try await post(
            "/api/sessions/\(sessionId)/promote",
            body: [:]
        )
        return response.branch
    }

    /// Hold a prompt until `at`, when the server sends it for you.
    static func schedulePrompt(sessionId: String, prompt: String, at: Date) async throws {
        struct ScheduledPrompt: Decodable, Sendable { let id: String? }
        let formatter = ISO8601DateFormatter()
        let _: ScheduledPrompt = try await post(
            "/api/sessions/\(sessionId)/scheduled-prompts",
            body: [
                "prompt": prompt,
                "at": formatter.string(from: at),
                "user": ServerConfig.shared.userName,
            ]
        )
    }

    /// A server-side media file (walkthrough stills and demo videos are staged
    /// as absolute paths). The route is path-scoped server-side; this only
    /// spells the URL, which the video player needs as a URL rather than data.
    static func mediaURL(path: String) -> URL? {
        guard let base = ServerConfig.shared.baseURL,
              var components = URLComponents(
                  url: base.appendingPathComponent("media"),
                  resolvingAgainstBaseURL: false
              )
        else { return nil }
        components.queryItems = [URLQueryItem(name: "path", value: path)]
        return components.url
    }

    /// Bytes of a staged media file, for the stills.
    static func media(path: String) async throws -> Data {
        guard let url = mediaURL(path: path) else { throw APIError.badURL }
        return try await responseData(for: ServerConfig.shared.authorizedRequest(url))
    }

    /// Full content for an entry the WS delivered clamped.
    static func fullEntryContent(sessionId: String, entryId: String) async throws -> String {
        struct EntryResponse: Decodable { let content: String }
        let response: EntryResponse = try await get("/api/sessions/\(sessionId)/entry/\(entryId)")
        return response.content
    }

    /// Resolve an image from a bounded transcript entry. Large inline images
    /// arrive over the wire as `os-blob:<entry>/<index>` and are served as
    /// authenticated bytes by the transcript-image route.
    static func conversationImage(source: String, sessionId: String) async throws -> Data {
        if source.hasPrefix("os-blob:"),
           let slash = source.lastIndex(of: "/"),
           let index = Int(source[source.index(after: slash)...]) {
            let entryId = String(source[source.index(source.startIndex, offsetBy: 8)..<slash])
            return try await getData(
                "/api/sessions/\(sessionId)/transcript-image/\(entryId)/\(index)"
            )
        }

        guard let url = URL(string: source) else { throw APIError.badURL }
        let config = ServerConfig.shared
        let base = config.baseURL
        let sameOrigin = url.scheme == base?.scheme
            && url.host == base?.host
            && url.port == base?.port
        let request = sameOrigin
            ? config.authorizedRequest(url)
            : URLRequest(url: url)
        return try await responseData(for: request)
    }

    /// PR details for the session's branch, or nil when it has no PR — the
    /// route answers a bare JSON `null` in that case (a real answer, not an
    /// error), so probe the raw body before decoding.
    static func pr(sessionId: String) async throws -> PrDetails? {
        let data = try await getData("/api/sessions/\(sessionId)/pr")
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(PrDetails.self, from: data)
    }

    struct GitStatus: Decodable, Sendable, Equatable {
        let branch: String?
        let hasUpstream: Bool
        let ahead: Int
        let behind: Int
        let behindBase: Int
        let baseBranch: String
        let uncommittedFiles: Int
    }

    struct DiffFile: Decodable, Sendable, Identifiable, Equatable {
        let path: String
        let oldPath: String?
        let status: String
        let additions: Int
        let deletions: Int
        let binary: Bool?

        var id: String { path }
    }

    struct SessionDiff: Decodable, Sendable, Equatable {
        let branch: String?
        let baseRef: String?
        let files: [DiffFile]
        let totalAdditions: Int
        let totalDeletions: Int
        let truncated: Bool?
    }

    struct RepoDiff: Decodable, Sendable, Equatable {
        let repo: String
        let dir: String?
        let primary: Bool
        let diff: SessionDiff
    }

    struct SessionDiffResponse: Decodable, Sendable, Equatable {
        let repos: [RepoDiff]
    }

    struct WorkspaceOverview: Decodable, Sendable, Equatable {
        struct Message: Decodable, Sendable, Equatable {
            let content: String
            let sessionId: String
            let at: String
        }

        let prompt: Message?
        let lastMessage: Message?
    }

    static func gitStatus(sessionId: String, repo: String) async throws -> GitStatus? {
        let encodedRepo = repo.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed)
            ?? repo
        let data = try await getData(
            "/api/sessions/\(sessionId)/git-status?repo=\(encodedRepo)"
        )
        let body = String(decoding: data, as: UTF8.self)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if body.isEmpty || body == "null" { return nil }
        return try await decodeDetached(GitStatus.self, from: data)
    }

    static func sessionDiff(sessionId: String) async throws -> SessionDiffResponse {
        try await get("/api/sessions/\(sessionId)/diff")
    }

    static func workspaceOverview(workspaceId: String) async throws -> WorkspaceOverview {
        try await get("/api/workspaces/\(workspaceId)/overview")
    }

    /// Archive (or unarchive) a session. Archiving an in-flight session also
    /// stops its run server-side.
    static func setArchived(sessionId: String, archived: Bool) async throws {
        struct ArchiveResponse: Decodable { let ok: Bool? }
        let _: ArchiveResponse = try await post(
            "/api/sessions/\(sessionId)/archive",
            body: ["archived": archived]
        )
    }

    static func renameWorkspace(workspaceId: String, name: String) async throws {
        struct RenameResponse: Decodable { let workspace: WorkspaceSummary? }
        let _: RenameResponse = try await patch(
            "/api/workspaces/\(workspaceId)",
            body: ["name": name]
        )
    }

    static func renameSession(sessionId: String, title: String) async throws {
        struct RenameResponse: Decodable { let ok: Bool? }
        let _: RenameResponse = try await put(
            "/api/sessions/\(sessionId)/title",
            body: ["title": title]
        )
    }

    struct AuthStatus: Decodable {
        let authenticated: Bool?
        let login: String?
        let name: String?
    }

    /// Signed-in identity for the current bearer token. Used to backfill
    /// `githubLogin` on devices whose token predates the app storing the
    /// login at sign-in time (the avatar needs it).
    static func authStatus() async throws -> AuthStatus {
        try await get("/api/auth/status")
    }

    /// Revoke the server-side web session before removing its keychain copy.
    static func logout() async throws {
        struct LogoutResponse: Decodable { let ok: Bool? }
        let _: LogoutResponse = try await post("/api/auth/logout", body: [:])
    }

    /// Unauthenticated liveness probe; also carries the server bootId.
    static func health() async throws -> Bool {
        struct Health: Decodable { let ok: Bool? }
        let health: Health = try await get("/api/health", authorized: false)
        return health.ok ?? true
    }

    // MARK: - Session creation

    private struct ServerErrorBody: Decodable { let error: String? }

    struct RepoInfo: Decodable, Identifiable, Hashable {
        let id: String
        let ghRepo: String?
        let label: String?
        let defaultBranch: String?
        let sharedCheckout: Bool?
        let isDefault: Bool?

        private enum CodingKeys: String, CodingKey {
            case id, ghRepo, label, defaultBranch, sharedCheckout
            case isDefault = "default"
        }
    }

    /// Repos a new session can target.
    static func repos() async throws -> [RepoInfo] {
        struct ReposResponse: Decodable { let repos: [RepoInfo] }
        let response: ReposResponse = try await get("/api/repos")
        return response.repos
    }

    /// Models (and presets) a session can run on, plus the interactive default.
    static func models() async throws -> ModelCatalog {
        try await get("/api/models")
    }

    /// Create a session; returns the new session id. Code mode gets a
    /// server-suggested branch; the opening run starts immediately.
    static func createSession(
        prompt: String,
        repo: String,
        mode: String,
        model: String? = nil,
        effort: String? = nil,
        fastMode: Bool = false,
        images: [String] = [],
        workspaceId: String? = nil
    ) async throws -> String {
        struct CreateResponse: Decodable { let id: String }
        var body: [String: Any] = ["prompt": prompt, "mode": mode]
        if !repo.isEmpty { body["repo"] = repo }
        // Join an existing workspace as a sibling session (a new tab) rather
        // than starting a standalone session: the server takes the workspace's
        // worktree/branch for code sessions, so the tabs share one checkout.
        if let workspaceId, !workspaceId.isEmpty { body["workspaceId"] = workspaceId }
        if let model, !model.isEmpty { body["model"] = model }
        if let effort, !effort.isEmpty { body["effort"] = effort }
        if fastMode { body["fastMode"] = true }
        if !images.isEmpty { body["images"] = images }
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let response: CreateResponse = try await post("/api/sessions", body: body)
        return response.id
    }

    /// Open an empty sibling session in a session's workspace — the tab strip's
    /// "+". It shares the source's worktree, branch and repo, and has no run
    /// yet: its first prompt starts one. The server answers with the full row
    /// so the new tab renders immediately instead of waiting for the poll.
    static func newSiblingSession(from sourceId: String) async throws -> Session {
        struct NewSessionResponse: Decodable {
            let id: String
            let session: Session?
        }
        var body: [String: Any] = ["mode": "share"]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let response: NewSessionResponse = try await post(
            "/api/sessions/\(sourceId)/new-session",
            body: body
        )
        // A server old enough to omit the row still returns the id; the bare
        // session decodes tolerantly and the poll fills the rest in.
        return response.session ?? Session(id: response.id)
    }

    /// What the server did with a message — or why it couldn't.
    ///
    /// The distinction that matters to the outbox is retryable vs terminal:
    /// anything that smells like connectivity comes back `.unavailable` and is
    /// tried again, while a refusal is `.rejected` and waits for a human.
    enum PromptDelivery: Sendable {
        /// Accepted. `status` is where it landed: started/steered/queued/handled.
        case delivered(status: String, message: String)
        /// The server understood and refused — retrying won't help.
        case rejected(String)
        /// No such session (yet): a freshly created session may not be persisted.
        case missing(String)
        /// Couldn't reach the server, or it failed on its own. Retry.
        case unavailable(String)
    }

    /// Deliver one message. The reply is the acknowledgement the outbox waits
    /// for; `clientId` makes a retry idempotent, so a reply lost on the way
    /// back can never post the message twice.
    static func deliverPrompt(
        sessionId: String,
        content: String,
        images: [String] = [],
        user: String,
        busyMode: String,
        effort: String? = nil,
        fastMode: Bool? = nil,
        clientId: String
    ) async -> PromptDelivery {
        struct DeliverResponse: Decodable, Sendable {
            let status: String?
            let message: String?
            let error: String?
        }
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else {
            return .unavailable(APIError.notConfigured.localizedDescription)
        }
        let escaped = sessionId.addingPercentEncoding(
            withAllowedCharacters: .urlPathAllowed
        ) ?? sessionId
        guard let url = URL(
            string: base.absoluteString + "/api/sessions/\(escaped)/prompt"
        ) else {
            return .rejected(APIError.badURL.localizedDescription)
        }

        var body: [String: Any] = [
            "content": content,
            "busy": busyMode == "steer" ? "steer" : "queue",
            "clientId": clientId,
        ]
        if !user.isEmpty { body["user"] = user }
        if !images.isEmpty { body["images"] = images }
        if let effort, !effort.isEmpty { body["effort"] = effort }
        if let fastMode { body["fastMode"] = fastMode }

        var request = config.authorizedRequest(url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        // Shorter than URLSession's 60s default: a send that hasn't been
        // answered in 20s is better retried than left hanging, and the
        // clientId makes that safe.
        request.timeoutInterval = 20
        guard let payload = try? JSONSerialization.data(withJSONObject: body) else {
            return .rejected("Message couldn't be encoded.")
        }
        request.httpBody = payload

        do {
            let (data, response) = try await URLSession.shared.data(for: request)
            let decoded = try? await decodeDetached(DeliverResponse.self, from: data)
            guard let http = response as? HTTPURLResponse else {
                return .unavailable("No response from the server.")
            }
            if (200..<300).contains(http.statusCode) {
                return .delivered(
                    status: decoded?.status ?? "started",
                    message: decoded?.message ?? ""
                )
            }
            let message = decoded?.error ?? decoded?.message
                ?? APIError.http(http.statusCode).localizedDescription
            if http.statusCode == 404 { return .missing(message) }
            // 401 is "signed out", not "bad message" — a re-auth fixes it, so
            // hold the message rather than failing it.
            if http.statusCode == 401 || http.statusCode >= 500 {
                return .unavailable(message)
            }
            return .rejected(message)
        } catch {
            return .unavailable(await Reachability.describe(error))
        }
    }

    // MARK: - Desk

    struct DeskEnsure: Decodable, Sendable {
        let sessionId: String
        let clearedAt: String?
    }

    /// Get-or-create the user's standing Desk session (server: desk.ts).
    static func ensureDesk() async throws -> DeskEnsure {
        try await post("/api/desk/ensure", body: ["user": ServerConfig.shared.userName])
    }

    struct DeskVoiceSecret: Decodable, Sendable {
        let clientSecret: String
        let expiresAt: Double?
        let model: String
        let sessionId: String
    }

    /// Mint a short-lived Realtime client secret for a Desk voice call — the
    /// real OpenAI key stays on the server (desk-voice.ts).
    static func deskVoiceSecret() async throws -> DeskVoiceSecret {
        try await post("/api/desk/voice/secret", body: ["user": ServerConfig.shared.userName])
    }

    /// Run one Realtime tool call server-side, as the verified user, and hand
    /// back the JSON string the model gets as its function_call_output. The
    /// result under "result" has no fixed schema, so this path stays on raw
    /// JSONSerialization instead of a Decodable.
    static func deskVoiceTool(
        callId: String,
        name: String,
        args: [String: Any]
    ) async throws -> String {
        var body: [String: Any] = ["callId": callId, "name": name, "args": args]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let data = try await mutateData("/api/desk/voice/tool", method: "POST", body: body)
        if let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let result = object["result"],
           let out = try? JSONSerialization.data(
               withJSONObject: result,
               options: [.fragmentsAllowed]
           ),
           let text = String(data: out, encoding: .utf8) {
            return text
        }
        return String(decoding: data, as: UTF8.self)
    }

    /// Mirror finalized voice-call turns into the Desk transcript (and the
    /// next text turn's handoff note, server-side).
    static func deskVoiceTranscript(
        entries: [(id: String, role: String, text: String)]
    ) async throws {
        struct OkResponse: Decodable, Sendable { let ok: Bool? }
        var body: [String: Any] = [
            "entries": entries.map { ["id": $0.id, "role": $0.role, "text": $0.text] }
        ]
        let user = ServerConfig.shared.userName
        if !user.isEmpty { body["user"] = user }
        let _: OkResponse = try await post("/api/desk/voice/transcript", body: body)
    }

    private static func post<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "POST", body: body)
    }

    private static func put<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "PUT", body: body)
    }

    private static func patch<T: Decodable & Sendable>(
        _ path: String,
        body: [String: Any]
    ) async throws -> T {
        try await mutate(path, method: "PATCH", body: body)
    }

    private static func mutate<T: Decodable & Sendable>(
        _ path: String,
        method: String,
        body: [String: Any]
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: data)
    }

    /// `mutate` without a Decodable — for responses with no fixed schema
    /// (the Desk voice tool relay). Same error contract.
    private static func mutateData(
        _ path: String,
        method: String,
        body: [String: Any]
    ) async throws -> Data {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if let serverError = try? JSONDecoder().decode(ServerErrorBody.self, from: data),
               let message = serverError.error {
                throw APIError.server(message)
            }
            throw APIError.http(http.statusCode)
        }
        return data
    }

    private static func get<T: Decodable & Sendable>(
        _ path: String,
        authorized: Bool = true
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        if authorized && !config.isConfigured { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }

        let request = authorized ? config.authorizedRequest(url) : URLRequest(url: url)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(http.statusCode)
        }
        return try await decodeDetached(T.self, from: data)
    }

    /// Decode off the main actor. OS1API is @MainActor, and decoding inline
    /// parked multi-megabyte payloads on the main thread — `/api/sessions`
    /// alone is ~4MB / thousands of rows every 5s poll, a visible periodic
    /// hitch while typing (long transcripts weren't small either).
    private static func decodeDetached<T: Decodable & Sendable>(
        _ type: T.Type,
        from data: Data
    ) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(T.self, from: data)
        }.value
    }

    private static func getData(_ path: String) async throws -> Data {
        let config = ServerConfig.shared
        guard let base = config.baseURL else { throw APIError.notConfigured }
        guard config.isConfigured else { throw APIError.notConfigured }
        guard let url = URL(string: base.absoluteString + path) else { throw APIError.badURL }
        return try await responseData(for: config.authorizedRequest(url))
    }

    private static func responseData(for request: URLRequest) async throws -> Data {
        let (data, response) = try await imageSession.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            throw APIError.http(http.statusCode)
        }
        return data
    }
}
