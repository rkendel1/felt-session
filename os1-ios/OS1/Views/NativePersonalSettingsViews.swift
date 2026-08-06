import SwiftUI

// Native personal settings use the same server preference keys as the web app
// where a preference follows a person between devices. Device alerts stay local.

struct NotificationsSettingsView: View {
    @AppStorage("os1.notifications.pushAlerts") private var pushAlerts = false
    @AppStorage("os1.notifications.completionSound") private var completionSound = "default"
    @AppStorage("os1.notifications.whenToNotify") private var whenToNotify = "background"
    @AppStorage("os1.notifications.needsInput") private var needsInputAlerts = true
    @AppStorage("os1.notifications.runComplete") private var runCompleteAlerts = true

    var body: some View {
        Form {
            Section {
                Toggle("Push alerts on this device", isOn: $pushAlerts)
                Picker("Completion sound", selection: $completionSound) {
                    Text("Default").tag("default")
                    Text("None").tag("none")
                }
                Picker("When to notify", selection: $whenToNotify) {
                    Text("Always").tag("always")
                    Text("When OS1 is in the background").tag("background")
                    Text("Never").tag("never")
                }
            } header: {
                Text("Alerts")
            } footer: {
                Text("These alert preferences apply only to this native OS1 app and device.")
            }

            Section("Events") {
                Toggle("Session needs input", isOn: $needsInputAlerts)
                Toggle("Session run completes", isOn: $runCompleteAlerts)
            }
        }
        .navigationTitle("Notifications")
        .onChange(of: pushAlerts) { _, enabled in
            guard enabled else { return }
            Task {
                if !(await NativeNotifications.requestAuthorization()) {
                    pushAlerts = false
                }
            }
        }
    }
}

struct ComposerSettingsView: View {
    @AppStorage("os1.composer.defaultModel") private var nativeDefaultModel = ""
    @AppStorage("os1.composer.sendKey") private var nativeSendKey = "enter"
    @AppStorage("os1.composer.busySend") private var nativeBusySend = "queue"
    @AppStorage("os1.composer.busySendMod") private var nativeBusySendMod = "steer"

    @State private var models: [SettingsModelOption] = []
    @State private var defaultModel = ""
    @State private var sendKey = "enter"
    @State private var busySend = "queue"
    @State private var busySendMod = "steer"
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?
    @State private var savedPrefs: [String: String] = [:]
    @State private var prefsLoaded = false

    var body: some View {
        Form {
            if loading {
                Section { ProgressView("Loading composer preferences…") }
            } else {
                if let error {
                    Section {
                        Text(error)
                            .foregroundStyle(.red)
                        Button("Try again") { Task { await load() } }
                    }
                }

                Section {
                    Picker("Default model", selection: $defaultModel) {
                        Text("No preference").tag("")
                        ForEach(models.filter { $0.id?.isEmpty == false }, id: \.id) { model in
                            Text(model.label ?? model.id ?? "Model").tag(model.id ?? "")
                        }
                    }
                } header: {
                    Text("New sessions")
                } footer: {
                    Text("New sessions use this model when available. No preference uses the workspace default.")
                }

                Section {
                    #if os(macOS)
                    Picker("Send messages with", selection: $sendKey) {
                        Text("Enter").tag("enter")
                        Text("Command/Control-Enter").tag("mod-enter")
                    }
                    #else
                    LabeledContent("Send messages with", value: "Return")
                    #endif
                    Picker("Send button while busy", selection: $busySend) {
                        Text("Queue for later").tag("queue")
                        Text("Steer the current run").tag("steer")
                    }
                    #if os(macOS)
                    if sendKey == "enter" {
                        Picker("Command/Control-Enter while busy", selection: $busySendMod) {
                            Text("Queue for later").tag("queue")
                            Text("Steer the current run").tag("steer")
                        }
                    }
                    #endif
                } header: {
                    Text("Sending")
                } footer: {
                    // The setting is only the default: the other verb is
                    // always one gesture away, and this is the only place
                    // that says so.
                    #if os(macOS)
                    Text("Queued messages wait until the agent has fully finished; steering folds them into the running turn at its next step. Hold the send button to use the other one for a single message.")
                    #else
                    Text("Queued messages wait until the agent has fully finished; steering folds them into the running turn at its next step. Touch and hold the send button to use the other one for a single message.")
                    #endif
                }

                Section {
                    Button(saving ? "Saving…" : "Save composer preferences") {
                        Task { await save() }
                    }
                    .disabled(!prefsLoaded || saving || currentPrefs == savedPrefs)
                    if let savedMessage {
                        Text(savedMessage)
                            .foregroundStyle(.green)
                    }
                }
            }
        }
        .navigationTitle("Composer")
        .task { await load() }
        .disabled(saving)
    }

    private func load() async {
        loading = true
        error = nil
        prefsLoaded = false
        do {
            let requestContext = NativePreferences.context()
            let prefs = try await SettingsAPI.uiPrefs(user: requestContext.user)
            guard NativePreferences.context() == requestContext else { loading = false; return }
            defaultModel = prefs["default-model"] ?? nativeDefaultModel
            sendKey = prefs["send-key"] == "mod-enter" ? "mod-enter" : "enter"
            busySend = prefs["busy-send"] == "steer" ? "steer" : "queue"
            busySendMod = prefs["busy-send-mod"] == "queue" ? "queue" : "steer"
            #if os(macOS)
            nativeSendKey = sendKey
            #endif
            nativeBusySend = busySend
            nativeBusySendMod = busySendMod
            savedPrefs = currentPrefs
            prefsLoaded = true
        } catch {
            self.error = error.localizedDescription
        }
        do {
            models = try await SettingsAPI.modelCatalog().models ?? []
        } catch {
            if self.error == nil { self.error = error.localizedDescription }
        }
        loading = false
    }

    private func save() async {
        saving = true
        error = nil
        savedMessage = nil
        do {
            let current = currentPrefs
            var patch: [String: String?] = [:]
            for (key, value) in current where savedPrefs[key] != value {
                patch[key] = value
            }
            guard !patch.isEmpty else { saving = false; return }
            let requestContext = NativePreferences.context()
            let response = try await SettingsAPI.updateUiPrefs(user: requestContext.user, prefs: patch)
            var confirmed = savedPrefs
            for (key, value) in current where patch.keys.contains(key) { confirmed[key] = value }
            confirmed.merge(response) { _, server in server }
            guard NativePreferences.apply(confirmed, for: requestContext) else {
                self.error = "Connection changed before preferences finished saving."
                saving = false
                return
            }
            defaultModel = confirmed["default-model"] ?? defaultModel
            sendKey = confirmed["send-key"] == "mod-enter" ? "mod-enter" : "enter"
            busySend = confirmed["busy-send"] == "steer" ? "steer" : "queue"
            busySendMod = confirmed["busy-send-mod"] == "queue" ? "queue" : "steer"
            nativeDefaultModel = defaultModel
            #if os(macOS)
            nativeSendKey = sendKey
            #endif
            nativeBusySend = busySend
            nativeBusySendMod = busySendMod
            savedPrefs = confirmed
            savedMessage = "Composer preferences saved."
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }

    private var currentPrefs: [String: String] {
        [
            "default-model": defaultModel,
            "send-key": sendKey,
            "busy-send": busySend,
            "busy-send-mod": busySendMod,
        ]
    }
}

struct AppearanceSettingsView: View {
    @AppStorage("os1.appearance") private var appearance = "system"
    @AppStorage("os1.appearance.turnActivity") private var nativeTurnActivity = "collapsed"
    @AppStorage("os1.desk.voice") private var deskVoice = "off"

    @State private var turnActivity = "collapsed"
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?
    @State private var savedTurnActivity = "auto"
    @State private var prefsLoaded = false

    var body: some View {
        Form {
            Section {
                Picker("Appearance", selection: $appearance) {
                    Text("System").tag("system")
                    Text("Light").tag("light")
                    Text("Dark").tag("dark")
                }
            } header: {
                Text("Theme")
            } footer: {
                Text("The selected native appearance is stored on this device.")
            }

            Section {
                if loading {
                    ProgressView("Loading session preferences…")
                } else {
                    Picker("Tool calls and messages", selection: $turnActivity) {
                        Text("Expand while running").tag("auto")
                        Text("Always expanded").tag("expanded")
                        Text("Always collapsed").tag("collapsed")
                    }
                    Button(saving ? "Saving…" : "Save session preference") {
                        Task { await saveTurnActivity() }
                    }
                    .disabled(!prefsLoaded || saving || turnActivity == savedTurnActivity)
                }
            } header: {
                Text("Session")
            } footer: {
                Text("Controls how a turn's working activity is folded in a session. Sidebar settings are not shown because the native app has no web sidebar.")
            }

            Section {
                Toggle("Desk voice", isOn: Binding(
                    get: { deskVoice == "on" },
                    set: { enabled in
                        deskVoice = enabled ? "on" : "off"
                        pushDeskVoice(enabled)
                    }
                ))
            } footer: {
                Text("Talk to your Desk with a live voice call. Uses the server's OpenAI key.")
            }

            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
            if let savedMessage {
                Section { Text(savedMessage).foregroundStyle(.green) }
            }
        }
        .navigationTitle("Appearance")
        .task { await load() }
        .disabled(saving)
    }

    /// Fire-and-forget: the toggle is already reflected locally via
    /// `@AppStorage`, this just lets other devices pick it up.
    private func pushDeskVoice(_ enabled: Bool) {
        let user = NativePreferences.context().user
        Task {
            _ = try? await SettingsAPI.updateUiPrefs(
                user: user,
                prefs: ["desk-voice": enabled ? "on" : "off"]
            )
        }
    }

    private func load() async {
        loading = true
        error = nil
        prefsLoaded = false
        do {
            let requestContext = NativePreferences.context()
            let prefs = try await SettingsAPI.uiPrefs(user: requestContext.user)
            guard NativePreferences.context() == requestContext else { loading = false; return }
            if ["auto", "expanded", "collapsed"].contains(prefs["turn-activity"]) {
                turnActivity = prefs["turn-activity"] ?? "collapsed"
                nativeTurnActivity = turnActivity
            } else {
                turnActivity = nativeTurnActivity
            }
            savedTurnActivity = turnActivity
            prefsLoaded = true
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func saveTurnActivity() async {
        saving = true
        error = nil
        savedMessage = nil
        do {
            let requestContext = NativePreferences.context()
            let selected = turnActivity
            let response = try await SettingsAPI.updateUiPrefs(
                user: requestContext.user,
                prefs: ["turn-activity": selected]
            )
            var confirmed = response
            confirmed["turn-activity"] = response["turn-activity"] ?? selected
            guard NativePreferences.apply(confirmed, for: requestContext) else {
                self.error = "Connection changed before preferences finished saving."
                saving = false
                return
            }
            turnActivity = confirmed["turn-activity"] ?? selected
            nativeTurnActivity = turnActivity
            savedTurnActivity = turnActivity
            savedMessage = "Session preference saved."
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}

struct PersonalPromptSettingsView: View {
    @State private var prompt = ""
    @State private var savedPrompt = ""
    @State private var loading = true
    @State private var saving = false
    @State private var error: String?
    @State private var savedMessage: String?

    private let user = ServerConfig.shared.userName

    var body: some View {
        Form {
            if loading {
                Section { ProgressView("Loading personal prompt…") }
            } else {
                Section {
                    Text("Standing instructions are added to every interactive session you start. They follow your identity across devices and are not used for automations.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                    TextEditor(text: $prompt)
                        .frame(minHeight: 180)
                } header: {
                    Text("Instructions")
                } footer: {
                    Text("Leave this empty to turn off personal instructions.")
                }

                Section {
                    Button(saving ? "Saving…" : "Save personal prompt") {
                        Task { await save() }
                    }
                    .disabled(saving || prompt == savedPrompt)
                    Button("Clear personal prompt", role: .destructive) {
                        prompt = ""
                        Task { await save() }
                    }
                    .disabled(saving || prompt.isEmpty)
                    if prompt != savedPrompt, !saving {
                        Text("Unsaved changes")
                            .foregroundStyle(.secondary)
                    }
                    if let savedMessage {
                        Text(savedMessage).foregroundStyle(.green)
                    }
                }
            }

            if let error {
                Section {
                    Text(error).foregroundStyle(.red)
                    Button("Try again") { Task { await load() } }
                }
            }
        }
        .navigationTitle("Personal prompt")
        .task { await load() }
    }

    private func load() async {
        loading = true
        error = nil
        do {
            let result = try await SettingsAPI.personalPrompt(user: user)
            prompt = result
            savedPrompt = result
        } catch {
            self.error = error.localizedDescription
        }
        loading = false
    }

    private func save() async {
        saving = true
        error = nil
        savedMessage = nil
        do {
            let result = try await SettingsAPI.setPersonalPrompt(user: user, prompt: prompt)
            prompt = result
            savedPrompt = result
            savedMessage = result.isEmpty ? "Personal prompt cleared." : "Personal prompt saved."
        } catch {
            self.error = error.localizedDescription
        }
        saving = false
    }
}
