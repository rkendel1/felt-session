import Foundation

extension Notification.Name {
    static let settingsAuthenticationExpired = Notification.Name("os1.settingsAuthenticationExpired")
}

/// Native REST client for the settings surfaces. Keep this separate from
/// `OS1API`: settings mutates server configuration much more frequently than
/// the session client and needs every HTTP verb plus query construction.
@MainActor
enum SettingsAPI {
    private struct ServerError: Decodable { var error: String? }

    // MARK: - Automations

    static func automations() async throws -> [Automation] {
        try await request("/api/automations")
    }

    static func createAutomation(_ body: [String: Any]) async throws -> Automation {
        try await request("/api/automations", method: "POST", body: body)
    }

    static func updateAutomation(id: String, patch: [String: Any]) async throws -> Automation {
        try await request("/api/automations/\(segment(id))", method: "PUT", body: patch)
    }

    static func deleteAutomation(id: String) async throws -> SettingsOK {
        try await request("/api/automations/\(segment(id))", method: "DELETE")
    }

    static func runAutomation(id: String) async throws -> SettingsOK {
        try await request("/api/automations/\(segment(id))/run", method: "POST")
    }

    static func retriggerAutomation(sessionId: String) async throws -> SettingsOK {
        try await request("/api/automations/retrigger", method: "POST", body: ["sessionId": sessionId])
    }

    // MARK: - Goals

    static func goals() async throws -> [Goal] { try await request("/api/goals") }

    static func goal(id: String) async throws -> Goal {
        try await request("/api/goals/\(segment(id))")
    }

    static func createGoal(_ body: [String: Any]) async throws -> Goal {
        try await request("/api/goals", method: "POST", body: body)
    }

    static func updateGoal(id: String, patch: [String: Any]) async throws -> Goal {
        try await request("/api/goals/\(segment(id))", method: "PUT", body: patch)
    }

    static func deleteGoal(id: String) async throws -> SettingsOK {
        try await request("/api/goals/\(segment(id))", method: "DELETE")
    }

    static func runGoal(id: String) async throws -> SettingsOK {
        try await request("/api/goals/\(segment(id))/run", method: "POST")
    }

    static func pauseGoal(id: String, reason: String? = nil) async throws -> Goal {
        try await request("/api/goals/\(segment(id))/pause", method: "POST", body: reason.map { ["reason": $0] } ?? [:])
    }

    static func resumeGoal(id: String, when: String? = nil) async throws -> Goal {
        try await request("/api/goals/\(segment(id))/resume", method: "POST", body: when.map { ["when": $0] } ?? [:])
    }

    // MARK: - Actions and security

    static func actions() async throws -> [Action] { try await request("/api/actions") }

    static func createAction(_ body: [String: Any]) async throws -> Action {
        try await request("/api/actions", method: "POST", body: body)
    }

    static func deleteAction(id: String) async throws -> SettingsOK {
        try await request("/api/actions/\(segment(id))", method: "DELETE")
    }

    static func runAction(id: String, values: [String: Any], user: String) async throws -> ActionRunResult {
        try await request("/api/actions/\(segment(id))/run", method: "POST", body: ["values": values, "user": user])
    }

    static func security() async throws -> SecurityState { try await request("/api/security") }

    static func createSecurityScan(_ body: [String: Any]) async throws -> SecurityScanResult {
        try await request("/api/security/scans", method: "POST", body: body)
    }

    static func deleteSecurityScan(id: String) async throws -> SettingsOK {
        try await request("/api/security/scans/\(segment(id))", method: "DELETE")
    }

    static func createSecurityProfile(_ body: [String: Any]) async throws -> SecurityProfile {
        try await request("/api/security/profiles", method: "POST", body: body)
    }

    static func updateSecurityProfile(id: String, patch: [String: Any]) async throws -> SecurityProfile {
        try await request("/api/security/profiles/\(segment(id))", method: "PUT", body: patch)
    }

    static func deleteSecurityProfile(id: String) async throws -> SettingsOK {
        try await request("/api/security/profiles/\(segment(id))", method: "DELETE")
    }

    // MARK: - Preferences and personal context

    static func uiPrefs(user: String) async throws -> [String: String] {
        struct Response: Decodable, Sendable { var prefs: [String: String]? }
        let response: Response = try await request("/api/ui-prefs", query: ["user": user])
        return response.prefs ?? [:]
    }

    static func updateUiPrefs(user: String, prefs: [String: String?]) async throws -> [String: String] {
        struct Response: Decodable, Sendable { var prefs: [String: String]? }
        var prefValues: [String: Any] = [:]
        for (key, value) in prefs { prefValues[key] = value ?? NSNull() }
        let body: [String: Any] = ["user": user, "prefs": prefValues]
        let response: Response = try await request("/api/ui-prefs", method: "PUT", body: body)
        return response.prefs ?? [:]
    }

    /// Per-user sidebar hides, shared with the web sidebar (row key → ISO
    /// hidden-at). PUT replaces the whole map, like pins and snoozes.
    static func hides(user: String) async throws -> [String: String] {
        struct Response: Decodable, Sendable { var hides: [String: String]? }
        let response: Response = try await request("/api/hides", query: ["user": user])
        return response.hides ?? [:]
    }

    @discardableResult
    static func saveHides(user: String, hides: [String: String]) async throws -> [String: String] {
        struct Response: Decodable, Sendable { var hides: [String: String]? }
        let body: [String: Any] = ["user": user, "hides": hides]
        let response: Response = try await request("/api/hides", method: "PUT", body: body)
        return response.hides ?? hides
    }

    /// Per-user pinned rows, shared with the web sidebar's Pinned band (row
    /// keys, in the user's own band order). PUT replaces the whole list.
    static func pins(user: String) async throws -> [String] {
        struct Response: Decodable, Sendable { var pins: [String]? }
        let response: Response = try await request("/api/pins", query: ["user": user])
        return response.pins ?? []
    }

    @discardableResult
    static func savePins(user: String, pins: [String]) async throws -> [String] {
        struct Response: Decodable, Sendable { var pins: [String]? }
        let body: [String: Any] = ["user": user, "pins": pins]
        let response: Response = try await request("/api/pins", method: "PUT", body: body)
        return response.pins ?? pins
    }

    /// Per-user read marks, shared with the web sidebar (session id → the ISO
    /// `lastActivity` it carried when last read). PUT replaces the whole map.
    static func reads(user: String) async throws -> [String: String] {
        struct Response: Decodable, Sendable { var reads: [String: String]? }
        let response: Response = try await request("/api/reads", query: ["user": user])
        return response.reads ?? [:]
    }

    @discardableResult
    static func saveReads(user: String, reads: [String: String]) async throws -> [String: String] {
        struct Response: Decodable, Sendable { var reads: [String: String]? }
        let body: [String: Any] = ["user": user, "reads": reads]
        let response: Response = try await request("/api/reads", method: "PUT", body: body)
        return response.reads ?? reads
    }

    static func personalPrompt(user: String) async throws -> String {
        struct Response: Decodable, Sendable { var prompt: String? }
        let response: Response = try await request("/api/personal-prompt", query: ["user": user])
        return response.prompt ?? ""
    }

    static func setPersonalPrompt(user: String, prompt: String) async throws -> String {
        struct Response: Decodable, Sendable { var prompt: String? }
        let response: Response = try await request("/api/personal-prompt", method: "PUT", body: ["user": user, "prompt": prompt])
        return response.prompt ?? ""
    }

    // MARK: - Models and accounts

    static func modelCatalog() async throws -> ModelCatalogSettings { try await request("/api/models") }

    static func setDefaultModel(_ model: String?) async throws -> ModelDefaults {
        try await request("/api/models/default", method: "PUT", body: ["model": model ?? NSNull()])
    }

    static func setInteractiveDefaultModel(_ model: String?) async throws -> ModelDefaults {
        try await request("/api/models/default", method: "PUT", body: ["interactiveModel": model ?? NSNull()])
    }

    static func setModelAutoFallback(_ enabled: Bool) async throws -> ModelDefaults {
        try await request("/api/models/auto-fallback", method: "PUT", body: ["auto": enabled])
    }

    static func claudeAccounts() async throws -> [ProviderAccount] {
        let response: ProviderAccountsResponse = try await request("/api/claude-accounts")
        return response.accounts ?? []
    }

    static func createClaudeAccount(_ body: [String: Any]) async throws -> ProviderAccount {
        try await request("/api/claude-accounts", method: "POST", body: body)
    }

    static func refreshClaudeAccounts() async throws -> [ProviderAccount] {
        let response: ProviderAccountsResponse = try await request("/api/claude-accounts/refresh", method: "POST")
        return response.accounts ?? []
    }

    static func updateClaudeAccount(id: String, patch: [String: Any]) async throws -> ProviderAccount {
        try await request("/api/claude-accounts/\(segment(id))", method: "PUT", body: patch)
    }

    static func deleteClaudeAccount(id: String) async throws -> SettingsOK {
        try await request("/api/claude-accounts/\(segment(id))", method: "DELETE")
    }

    static func codexAccounts() async throws -> [ProviderAccount] {
        let response: ProviderAccountsResponse = try await request("/api/codex-accounts")
        return response.accounts ?? []
    }

    static func createCodexAccount(_ body: [String: Any]) async throws -> ProviderAccount {
        try await request("/api/codex-accounts", method: "POST", body: body)
    }

    static func updateCodexAccount(id: String, patch: [String: Any]) async throws -> ProviderAccount {
        try await request("/api/codex-accounts/\(segment(id))", method: "PUT", body: patch)
    }

    static func deleteCodexAccount(id: String) async throws -> SettingsOK {
        try await request("/api/codex-accounts/\(segment(id))", method: "DELETE")
    }

    static func startCodexDeviceLogin(name: String, owner: String? = nil) async throws -> CodexDeviceLogin {
        var body: [String: Any] = ["name": name]
        if let owner { body["owner"] = owner }
        return try await request("/api/codex-accounts/device-login", method: "POST", body: body)
    }

    static func codexDeviceLogin(id: String) async throws -> CodexDeviceLogin {
        try await request("/api/codex-accounts/device-login/\(segment(id))")
    }

    static func cancelCodexDeviceLogin(id: String) async throws -> SettingsOK {
        try await request("/api/codex-accounts/device-login/\(segment(id))", method: "DELETE")
    }

    static func modelProviders() async throws -> ModelProvidersResponse {
        try await request("/api/settings/model-providers")
    }

    static func upsertModelProvider(id: String, apiKey: String? = nil, baseURL: String? = nil, models: [String]? = nil) async throws -> ModelProvider {
        struct Response: Decodable, Sendable { var provider: ModelProvider? }
        var body: [String: Any] = [:]
        if let apiKey { body["apiKey"] = apiKey }
        if let baseURL { body["baseURL"] = baseURL }
        if let models { body["models"] = models }
        let response: Response = try await request("/api/settings/model-providers/\(segment(id))", method: "PUT", body: body)
        return response.provider ?? ModelProvider(id: id, apiKeyMasked: nil, baseURL: nil, models: nil)
    }

    static func deleteModelProvider(id: String) async throws -> SettingsOK {
        try await request("/api/settings/model-providers/\(segment(id))", method: "DELETE")
    }

    // MARK: - Connections

    static func connections(refresh: Bool = false) async throws -> ConnectionsResponse {
        try await request("/api/connections", query: refresh ? ["refresh": "1"] : [:])
    }

    static func addConnection(_ body: [String: Any]) async throws -> SettingsOK {
        try await request("/api/connections/mcp", method: "POST", body: body)
    }

    static func updateConnection(name: String, allowedUsers: [String]?) async throws -> SettingsOK {
        try await request("/api/connections/mcp/\(segment(name))", method: "PUT", body: ["allowedUsers": allowedUsers ?? []])
    }

    static func removeConnection(name: String) async throws -> SettingsOK {
        try await request("/api/connections/mcp/\(segment(name))", method: "DELETE")
    }

    static func githubConnection() async throws -> GitHubConnectionStatus {
        try await request("/api/connections/github")
    }

    static func startGitHubDeviceFlow() async throws -> GitHubDeviceFlow {
        try await request("/api/connections/github/device", method: "POST")
    }

    static func pollGitHubDeviceFlow(deviceCode: String) async throws -> GitHubDeviceFlow {
        try await request("/api/connections/github/device/poll", method: "POST", body: ["deviceCode": deviceCode])
    }

    static func disconnectGitHub(login: String) async throws -> SettingsOK {
        try await request("/api/connections/github/account/\(segment(login))", method: "DELETE")
    }

    static func plainRouter() async throws -> PlainRouterConfig {
        try await request("/api/connections/plain-router")
    }

    static func updatePlainRouter(prompt: String? = nil, basicModel: String? = nil) async throws -> PlainRouterConfig {
        var body: [String: Any] = [:]
        if let prompt { body["prompt"] = prompt }
        if let basicModel { body["basicModel"] = basicModel }
        return try await request("/api/connections/plain-router", method: "PUT", body: body)
    }

    // MARK: - Memory, warmers, papercuts, audit

    static func memory() async throws -> MemoryResponse { try await request("/api/memory") }

    static func addMemory(scopeKey: String, text: String, by: String) async throws -> MemoryResponse {
        try await request("/api/memory", method: "POST", body: ["scopeKey": scopeKey, "text": text, "by": by])
    }

    static func updateMemory(scopeKey: String, id: String, text: String) async throws -> MemoryResponse {
        try await request("/api/memory", method: "PUT", body: ["scopeKey": scopeKey, "id": id, "text": text])
    }

    static func deleteMemory(scopeKey: String, id: String) async throws -> SettingsOK {
        try await request("/api/memory", method: "DELETE", body: ["scopeKey": scopeKey, "id": id])
    }

    static func warmTemplates() async throws -> WarmTemplatesResponse { try await request("/api/warm-templates") }

    static func updateWarmTemplate(repoId: String, patch: [String: Any]) async throws -> WarmTemplatesResponse {
        try await request("/api/warm-templates/\(segment(repoId))", method: "PUT", body: patch)
    }

    static func refreshWarmTemplate(repoId: String) async throws -> WarmTemplatesResponse {
        try await request("/api/warm-templates/\(segment(repoId))/refresh", method: "POST")
    }

    static func previewPool() async throws -> PreviewPoolResponse { try await request("/api/preview-pool") }

    static func updatePreviewPool(repoId: String, patch: [String: Any]) async throws -> PreviewPoolResponse {
        try await request("/api/preview-pool/\(segment(repoId))", method: "PUT", body: patch)
    }

    static func refreshPreviewPool(repoId: String) async throws -> PreviewPoolResponse {
        try await request("/api/preview-pool/\(segment(repoId))/refresh", method: "POST")
    }

    static func papercuts(repo: String? = nil, days: Int? = nil, limit: Int? = nil) async throws -> PapercutsResponse {
        var query: [String: String] = [:]
        if let repo { query["repo"] = repo }
        if let days { query["days"] = String(days) }
        if let limit { query["limit"] = String(limit) }
        return try await request("/api/papercuts", query: query)
    }

    static func setPapercuts(repo: String, enabled: Bool) async throws -> PapercutsResponse {
        try await request("/api/papercuts/config", method: "PUT", body: ["repo": repo, "enabled": enabled])
    }

    static func audit(date: String? = nil, query search: String? = nil, type: String? = nil, session: String? = nil, includeAll: Bool = false, offset: Int? = nil, limit: Int? = nil) async throws -> AuditPage {
        var query: [String: String] = [:]
        if let date { query["date"] = date }
        if let search { query["q"] = search }
        if let type { query["type"] = type }
        if let session { query["session"] = session }
        if includeAll { query["all"] = "1" }
        if let offset { query["offset"] = String(offset) }
        if let limit { query["limit"] = String(limit) }
        return try await request("/api/audit", query: query)
    }

    // MARK: - Transport

    private static func request<T: Decodable & Sendable>(
        _ path: String,
        method: String = "GET",
        query: [String: String] = [:],
        body: [String: Any]? = nil
    ) async throws -> T {
        let config = ServerConfig.shared
        guard let base = config.baseURL, config.isConfigured else { throw OS1API.APIError.notConfigured }
        guard var components = URLComponents(string: base.absoluteString + path) else {
            throw OS1API.APIError.badURL
        }
        if !query.isEmpty {
            components.queryItems = query.map { URLQueryItem(name: $0.key, value: $0.value) }
        }
        guard let url = components.url else { throw OS1API.APIError.badURL }

        var request = config.authorizedRequest(url)
        request.httpMethod = method
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONSerialization.data(withJSONObject: body, options: [])
        }
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            if http.statusCode == 401 {
                NotificationCenter.default.post(name: .settingsAuthenticationExpired, object: nil)
            }
            if let error = try? await decode(ServerError.self, from: data), let message = error.error {
                throw OS1API.APIError.server(message)
            }
            throw OS1API.APIError.http(http.statusCode)
        }
        return try await decode(T.self, from: data)
    }

    /// Keep settings payload decoding off the main actor, matching OS1API's
    /// session-list behavior without coupling to its private helper.
    private static func decode<T: Decodable & Sendable>(_ type: T.Type, from data: Data) async throws -> T {
        try await Task.detached(priority: .userInitiated) {
            try JSONDecoder().decode(T.self, from: data)
        }.value
    }

    private static func segment(_ value: String) -> String {
        var allowed = CharacterSet.urlPathAllowed
        allowed.remove(charactersIn: "/")
        return value.addingPercentEncoding(withAllowedCharacters: allowed) ?? value
    }
}
