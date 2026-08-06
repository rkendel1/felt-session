import SwiftUI

struct SettingsView: View {
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openURL) private var openURL

    @State private var config = ServerConfig.shared
    @State private var showingConnection = !ServerConfig.shared.isConfigured
    @State private var serverURL = ServerConfig.shared.baseURLString
    @State private var userName = ServerConfig.shared.userName
    @State private var token = ServerConfig.shared.token
    @State private var checkResult: String?
    @State private var copiedCode = false

    private var signIn: GitHubSignIn { .shared }

    private var signedInLogin: String? {
        let login = config.githubLogin
        return login.isEmpty || token.isEmpty ? nil : login
    }

    var body: some View {
        NavigationStack {
            Group {
                if showingConnection || !config.isConfigured {
                    connectionForm
                } else {
                    settingsHome
                }
            }
            .navigationTitle(showingConnection || !config.isConfigured ? "Connection" : "Settings")
            .inlineTitleBarCompat()
            #if os(macOS)
            .frame(minWidth: 620, minHeight: 640)
            #endif
            .toolbar { toolbar }
            .onAppear { signIn.nudge() }
            .onChange(of: signIn.flow?.deviceCode) { _, deviceCode in
                copiedCode = false
                if deviceCode == nil, config.token != token {
                    token = config.token
                    userName = config.userName
                    checkResult = nil
                    if config.isConfigured { showingConnection = false }
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: .settingsAuthenticationExpired)) { _ in
                config.token = ""
                token = ""
                checkResult = "Your session expired. Sign in again to continue."
                showingConnection = true
            }
        }
    }

    private var settingsHome: some View {
        List {
            // Groups mirror the web nav (src/frontend/components/Settings.tsx):
            // what one person owns first, then what the whole instance does.
            Section("Personal") {
                settingsLink("Personal prompt", icon: "text.bubble") {
                    PersonalPromptSettingsView()
                }
                settingsLink("Composer", icon: "keyboard") {
                    ComposerSettingsView()
                }
                settingsLink("Notifications", icon: "bell") {
                    NotificationsSettingsView()
                }
                settingsLink("Appearance", icon: "circle.lefthalf.filled") {
                    AppearanceSettingsView()
                }
            }

            Section("Workspace") {
                settingsLink("General", icon: "person") {
                    WorkspaceGeneralSettingsView()
                }
                settingsLink("Models", icon: "square.grid.2x2") {
                    ModelsSettingsView()
                }
                settingsLink("Connections", icon: "point.3.connected.trianglepath.dotted") {
                    ConnectionsSettingsView()
                }
                settingsLink("Memory", icon: "brain") {
                    MemorySettingsView()
                }
            }

            Section("Automation") {
                settingsLink("Automations", icon: "clock.arrow.circlepath") {
                    AutomationSettingsView()
                }
                settingsLink("Goals", icon: "target") {
                    GoalSettingsView()
                }
                settingsLink("Actions", icon: "bolt") {
                    ActionSettingsView()
                }
                settingsLink("Security", icon: "checkmark.shield") {
                    SecuritySettingsView()
                }
            }

            Section("Infrastructure") {
                settingsLink("Prewarming", icon: "flame") {
                    PrewarmingSettingsView()
                }
            }

            Section("Activity") {
                settingsLink("Papercuts", icon: "bandage") {
                    PapercutsSettingsView()
                }
                settingsLink("Audit log", icon: "list.bullet.rectangle") {
                    AuditLogSettingsView()
                }
            }
        }
        .insetGroupedListCompat()
    }

    private func settingsLink<Destination: View>(
        _ title: String,
        icon: String,
        @ViewBuilder destination: () -> Destination
    ) -> some View {
        NavigationLink {
            destination()
        } label: {
            Label {
                Text(title)
                    .foregroundStyle(OS1VisualStyle.text)
            } icon: {
                // Without the tile the glyph carries the row on its own, so it
                // takes a colour of its own rather than secondary-label gray
                // or the title's black-on-white, and trades size for weight:
                // smaller than the title beside it, heavier than it, which
                // keeps the icon column reading as a column instead of as
                // dimmer text.
                Image(systemName: icon)
                    .symbolRenderingMode(.monochrome)
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(OS1VisualStyle.link)
                    .frame(width: 28, height: 28)
            }
        }
    }

    private var connectionForm: some View {
        Form {
            Section("Server") {
                TextField("https://sessions.example.com", text: $serverURL)
                    .urlFieldCompat()
                    .autocorrectionDisabled()
            }

            Section {
                if let flow = signIn.flow {
                    signInFlow(flow)
                } else if let signedInLogin {
                    HStack {
                        Label("Signed in as @\(signedInLogin)", systemImage: "checkmark.seal")
                        Spacer()
                        Button("Sign out", role: .destructive) { signOut() }
                    }
                } else {
                    Button {
                        startSignIn()
                    } label: {
                        Label(
                            signIn.starting ? "Starting…" : "Sign in with GitHub",
                            systemImage: "person.badge.key"
                        )
                    }
                    .disabled(signIn.starting)
                }
                if let signInError = signIn.error {
                    Text(signInError)
                        .font(.footnote)
                        .foregroundStyle(.red)
                }
                SecureField("Bearer token (or paste one manually)", text: $token)
                    .autocorrectionDisabled()
                    .noAutocapitalizationCompat()
            } header: {
                Text("Authentication")
            } footer: {
                Text("Sign in with GitHub, or paste a session token. The token is stored in the keychain.")
            }

            if !signIn.diagnostics.isEmpty {
                Section("Sign-in log") {
                    ForEach(
                        Array(signIn.diagnostics.suffix(15).reversed().enumerated()),
                        id: \.offset
                    ) { _, line in
                        Text(line)
                            .font(.caption2.monospaced())
                            .foregroundStyle(.secondary)
                    }
                }
            }

            Section("Identity") {
                TextField("Name shown on your prompts", text: $userName)
                    .autocorrectionDisabled()
            }

            Section {
                Button("Test connection") {
                    Task { await testConnection() }
                }
                if let checkResult {
                    Text(checkResult)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }
        }
        #if os(iOS)
        .scrollContentBackground(.hidden)
        .background(OS1VisualStyle.background)
        #else
        .formStyle(.grouped)
        #endif
    }

    @ViewBuilder
    private func signInFlow(_ flow: GitHubAuth.DeviceFlowStart) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Enter this code on GitHub:")
                .font(.footnote)
                .foregroundStyle(.secondary)
            Button {
                copyToPasteboard(flow.userCode)
                copiedCode = true
            } label: {
                Text(flow.userCode)
                    .font(.system(.title, design: .monospaced).bold())
                    .foregroundStyle(.primary)
                    .frame(maxWidth: .infinity)
            }
            Text(copiedCode ? "Copied — paste it on GitHub." : "Tap the code to copy it.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .frame(maxWidth: .infinity)
            if let url = URL(string: flow.verificationUri) {
                Button("Copy code and open GitHub") {
                    copyToPasteboard(flow.userCode)
                    copiedCode = true
                    openURL(url)
                }
            }
            HStack(spacing: 8) {
                ProgressView()
                Text("Waiting for approval…")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                Spacer()
                Button("Cancel", role: .cancel) { signIn.cancel() }
            }
            if let at = signIn.lastPollAt {
                Text("Checked \(at.formatted(date: .omitted, time: .standard)) — \(signIn.lastPollNote ?? "")")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 4)
        .buttonStyle(.borderless)
    }

    @ToolbarContentBuilder
    private var toolbar: some ToolbarContent {
        if showingConnection || !config.isConfigured {
            ToolbarItem(placement: .confirmationAction) {
                Button("Save") {
                    save()
                    if config.isConfigured { showingConnection = false }
                }
            }
            ToolbarItem(placement: .cancellationAction) {
                Button(config.isConfigured ? "Back" : "Cancel") {
                    if config.isConfigured {
                        showingConnection = false
                    } else {
                        dismiss()
                    }
                }
            }
        } else {
            ToolbarItem(placement: .topLeadingCompat) {
                Button {
                    showingConnection = true
                } label: {
                    Label("Connection", systemImage: "server.rack")
                }
            }
            ToolbarItem(placement: .confirmationAction) {
                Button("Done") { dismiss() }
            }
        }
    }

    private func startSignIn() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        signIn.start()
    }

    private func signOut() {
        Task {
            try? await OS1API.logout()
            config.token = ""
            token = ""
            showingConnection = true
        }
    }

    private func save() {
        config.baseURLString = serverURL.trimmingCharacters(in: .whitespacesAndNewlines)
        config.userName = userName.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmedToken != config.token { config.githubLogin = "" }
        config.token = trimmedToken
    }

    private func testConnection() async {
        save()
        do {
            _ = try await OS1API.health()
            _ = try await OS1API.sessions()
            checkResult = "Connected — auth OK."
        } catch {
            checkResult = await Reachability.describe(error)
        }
    }
}
