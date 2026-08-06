import SwiftUI

#if os(macOS)
extension Notification.Name {
    /// Posted by the File > New Session menu command (Cmd+N); the sessions
    /// list opens its new-session sheet in response.
    static let os1NewSession = Notification.Name("os1.newSession")
}
#endif

@main
struct OS1App: App {
    init() {
        // The shared cache is what carries repo icons across launches (see
        // `RepoImageCache`), and its stock disk budget is small enough that a
        // few sessions' worth of REST traffic evicts them — which showed up
        // as tiles, and the Settings button wearing one, drawing their
        // fallback on every cold start. Raising the ceiling keeps the
        // existing store and its entries; only lowering it evicts.
        URLCache.shared.memoryCapacity = 8 * 1024 * 1024
        URLCache.shared.diskCapacity = 64 * 1024 * 1024
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
        #if os(macOS)
        .defaultSize(width: 920, height: 720)
        .commands {
            // Cmd+N composes a new session instead of opening a new window.
            CommandGroup(replacing: .newItem) {
                Button("New Session") {
                    NotificationCenter.default.post(name: .os1NewSession, object: nil)
                }
                .keyboardShortcut("n", modifiers: .command)
            }
        }
        #endif

        #if os(macOS)
        // Real macOS Settings scene (App menu > Settings…, Cmd+,) hosting the
        // System Settings-style split view. The in-window settings sheet the
        // iOS app uses is not a Mac pattern.
        Settings {
            MacSettingsView()
        }
        .windowResizability(.contentMinSize)
        #endif
    }
}

struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage("os1.appearance") private var appearance = "system"
    @State private var config = ServerConfig.shared
    @State private var showedInitialSettings = false
    @State private var showSettings = false

    var body: some View {
        SessionsListView()
            .tint(OS1VisualStyle.accent)
            .background(OS1VisualStyle.background.ignoresSafeArea())
            .preferredColorScheme(preferredColorScheme)
            .sheet(isPresented: $showSettings) {
                #if os(macOS)
                // First-run connect flow only; day-to-day settings live in
                // the Settings scene (Cmd+,).
                ConnectionOnboardingSheet()
                #else
                SettingsView()
                #endif
            }
            .onAppear {
                if !config.isConfigured && !showedInitialSettings {
                    showedInitialSettings = true
                    showSettings = true
                }
            }
            .task {
                // Devices signed in before the app stored the GitHub login
                // (pre-07-23 builds) hold a valid token but an empty login —
                // backfill it from the server so the avatar can resolve.
                let authContext = NativePreferences.context()
                if config.isConfigured, config.githubLogin.isEmpty,
                   let status = try? await OS1API.authStatus(),
                   status.authenticated == true,
                   NativePreferences.context() == authContext {
                    if let login = status.login, !login.isEmpty {
                        config.githubLogin = login
                    }
                    if let name = status.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                       !name.isEmpty {
                        config.userName = String(name.split(separator: " ").first!)
                    } else if let login = status.login, !login.isEmpty {
                        config.userName = login
                    }
                }
            }
            .task(id: preferenceHydrationID) {
                guard scenePhase == .active else { return }
                while !Task.isCancelled {
                    await NativePreferences.hydrate()
                    await HideStore.shared.hydrate()
                    await PinStore.shared.hydrate()
                    await ReadsStore.shared.hydrate()
                    try? await Task.sleep(for: .seconds(30))
                }
            }
            // Coming back from Safari/GitHub after approving the device code:
            // poll right away so the sign-in lands the moment we're foreground
            // (also revives a poll loop that died with the process).
            .onChange(of: scenePhase) { _, phase in
                if phase == .active {
                    GitHubSignIn.shared.nudge()
                }
            }
            #if os(macOS)
            .frame(minWidth: 520, minHeight: 560)
            #endif
    }

    private var preferredColorScheme: ColorScheme? {
        switch appearance {
        case "light": .light
        case "dark": .dark
        default: nil
        }
    }

    private var preferenceHydrationID: String {
        "\(scenePhase)|\(config.baseURLString)|\(config.userName)|\(config.githubLogin)|\(config.token.hashValue)"
    }
}
