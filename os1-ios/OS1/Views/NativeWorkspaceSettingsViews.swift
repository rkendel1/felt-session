import SwiftUI

// Native settings panels intentionally use only SettingsAPI. They can be hosted by
// any settings navigation container without depending on the legacy web settings view.

struct WorkspaceGeneralSettingsView: View {
    @State private var loaded = false

    var body: some View {
        Form {
            Section("Server") {
                LabeledContent("Address", value: ServerConfig.shared.baseURLString)
                LabeledContent("Person", value: ServerConfig.shared.userName.isEmpty ? "Not set" : ServerConfig.shared.userName)
                LabeledContent("Authentication", value: ServerConfig.shared.token.isEmpty ? "Not connected" : "Connected")
            }
            Section("Product") {
                LabeledContent("Client", value: "OS1 native")
                Text("Workspace server configuration is read-only here. Change server and sign-in details from the Connection screen.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        .navigationTitle("General")
        .task { loaded = true }
        .overlay { if !loaded { ProgressView() } }
    }
}

/// Settings → Models. The subscription pools and the bring-your-own-key
/// providers are one screen, matching the web: they answer the same question
/// ("where do the models come from?") and each half used to end by pointing at
/// the other. Both halves render sections into this List rather than owning
/// their own, so they read as one page.
struct ModelsSettingsView: View {
    @State private var reload = 0

    var body: some View {
        List {
            ModelAccountsSections(reload: reload)
            ModelProvidersSections(reload: reload)
        }
        .insetGroupedListCompat()
        .navigationTitle("Models")
        .refreshable { reload += 1 }
    }
}

struct ModelAccountsSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var catalog: ModelCatalogSettings?
    @State private var claude: [ProviderAccount] = []
    @State private var codex: [ProviderAccount] = []
    @State private var selectedModel = ""
    @State private var autoFallback = false
    @State private var loading = true
    @State private var error: String?
    @State private var showingAdd: AccountKind?
    @State private var removal: AccountRemoval?
    @State private var codexLoginSheet = false

    var body: some View {
        Group {
            // The `task` hangs off this section, which is rendered in every
            // state. A `Group`'s modifiers apply to each child individually, so
            // parking it on a conditional row would tear the task down the
            // moment that row swapped out — cancelling the fetch mid-flight and
            // leaving `loading` stuck true forever.
            Section("Workspace defaults") {
                if loading {
                    settingsLoadingRow
                } else if let error {
                    settingsErrorRow(error) { Task { await load() } }
                } else {
                    Picker("Default model", selection: $selectedModel) {
                        Text("None").tag("")
                        ForEach(validModels, id: \.id) { model in
                            Text(model.label ?? model.id ?? "Model").tag(model.id ?? "")
                        }
                    }
                    Toggle("Auto-fallback", isOn: $autoFallback)
                }
            }
            .task(id: reload) { await load() }

            if !loading, error == nil {
                accountSection("Claude", accounts: validClaude, kind: .claude)
                accountSection("Codex", accounts: validCodex, kind: .codex)
            }
        }
        .onChange(of: selectedModel) { _, value in
            guard !loading else { return }
            Task { await saveDefault(value) }
        }
        .onChange(of: autoFallback) { _, value in
            guard !loading else { return }
            Task { await saveFallback(value) }
        }
        .sheet(item: $showingAdd) { kind in
            AccountEditor(kind: kind) { name, value, owner in
                await addAccount(kind: kind, name: name, value: value, owner: owner)
            }
        }
        .sheet(isPresented: $codexLoginSheet) {
            CodexDeviceLoginView {
                codexLoginSheet = false
                await load()
            }
        }
        .alert("Remove account?", isPresented: Binding(get: { removal != nil }, set: { if !$0 { removal = nil } }), presenting: removal) { target in
            Button("Remove", role: .destructive) { Task { await remove(target) } }
            Button("Cancel", role: .cancel) {}
        } message: { target in
            Text("Remove \(target.name) from the \(target.kind.rawValue) account pool?")
        }
    }

    private var validModels: [SettingsModelOption] { (catalog?.models ?? []).filter { $0.id?.isEmpty == false } }
    private var validClaude: [ProviderAccount] { claude.filter { $0.id?.isEmpty == false } }
    private var validCodex: [ProviderAccount] { codex.filter { $0.id?.isEmpty == false } }

    @ViewBuilder private func accountSection(_ title: String, accounts: [ProviderAccount], kind: AccountKind) -> some View {
        Section(title) {
            if accounts.isEmpty {
                Text("No \(title) accounts configured.").foregroundStyle(.secondary)
            }
            ForEach(accounts, id: \.id) { account in
                HStack {
                    VStack(alignment: .leading) {
                        Text(account.name ?? account.email ?? "Account")
                        Text(account.owner?.isEmpty == false ? "Personal: \(account.owner!)" : "Shared pool")
                            .font(.caption).foregroundStyle(.secondary)
                    }
                    Spacer()
                    if account.usable == false { Text("Unavailable").foregroundStyle(.orange).font(.caption) }
                    Button(account.owner?.isEmpty == false ? "Shared" : "Owner") {
                        Task { await toggleOwnership(account, kind: kind) }
                    }.buttonStyle(.borderless)
                    Button(role: .destructive) {
                        removal = AccountRemoval(id: account.id!, name: account.name ?? "this account", kind: kind)
                    } label: { Image(systemName: "trash") }.buttonStyle(.borderless)
                }
            }
            Button { showingAdd = kind } label: { Label("Add \(title) account", systemImage: "plus") }
            if kind == .claude {
                Button("Refresh account usage") { Task { await refreshClaude() } }
            } else {
                Button { codexLoginSheet = true } label: {
                    Label("Sign in with ChatGPT", systemImage: "person.badge.key")
                }
            }
        }
    }

    private func load() async {
        loading = true; error = nil
        do {
            async let fetchedCatalog = SettingsAPI.modelCatalog()
            async let fetchedClaude = SettingsAPI.claudeAccounts()
            async let fetchedCodex = SettingsAPI.codexAccounts()
            let result = try await (fetchedCatalog, fetchedClaude, fetchedCodex)
            catalog = result.0; claude = result.1; codex = result.2
            selectedModel = result.0.default ?? ""
            autoFallback = result.0.autoFallback ?? false
        } catch { self.error = error.localizedDescription }
        loading = false
    }
    private func saveDefault(_ value: String) async { do { _ = try await SettingsAPI.setDefaultModel(value.isEmpty ? nil : value) } catch { self.error = error.localizedDescription } }
    private func saveFallback(_ value: Bool) async { do { _ = try await SettingsAPI.setModelAutoFallback(value) } catch { self.error = error.localizedDescription } }
    private func refreshClaude() async { do { claude = try await SettingsAPI.refreshClaudeAccounts() } catch { self.error = error.localizedDescription } }
    private func addAccount(kind: AccountKind, name: String, value: String, owner: String?) async {
        do {
            if kind == .claude {
                let body: [String: Any] = ["name": name, "token": value, "owner": owner ?? NSNull()]
                claude.append(try await SettingsAPI.createClaudeAccount(body))
            } else {
                let body: [String: Any] = ["name": name, "kind": "api_key", "value": value, "owner": owner ?? NSNull()]
                codex.append(try await SettingsAPI.createCodexAccount(body))
            }
            showingAdd = nil
        } catch { self.error = error.localizedDescription }
    }
    private func toggleOwnership(_ account: ProviderAccount, kind: AccountKind) async {
        guard let id = account.id else { return }
        do {
            let owner: String? = account.owner?.isEmpty == false ? nil : ServerConfig.shared.userName
            let patch: [String: Any] = ["owner": owner ?? NSNull()]
            let result: ProviderAccount
            if kind == .claude { result = try await SettingsAPI.updateClaudeAccount(id: id, patch: patch) }
            else { result = try await SettingsAPI.updateCodexAccount(id: id, patch: patch) }
            if kind == .claude, let index = claude.firstIndex(where: { $0.id == id }) { claude[index] = result }
            if kind == .codex, let index = codex.firstIndex(where: { $0.id == id }) { codex[index] = result }
        } catch { self.error = error.localizedDescription }
    }
    private func remove(_ target: AccountRemoval) async {
        do {
            if target.kind == .claude { _ = try await SettingsAPI.deleteClaudeAccount(id: target.id); claude.removeAll { $0.id == target.id } }
            else { _ = try await SettingsAPI.deleteCodexAccount(id: target.id); codex.removeAll { $0.id == target.id } }
        } catch { self.error = error.localizedDescription }
        removal = nil
    }
}

struct ModelProvidersSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var providers: [ModelProvider] = []
    @State private var loading = true
    @State private var error: String?
    @State private var editor: ModelProvider?
    @State private var deleting: ModelProvider?

    var body: some View {
        Section("Your own providers") {
            if loading { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }
            if !loading, error == nil {
                if providers.isEmpty {
                    Text("No providers yet — add one to run sessions on models beyond the Anthropic and OpenAI subscriptions.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ForEach(providers.filter { $0.id?.isEmpty == false }, id: \.id) { provider in
                    Button { editor = provider } label: {
                        VStack(alignment: .leading) {
                            Text(provider.id ?? "Provider")
                            Text(provider.baseURL ?? provider.apiKeyMasked ?? "No endpoint configured").font(.caption).foregroundStyle(.secondary)
                        }
                    }.foregroundStyle(.primary)
                }
                Button { editor = ModelProvider(id: "", apiKeyMasked: nil, baseURL: nil, models: nil) } label: { Label("Add provider", systemImage: "plus") }
            }
        }
        .task(id: reload) { await load() }
        .sheet(item: $editor) { provider in
            ModelProviderEditor(provider: provider, onSave: save, onDelete: { deleting = provider })
        }
        .alert("Delete provider?", isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }), presenting: deleting) { provider in
            Button("Delete", role: .destructive) { Task { await delete(provider) } }; Button("Cancel", role: .cancel) {}
        } message: { provider in Text("Remove \(provider.id ?? "this provider")?") }
    }
    private func load() async { loading = true; error = nil; do { providers = try await SettingsAPI.modelProviders().providers ?? [] } catch { self.error = error.localizedDescription }; loading = false }
    private func save(id: String, key: String, url: String, models: [String]) async {
        do { _ = try await SettingsAPI.upsertModelProvider(id: id, apiKey: key.isEmpty ? nil : key, baseURL: url.isEmpty ? nil : url, models: models); editor = nil; await load() } catch { self.error = error.localizedDescription }
    }
    private func delete(_ provider: ModelProvider) async { guard let id = provider.id, !id.isEmpty else { return }; do { _ = try await SettingsAPI.deleteModelProvider(id: id); providers.removeAll { $0.id == id } } catch { self.error = error.localizedDescription }; deleting = nil }
}

struct ConnectionsSettingsView: View {
    @State private var response: ConnectionsResponse?
    @State private var github: GitHubConnectionStatus?
    @State private var router: PlainRouterConfig?
    @State private var loading = true
    @State private var error: String?
    @State private var addSheet = false
    @State private var editing: MCPConnection?
    @State private var removing: MCPConnection?
    @State private var routerSheet = false
    @State private var githubFlow: GitHubDeviceFlow?
    @State private var githubConnectTask: Task<Void, Never>?

    var body: some View {
        List {
            if loading { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }
            if !loading, error == nil {
                Section("Agents") {
                    let agents = response?.agents ?? [:]
                    if agents.isEmpty { Text("No agent health data.").foregroundStyle(.secondary) }
                    ForEach(agents.keys.sorted(), id: \.self) { name in
                        let health = agents[name]
                        LabeledContent(name, value: [health?.status, health?.activeSessions.map { "\($0) active" }].compactMap { $0 }.joined(separator: " · "))
                    }
                }
                Section("MCP connections") {
                    let connections = (response?.mcpServers ?? []).filter { $0.name?.isEmpty == false }
                    if connections.isEmpty { Text("No MCP connections.").foregroundStyle(.secondary) }
                    ForEach(connections, id: \.id) { connection in
                        VStack(alignment: .leading) {
                            Text(connection.name ?? "Connection")
                            Text([connection.transport, connection.status, connection.target].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary)
                            HStack { Button("Allowed users") { editing = connection }; Button("Remove", role: .destructive) { removing = connection } }
                                .buttonStyle(.borderless)
                        }
                    }
                    Button { addSheet = true } label: { Label("Add MCP connection", systemImage: "plus") }
                }
                Section("GitHub") {
                    Text(github?.enabled == true ? "GitHub connection enabled" : "GitHub connection not enabled").foregroundStyle(.secondary)
                    ForEach((github?.accounts ?? []).filter { $0.login?.isEmpty == false }, id: \.id) { account in
                        HStack { Text("@\(account.login ?? "")"); Spacer(); Button("Disconnect", role: .destructive) { Task { await disconnect(account) } }.buttonStyle(.borderless) }
                    }
                    if github?.enabled == true {
                        Button { Task { await connectGitHub() } } label: {
                            Label("Connect GitHub account", systemImage: "person.badge.key")
                        }
                    }
                }
                Section("Plain router") {
                    Text(router?.basicModel ?? "No basic model selected").foregroundStyle(.secondary)
                    Button("Edit routing") { routerSheet = true }
                }
            }
        }
        .navigationTitle("Connections")
        .toolbar { Button("Refresh") { Task { await load(refresh: true) } } }
        .task { await load() }.refreshable { await load(refresh: true) }
        .sheet(isPresented: $addSheet) { MCPConnectionEditor { await add($0) } }
        .sheet(item: $editing) { connection in AllowedUsersEditor(connection: connection) { await update(connection, users: $0) } }
        .sheet(isPresented: $routerSheet) { PlainRouterEditor(config: router) { prompt, model in await saveRouter(prompt: prompt, model: model) } }
        .sheet(isPresented: Binding(
            get: { githubFlow != nil },
            set: { if !$0 { cancelGitHubConnect() } }
        )) {
            if let githubFlow {
                GitHubConnectionFlowView(flow: githubFlow, onCancel: cancelGitHubConnect)
            }
        }
        .alert("Remove connection?", isPresented: Binding(get: { removing != nil }, set: { if !$0 { removing = nil } }), presenting: removing) { connection in
            Button("Remove", role: .destructive) { Task { await remove(connection) } }; Button("Cancel", role: .cancel) {}
        } message: { connection in Text("Remove \(connection.name ?? "this MCP connection")?") }
    }
    private func load(refresh: Bool = false) async {
        loading = true; error = nil
        do { async let c = SettingsAPI.connections(refresh: refresh); async let g = SettingsAPI.githubConnection(); async let r = SettingsAPI.plainRouter(); let result = try await (c, g, r); response = result.0; github = result.1; router = result.2 } catch { self.error = error.localizedDescription }
        loading = false
    }
    private func add(_ body: [String: Any]) async { do { _ = try await SettingsAPI.addConnection(body); addSheet = false; await load() } catch { self.error = error.localizedDescription } }
    private func update(_ connection: MCPConnection, users: [String]) async { guard let name = connection.name else { return }; do { _ = try await SettingsAPI.updateConnection(name: name, allowedUsers: users); editing = nil; await load() } catch { self.error = error.localizedDescription } }
    private func remove(_ connection: MCPConnection) async { guard let name = connection.name else { return }; do { _ = try await SettingsAPI.removeConnection(name: name); await load() } catch { self.error = error.localizedDescription }; removing = nil }
    private func disconnect(_ account: GitHubConnectedAccount) async { guard let login = account.login else { return }; do { _ = try await SettingsAPI.disconnectGitHub(login: login); await load() } catch { self.error = error.localizedDescription } }
    private func saveRouter(prompt: String, model: String) async { do { router = try await SettingsAPI.updatePlainRouter(prompt: prompt, basicModel: model); routerSheet = false } catch { self.error = error.localizedDescription } }
    private func connectGitHub() async {
        do {
            let started = try await SettingsAPI.startGitHubDeviceFlow()
            githubFlow = started
            githubConnectTask?.cancel()
            githubConnectTask = Task {
                var interval = max(started.interval ?? 5, 1)
                while !Task.isCancelled, let code = started.deviceCode {
                    try? await Task.sleep(for: .seconds(interval))
                    guard !Task.isCancelled else { return }
                    do {
                        let result = try await SettingsAPI.pollGitHubDeviceFlow(deviceCode: code)
                        if result.status == "ok" {
                            githubFlow = nil
                            await load()
                            return
                        }
                        if result.status == "slow_down" { interval += 5 }
                        if result.status == "error" {
                            error = result.error ?? "GitHub connection failed."
                            githubFlow = nil
                            return
                        }
                    } catch {
                        self.error = error.localizedDescription
                        githubFlow = nil
                        return
                    }
                }
            }
        } catch {
            self.error = error.localizedDescription
        }
    }
    private func cancelGitHubConnect() { githubConnectTask?.cancel(); githubConnectTask = nil; githubFlow = nil }
}

struct MemorySettingsView: View {
    @State private var scopes: [MemoryScope] = []
    @State private var loading = true
    @State private var error: String?
    @State private var editor: MemoryEditTarget?

    var body: some View {
        List {
            if loading { settingsLoadingRow }
            if let error { settingsErrorRow(error) { Task { await load() } } }
            if !loading, error == nil {
                if scopes.isEmpty { ContentUnavailableView("No memory entries", systemImage: "brain") }
                ForEach(scopes.filter { $0.scope?.key?.isEmpty == false }, id: \.id) { scope in
                    Section(scope.scope?.label ?? scope.scope?.kind ?? "Memory") {
                        let entries = (scope.entries ?? []).filter { $0.id?.isEmpty == false }
                        if entries.isEmpty { Text("No entries.").foregroundStyle(.secondary) }
                        ForEach(entries, id: \.id) { entry in
                            Button { editor = MemoryEditTarget(scope: scope.scope!, entry: entry) } label: {
                                VStack(alignment: .leading) { Text(entry.text ?? ""); Text([entry.by, entry.at].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) }
                            }.foregroundStyle(.primary)
                        }
                        Button { editor = MemoryEditTarget(scope: scope.scope!, entry: nil) } label: { Label("Add entry", systemImage: "plus") }
                    }
                }
            }
        }
        .navigationTitle("Memory")
        .task { await load() }.refreshable { await load() }
        .sheet(item: $editor) { target in MemoryEditor(target: target, onSave: save, onDelete: delete) }
    }
    private func load() async { loading = true; error = nil; do { scopes = try await SettingsAPI.memory().scopes ?? [] } catch { self.error = error.localizedDescription }; loading = false }
    private func save(_ target: MemoryEditTarget, text: String) async { guard let key = target.scope.key else { return }; do { if let id = target.entry?.id { _ = try await SettingsAPI.updateMemory(scopeKey: key, id: id, text: text) } else { _ = try await SettingsAPI.addMemory(scopeKey: key, text: text, by: ServerConfig.shared.userName) }; editor = nil; await load() } catch { self.error = error.localizedDescription } }
    private func delete(_ target: MemoryEditTarget) async { guard let key = target.scope.key, let id = target.entry?.id else { return }; do { _ = try await SettingsAPI.deleteMemory(scopeKey: key, id: id); editor = nil; await load() } catch { self.error = error.localizedDescription } }
}

/// Settings → Prewarming. Dependency templates and preview containers are the
/// same idea — work done per repo ahead of time so a session starts fast — and
/// were two panes of the same shape, so they share one screen as the web does.
struct PrewarmingSettingsView: View {
    @State private var reload = 0

    var body: some View {
        List {
            WarmDepsSections(reload: reload)
            PreviewPoolSections(reload: reload)
        }
        .insetGroupedListCompat()
        .navigationTitle("Prewarming")
        .refreshable { reload += 1 }
    }
}

struct WarmDepsSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var repos: [WarmTemplate] = []
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        Group {
            // Always-rendered section, so the task it carries survives the
            // loading row swapping out — see ModelAccountsSections.
            Section("Dependency templates") {
                Text("A template worktree per repo with dependencies installed, adopted into new session worktrees instead of installing cold.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if loading { settingsLoadingRow }
                if let error { settingsErrorRow(error) { Task { await load() } } }
                if !loading, error == nil, repos.isEmpty {
                    Text("No repositories configured.").foregroundStyle(.secondary)
                }
            }
            .task(id: reload) { await load() }
            if !loading, error == nil {
                ForEach(repos.filter { $0.repoId?.isEmpty == false }, id: \.id) { repo in
                    Section(repo.repoId ?? "Repository") {
                        Toggle("Enabled", isOn: binding(repo, keyPath: \.enabled, default: false) { enabled in await update(repo, ["enabled": enabled]) })
                        Stepper("Refresh interval: \(repo.intervalHours ?? 24) hours", value: binding(repo, keyPath: \.intervalHours, default: 24) { interval in await update(repo, ["intervalHours": interval]) }, in: 1...168)
                        LabeledContent("Status", value: repo.refreshing == true ? "Refreshing" : (repo.state?.ok == false ? "Failed" : "Ready"))
                        Button("Refresh now") { Task { await refresh(repo) } }
                    }
                }
            }
        }
    }
    private func binding<T>(_ repo: WarmTemplate, keyPath: KeyPath<WarmTemplate, T?>, default defaultValue: T, save: @escaping (T) async -> Void) -> Binding<T> where T: Equatable { Binding(get: { repo[keyPath: keyPath] ?? defaultValue }, set: { value in Task { await save(value) } }) }
    private func load() async { loading = true; error = nil; do { repos = try await SettingsAPI.warmTemplates().repos ?? [] } catch { self.error = error.localizedDescription }; loading = false }
    private func update(_ repo: WarmTemplate, _ patch: [String: Any]) async { guard let id = repo.repoId else { return }; do { repos = try await SettingsAPI.updateWarmTemplate(repoId: id, patch: patch).repos ?? [] } catch { self.error = error.localizedDescription } }
    private func refresh(_ repo: WarmTemplate) async { guard let id = repo.repoId else { return }; do { repos = try await SettingsAPI.refreshWarmTemplate(repoId: id).repos ?? [] } catch { self.error = error.localizedDescription } }
}

struct PreviewPoolSections: View {
    /// Bumped by the enclosing pane's pull-to-refresh; re-runs `task`.
    var reload: Int
    @State private var repos: [PreviewPool] = []
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        Group {
            // Always-rendered section, so the task it carries survives the
            // loading row swapping out — see ModelAccountsSections.
            Section("Preview containers") {
                Text("Dev-server containers kept pre-booted so the Preview button claims one in seconds instead of paying a cold boot.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                if loading { settingsLoadingRow }
                if let error { settingsErrorRow(error) { Task { await load() } } }
                if !loading, error == nil, repos.isEmpty {
                    Text("No repositories configured.").foregroundStyle(.secondary)
                }
            }
            .task(id: reload) { await load() }
            if !loading, error == nil {
                ForEach(repos.filter { $0.repoId?.isEmpty == false }, id: \.id) { pool in
                    Section(pool.repoId ?? "Repository") {
                        Toggle("Enabled", isOn: Binding(get: { pool.config?.enabled ?? false }, set: { value in Task { await update(pool, ["enabled": value]) } }))
                        Picker("Backend", selection: Binding(get: { pool.config?.backend ?? "docker" }, set: { value in Task { await update(pool, ["backend": value]) } })) { Text("Docker").tag("docker"); Text("Daytona").tag("daytona"); Text("MicroVM").tag("microvm") }
                        Stepper("Running: \(pool.config?.running ?? 0)", value: Binding(get: { pool.config?.running ?? 0 }, set: { value in Task { await update(pool, ["running": value]) } }), in: 0...20)
                        Stepper("Paused: \(pool.config?.paused ?? 0)", value: Binding(get: { pool.config?.paused ?? 0 }, set: { value in Task { await update(pool, ["paused": value]) } }), in: 0...20)
                        Button(pool.goldenBuilding == true ? "Building…" : "Rebuild golden image") { Task { await refresh(pool) } }.disabled(pool.goldenBuilding == true)
                        ForEach((pool.containers ?? []).filter { $0.name?.isEmpty == false }, id: \.id) { container in Text("\(container.name ?? "Container") · \(container.state ?? "unknown")").font(.caption).foregroundStyle(.secondary) }
                    }
                }
            }
        }
    }
    private func load() async { loading = true; error = nil; do { repos = try await SettingsAPI.previewPool().repos ?? [] } catch { self.error = error.localizedDescription }; loading = false }
    private func update(_ pool: PreviewPool, _ patch: [String: Any]) async { guard let id = pool.repoId else { return }; do { repos = try await SettingsAPI.updatePreviewPool(repoId: id, patch: patch).repos ?? [] } catch { self.error = error.localizedDescription } }
    private func refresh(_ pool: PreviewPool) async { guard let id = pool.repoId else { return }; do { repos = try await SettingsAPI.refreshPreviewPool(repoId: id).repos ?? [] } catch { self.error = error.localizedDescription } }
}

struct PapercutsSettingsView: View {
    @State private var response: PapercutsResponse?
    @State private var loading = true
    @State private var error: String?
    var body: some View {
        List {
            if loading { settingsLoadingRow }; if let error { settingsErrorRow(error) { Task { await load() } } }
            if !loading, error == nil {
                Section("Repositories") {
                    let repos = (response?.repos ?? []).filter { $0.repoId?.isEmpty == false }
                    if repos.isEmpty { Text("No repository configuration.").foregroundStyle(.secondary) }
                    ForEach(repos, id: \.id) { repo in Toggle(repo.repoId ?? "Repository", isOn: Binding(get: { repo.enabled ?? false }, set: { enabled in Task { await set(repo, enabled: enabled) } })) }
                }
                Section("Recent entries") {
                    let entries = response?.entries ?? []
                    if entries.isEmpty { Text("No recent papercuts.").foregroundStyle(.secondary) }
                    ForEach(entries, id: \.id) { entry in VStack(alignment: .leading) { Text(entry.message ?? ""); Text([entry.repo, entry.ts].compactMap { $0 }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) } }
                }
            }
        }.navigationTitle("Papercuts").task { await load() }.refreshable { await load() }
    }
    private func load() async { loading = true; error = nil; do { response = try await SettingsAPI.papercuts(days: 14, limit: 100) } catch { self.error = error.localizedDescription }; loading = false }
    private func set(_ repo: PapercutsRepoConfig, enabled: Bool) async { guard let id = repo.repoId else { return }; do { response = try await SettingsAPI.setPapercuts(repo: id, enabled: enabled) } catch { self.error = error.localizedDescription } }
}

struct AuditLogSettingsView: View {
    @State private var page: AuditPage?
    @State private var selectedDate = ""
    @State private var selectedType = ""
    @State private var search = ""
    @State private var includeTools = false
    @State private var loading = true
    @State private var error: String?
    @State private var offset = 0
    var body: some View {
        List {
            Section("Filters") {
                Picker("Date", selection: $selectedDate) {
                    if selectedDate.isEmpty { Text("Loading dates…").tag("") }
                    ForEach(page?.dates ?? [], id: \.self) { Text($0).tag($0) }
                }
                Picker("Type", selection: $selectedType) { Text("All types").tag(""); ForEach(page?.types ?? [], id: \.self) { Text($0).tag($0) } }
                TextField("Search audit log", text: $search)
                Toggle("Include tool events", isOn: $includeTools)
                Button("Apply filters") { Task { offset = 0; await load() } }
            }
            if loading { settingsLoadingRow }; if let error { settingsErrorRow(error) { Task { await load() } } }
            if !loading, error == nil {
                Section("Events") {
                    let events = page?.events ?? []
                    if events.isEmpty { Text("No matching audit events.").foregroundStyle(.secondary) }
                    ForEach(events.filter { $0.id?.isEmpty == false }, id: \.id) { event in VStack(alignment: .leading) { Text(event.displayType).font(.headline); Text(event.displayMessage).font(.subheadline); Text([event.displayTime, event.user].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")).font(.caption).foregroundStyle(.secondary) } }
                    if events.count < (page?.total ?? 0) { Button("Load more") { Task { offset = events.count; await load(append: true) } } }
                }
            }
        }.navigationTitle("Audit Log").task { await load() }.refreshable { offset = 0; await load() }
    }
    private func load(append: Bool = false) async {
        loading = true
        error = nil
        do {
            let result = try await SettingsAPI.audit(
                date: selectedDate.isEmpty ? nil : selectedDate,
                query: search.isEmpty ? nil : search,
                type: selectedType.isEmpty ? nil : selectedType,
                includeAll: includeTools,
                offset: offset,
                limit: 100
            )
            if selectedDate.isEmpty, let newest = result.dates?.first {
                page = result
                selectedDate = newest
                loading = false
                await load()
                return
            }
            if append, let old = page {
                page = AuditPage(
                    dates: result.dates ?? old.dates,
                    events: (old.events ?? []) + (result.events ?? []),
                    total: result.total,
                    types: result.types ?? old.types
                )
            } else {
                page = result
            }
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }
}

private enum AccountKind: String, Identifiable { case claude = "Claude", codex = "Codex"; var id: String { rawValue } }
private struct AccountRemoval: Identifiable { let id: String; let name: String; let kind: AccountKind }
private struct MemoryEditTarget: Identifiable { let scope: MemoryScopeInfo; let entry: MemoryEntry?; var id: String { "\(scope.key ?? "")-\(entry?.id ?? "new")" } }

private struct AccountEditor: View {
    let kind: AccountKind; let onSave: (String, String, String?) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""; @State private var credential = ""; @State private var shared = true; @State private var saving = false
    var body: some View { NavigationStack { Form { TextField("Account name", text: $name); SecureField("Credential", text: $credential); Toggle("Shared pool account", isOn: $shared); if !shared { Text("Personal accounts are assigned to the current person.").font(.footnote).foregroundStyle(.secondary) } } .navigationTitle("Add \(kind.rawValue)").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Add") { saving = true; Task { await onSave(name, credential, shared ? nil : ServerConfig.shared.userName); saving = false } }.disabled(name.isEmpty || credential.isEmpty || saving) } } } }
}

private struct CodexDeviceLoginView: View {
    let onAdded: () async -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL
    @State private var name = ""
    @State private var shared = true
    @State private var login: CodexDeviceLogin?
    @State private var error: String?
    @State private var starting = false

    var body: some View {
        NavigationStack {
            Form {
                if let login {
                    Section("ChatGPT sign-in") {
                        if login.state == "starting" {
                            ProgressView("Starting sign-in…")
                        } else if login.state == "awaiting_code" {
                            Text("Open ChatGPT and enter this one-time code:")
                            Button { copyToPasteboard(login.code ?? "") } label: {
                                Text(login.code ?? "—").font(.title.monospaced().bold())
                            }
                            if let raw = login.url, let url = URL(string: raw) {
                                Button("Copy code and open ChatGPT") {
                                    copyToPasteboard(login.code ?? "")
                                    openURL(url)
                                }
                            }
                            ProgressView("Waiting for approval…")
                        } else if login.state == "error" {
                            Text(login.error ?? "ChatGPT sign-in failed.").foregroundStyle(.red)
                        }
                    }
                } else {
                    Section {
                        TextField("Account name", text: $name)
                            .autocorrectionDisabled()
                            .noAutocapitalizationCompat()
                        Toggle("Shared pool account", isOn: $shared)
                    } header: {
                        Text("Account")
                    } footer: {
                        Text("A device code lets you sign in without opening a shell on the server.")
                    }
                    Button(starting ? "Starting…" : "Start ChatGPT sign-in") {
                        Task { await start() }
                    }
                    .disabled(starting || name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let error { Text(error).foregroundStyle(.red) }
            }
            .navigationTitle("Add Codex Account")
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { Task { await cancel() } }
                }
            }
            .task(id: login?.id) { await poll() }
        }
        .onDisappear { Task { await cancelPendingLogin() } }
        #if os(macOS)
        .frame(minWidth: 440, minHeight: 360)
        #endif
    }

    private func start() async {
        starting = true
        error = nil
        do {
            login = try await SettingsAPI.startCodexDeviceLogin(
                name: name.trimmingCharacters(in: .whitespacesAndNewlines),
                owner: shared ? nil : ServerConfig.shared.userName
            )
        } catch {
            self.error = error.localizedDescription
        }
        starting = false
    }

    private func poll() async {
        guard let id = login?.id else { return }
        while !Task.isCancelled {
            guard login?.state == "starting" || login?.state == "awaiting_code" else { return }
            try? await Task.sleep(for: .seconds(2))
            guard !Task.isCancelled else { return }
            do {
                let next = try await SettingsAPI.codexDeviceLogin(id: id)
                login = next
                if next.state == "done" {
                    await onAdded()
                    dismiss()
                    return
                }
            } catch {
                self.error = error.localizedDescription
                return
            }
        }
    }

    private func cancel() async {
        await cancelPendingLogin()
        dismiss()
    }

    private func cancelPendingLogin() async {
        guard let id = login?.id,
              let state = login?.state,
              state == "starting" || state == "awaiting_code"
        else { return }
        login?.state = "cancelled"
        _ = try? await SettingsAPI.cancelCodexDeviceLogin(id: id)
    }
}

private struct ModelProviderEditor: View {
    let provider: ModelProvider; let onSave: (String, String, String, [String]) async -> Void; let onDelete: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var id = ""; @State private var key = ""; @State private var url = ""; @State private var modelText = ""
    var body: some View { NavigationStack { Form { TextField("Provider ID", text: $id); SecureField("API key (leave blank to keep)", text: $key); TextField("Base URL", text: $url); TextField("Model IDs, comma separated", text: $modelText); if !provider.id.orEmpty.isEmpty { Button("Delete provider", role: .destructive) { onDelete(); dismiss() } } } .navigationTitle(provider.id.orEmpty.isEmpty ? "Add Provider" : "Edit Provider").onAppear { id = provider.id ?? ""; url = provider.baseURL ?? ""; modelText = (provider.models ?? []).joined(separator: ", ") }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(id, key, url, modelText.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }) } }.disabled(id.isEmpty) } } } }
}

private struct MCPConnectionEditor: View {
    let onSave: ([String: Any]) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""; @State private var transport = "http"; @State private var target = ""; @State private var command = ""
    var body: some View { NavigationStack { Form { TextField("Name", text: $name); Picker("Transport", selection: $transport) { Text("HTTP").tag("http"); Text("stdio").tag("stdio") }; if transport == "http" { TextField("Server URL", text: $target).urlFieldCompat() } else { TextField("Command", text: $command); TextField("Arguments (space separated)", text: $target) } } .navigationTitle("Add MCP").toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Add") { var body: [String: Any] = ["name": name, "transport": transport]; if transport == "http" { body["url"] = target } else { body["command"] = command; body["args"] = target.split(separator: " ").map(String.init) }; Task { await onSave(body) } }.disabled(name.isEmpty || (transport == "http" ? target.isEmpty : command.isEmpty)) } } } }
}

private struct AllowedUsersEditor: View {
    let connection: MCPConnection; let onSave: ([String]) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var users = ""
    var body: some View { NavigationStack { Form { TextField("Allowed users, comma separated", text: $users); Text("Leave blank to make this connection available to everyone.").font(.footnote).foregroundStyle(.secondary) }.navigationTitle("Allowed Users").onAppear { users = (connection.allowedUsers ?? []).joined(separator: ", ") }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(users.split(separator: ",").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }) } } } } } }
}

private struct PlainRouterEditor: View {
    let config: PlainRouterConfig?; let onSave: (String, String) async -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var prompt = ""; @State private var model = ""
    var body: some View { NavigationStack { Form { TextField("Basic model", text: $model); TextEditor(text: $prompt).frame(minHeight: 180); Button("Reset to server defaults") { prompt = config?.defaultPrompt ?? ""; model = config?.defaultBasicModel ?? "" } } .navigationTitle("Plain Router").onAppear { prompt = config?.prompt ?? ""; model = config?.basicModel ?? "" }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(prompt, model) } } } } } }
}

private struct GitHubConnectionFlowView: View {
    let flow: GitHubDeviceFlow
    let onCancel: () -> Void
    @Environment(\.openURL) private var openURL

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                Image(systemName: "person.badge.key")
                    .font(.system(size: 42))
                    .foregroundStyle(.tint)
                Text("Connect GitHub")
                    .font(.title2.bold())
                Text("Enter this code on GitHub")
                    .foregroundStyle(.secondary)
                Button {
                    copyToPasteboard(flow.userCode ?? "")
                } label: {
                    Text(flow.userCode ?? "—")
                        .font(.title.monospaced().bold())
                }
                if let raw = flow.verificationUri, let url = URL(string: raw) {
                    Button("Copy code and open GitHub") {
                        copyToPasteboard(flow.userCode ?? "")
                        openURL(url)
                    }
                    .buttonStyle(.borderedProminent)
                }
                ProgressView("Waiting for approval…")
                Spacer()
            }
            .padding(28)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel", action: onCancel)
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 420, minHeight: 360)
        #endif
    }
}

private struct MemoryEditor: View {
    let target: MemoryEditTarget; let onSave: (MemoryEditTarget, String) async -> Void; let onDelete: (MemoryEditTarget) async -> Void
    @Environment(\.dismiss) private var dismiss; @State private var text = ""
    var body: some View { NavigationStack { Form { TextEditor(text: $text).frame(minHeight: 150); if target.entry != nil { Button("Delete entry", role: .destructive) { Task { await onDelete(target) } } } } .navigationTitle(target.entry == nil ? "Add Memory" : "Edit Memory").onAppear { text = target.entry?.text ?? "" }.toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }; ToolbarItem(placement: .confirmationAction) { Button("Save") { Task { await onSave(target, text) } }.disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty) } } } }
}

private var settingsLoadingRow: some View { HStack { Spacer(); ProgressView("Loading…"); Spacer() } }
private func settingsErrorRow(_ message: String, retry: @escaping () -> Void) -> some View { VStack(alignment: .leading, spacing: 8) { Text(message).foregroundStyle(.red); Button("Retry", action: retry) } }

private extension Optional where Wrapped == String { var orEmpty: String { self ?? "" } }
