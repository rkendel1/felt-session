import Foundation
import Observation

/// GitHub device-flow sign-in against the Open Session server. The server owns
/// the OAuth app: we start a flow (`/api/auth/device`), show the user code,
/// and poll (`/api/auth/device/poll`, `native: true`) until GitHub confirms —
/// the server then mints its own web-session token and returns it in the body
/// (native clients can't use the HttpOnly cookie). That token goes into the
/// keychain via ServerConfig and rides as `Authorization: Bearer`.
@MainActor
enum GitHubAuth {
    struct DeviceFlowStart: Decodable {
        let deviceCode: String
        let userCode: String
        let verificationUri: String
        let interval: Int?
        let expiresIn: Int?
        let error: String?
    }

    struct PollResponse: Decodable {
        let status: String?
        let login: String?
        let name: String?
        let token: String?
        let interval: Int?
        let error: String?
    }

    enum AuthError: LocalizedError {
        case notConfigured
        case server(String)
        /// 5xx from the proxy — the backend is briefly away (deploy, hot
        /// reload, restart). Retryable; must never end a pending sign-in.
        case transient(String)

        var errorDescription: String? {
            switch self {
            case .notConfigured: "Set the server URL first."
            case .server(let message): message
            case .transient(let message): message
            }
        }
    }

    static func start() async throws -> DeviceFlowStart {
        let flow: DeviceFlowStart = try await post("/api/auth/device", body: [:])
        if let error = flow.error, !error.isEmpty { throw AuthError.server(error) }
        return flow
    }

    /// Polls until sign-in completes, the flow expires, or the task is
    /// cancelled. On success the token + identity are already stored. The
    /// deadline is passed in (not derived from `expiresIn`) so a resumed
    /// flow keeps its original expiry.
    static func waitForAuthorization(
        _ flow: DeviceFlowStart,
        until deadline: Date,
        pollImmediately: Bool = false,
        onPoll: ((String) -> Void)? = nil
    ) async throws -> String {
        var interval = TimeInterval(max(flow.interval ?? 5, 1))
        // The server polls GitHub itself and parks the outcome, so our polls
        // only hit our own server — an immediate poll on resume is cheap and
        // makes the sign-in land the moment the person returns to the app.
        var skipSleep = pollImmediately
        while Date() < deadline {
            if skipSleep {
                skipSleep = false
            } else {
                try await Task.sleep(for: .seconds(interval))
            }
            try Task.checkCancellation()
            let poll: PollResponse
            do {
                poll = try await post(
                    "/api/auth/device/poll",
                    body: ["deviceCode": flow.deviceCode, "native": true]
                )
            } catch is URLError {
                // Entering the code happens outside the app (Safari/GitHub), so
                // a poll is often in flight when iOS suspends us and fails with
                // a network error on resume. That's not a failed sign-in — keep
                // polling until the code expires.
                onPoll?("server unreachable — retrying")
                continue
            } catch AuthError.transient {
                onPoll?("server hiccup — retrying")
                continue
            } catch is DecodingError {
                onPoll?("bad response — retrying")
                continue
            }
            onPoll?(poll.status ?? "pending")
            switch poll.status {
            case "ok":
                guard let token = poll.token, !token.isEmpty else {
                    throw AuthError.server("Server returned no token — is it up to date?")
                }
                ServerConfig.shared.token = token
                ServerConfig.shared.githubLogin = poll.login ?? ""
                if let name = poll.name?.trimmingCharacters(in: .whitespacesAndNewlines),
                   !name.isEmpty {
                    // First name only, like the web picker — sessions store
                    // first names in startedBy, so this keeps "mine" filters
                    // and prompt attribution consistent across clients.
                    ServerConfig.shared.userName = String(name.split(separator: " ").first!)
                } else if let login = poll.login, !login.isEmpty {
                    // Never retain the previous account's display identity if
                    // GitHub omits a profile name for this account.
                    ServerConfig.shared.userName = login
                }
                return poll.login ?? "github"
            case "slow_down":
                interval = TimeInterval(max(poll.interval ?? Int(interval) + 5, Int(interval)))
            case "pending", nil:
                continue
            default:
                throw AuthError.server(poll.error ?? "Sign-in failed.")
            }
        }
        throw AuthError.server("The sign-in code expired — try again.")
    }

    private static func post<T: Decodable>(_ path: String, body: [String: Any]) async throws -> T {
        guard let base = ServerConfig.shared.baseURL,
              let url = URL(string: base.absoluteString + path)
        else { throw AuthError.notConfigured }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        let (data, response) = try await URLSession.shared.data(for: request)
        if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
            // 502/503 come from Caddy while the backend hot-reloads or
            // restarts — routine on this server, and exactly when a poll is
            // likely to be in flight. Transient, not a failed sign-in.
            if http.statusCode >= 500 {
                throw AuthError.transient("Server returned HTTP \(http.statusCode).")
            }
            // The server sends {error} bodies with 400s — surface them.
            if let decoded = try? JSONDecoder().decode(PollResponse.self, from: data),
               let error = decoded.error {
                throw AuthError.server(error)
            }
            throw AuthError.server("Server returned HTTP \(http.statusCode).")
        }
        return try JSONDecoder().decode(T.self, from: data)
    }
}

/// Persisted shape of an in-flight device flow, so the sign-in survives the
/// app being jettisoned while the person is over in Safari entering the code.
private struct PendingDeviceFlow: Codable {
    let deviceCode: String
    let userCode: String
    let verificationUri: String
    let interval: Int
    let expiresAt: Date
}

/// Owns the device-flow sign-in OUTSIDE any view lifecycle. Entering the code
/// happens in Safari/the GitHub app, and iOS is free to suspend or kill us in
/// the meantime — so the code prompt and the polling loop must not live in a
/// sheet's @State. The Settings sheet just renders whatever is in here; the
/// flow itself survives the sheet closing, the app backgrounding, and even a
/// relaunch (the pending flow is persisted until it expires, ~15 min).
@MainActor
@Observable
final class GitHubSignIn {
    static let shared = GitHubSignIn()

    /// The flow whose code the UI should show (nil = no sign-in running).
    private(set) var flow: GitHubAuth.DeviceFlowStart?
    private(set) var expiresAt: Date?
    private(set) var starting = false
    var error: String?
    /// Proof-of-life breadcrumb for the poll loop, shown under the code in
    /// Settings — makes "is it still checking?" visible on-device.
    private(set) var lastPollAt: Date?
    private(set) var lastPollNote: String?

    /// Rolling on-device diagnostic log (persisted, shown in Settings).
    /// Answers "what did the sign-in do?" on devices we can't attach a
    /// debugger to: process relaunches, resume outcomes, poll-state changes,
    /// and the exact error that cleared the code screen.
    private static let diagKey = "os1.signInDiag"
    private(set) var diagnostics: [String] =
        UserDefaults.standard.stringArray(forKey: GitHubSignIn.diagKey) ?? []

    private func diag(_ line: String) {
        let stamp = Date().formatted(date: .omitted, time: .standard)
        diagnostics.append("\(stamp) \(line)")
        if diagnostics.count > 40 { diagnostics.removeFirst(diagnostics.count - 40) }
        UserDefaults.standard.set(diagnostics, forKey: Self.diagKey)
    }

    private func notePoll(_ note: String) {
        if note != lastPollNote { diag("poll: \(note)") }
        lastPollAt = Date()
        lastPollNote = note
    }

    private var pollTask: Task<Void, Never>?
    private static let pendingKey = "os1.pendingDeviceFlow"

    private init() {
        let build = Bundle.main.infoDictionary?["CFBundleVersion"] as? String ?? "?"
        diag("app launch (build \(build))")
        resumePersisted()
        // Dev harness: simulator lifecycle tests set OS1_AUTOSIGNIN=1
        // (SIMCTL_CHILD_*) to start a flow on launch without tapping the UI.
        // A pending flow restored above takes precedence.
        if ProcessInfo.processInfo.environment["OS1_AUTOSIGNIN"] == "1", flow == nil {
            start()
        }
    }

    func start() {
        pollTask?.cancel()
        finish()
        error = nil
        lastPollAt = nil
        lastPollNote = nil
        starting = true
        diag("sign-in started")
        pollTask = Task {
            do {
                let started = try await GitHubAuth.start()
                let deadline = Date().addingTimeInterval(TimeInterval(started.expiresIn ?? 900))
                starting = false
                flow = started
                expiresAt = deadline
                persist(started, expiresAt: deadline)
                diag("code \(started.userCode) shown + persisted")
                let login = try await GitHubAuth.waitForAuthorization(started, until: deadline) {
                    [weak self] in self?.notePoll($0)
                }
                diag("signed in as @\(login)")
            } catch is CancellationError {
                return // superseded by a newer start/nudge — state stays
            } catch {
                // Signing in is often the first thing a new device does, so
                // this is where an off-the-tailnet server first shows up.
                self.error = await Reachability.describe(error)
                diag("failed: \(error.localizedDescription)")
            }
            starting = false
            finish()
        }
    }

    /// Stop polling and forget the pending flow (explicit user cancel).
    func cancel() {
        diag("cancelled by user")
        pollTask?.cancel()
        pollTask = nil
        starting = false
        finish()
    }

    /// Re-arm the poll loop with an immediate first poll. Called on app
    /// foregrounding: the person likely just approved the code on GitHub, and
    /// the previous loop may have died with the process or be mid-sleep.
    /// Idempotent — the server parks the flow's outcome, so an extra poll
    /// just re-asks "is my flow done?".
    func nudge() {
        guard let flow, let expiresAt else { return }
        diag("nudge — foreground, re-arming poll")
        pollTask?.cancel()
        pollTask = Task {
            do {
                let login = try await GitHubAuth.waitForAuthorization(
                    flow, until: expiresAt, pollImmediately: true
                ) { [weak self] in self?.notePoll($0) }
                diag("signed in as @\(login)")
            } catch is CancellationError {
                return // superseded by a newer nudge/start — state stays
            } catch {
                self.error = error.localizedDescription
                diag("failed: \(error.localizedDescription)")
            }
            finish()
        }
    }

    private func finish() {
        flow = nil
        expiresAt = nil
        pollTask = nil
        UserDefaults.standard.removeObject(forKey: Self.pendingKey)
    }

    private func persist(_ flow: GitHubAuth.DeviceFlowStart, expiresAt: Date) {
        let pending = PendingDeviceFlow(
            deviceCode: flow.deviceCode,
            userCode: flow.userCode,
            verificationUri: flow.verificationUri,
            interval: flow.interval ?? 5,
            expiresAt: expiresAt
        )
        if let data = try? JSONEncoder().encode(pending) {
            UserDefaults.standard.set(data, forKey: Self.pendingKey)
        }
    }

    /// Pick an unexpired flow back up after a relaunch mid-sign-in.
    private func resumePersisted() {
        guard let data = UserDefaults.standard.data(forKey: Self.pendingKey) else { return }
        guard let pending = try? JSONDecoder().decode(PendingDeviceFlow.self, from: data),
              pending.expiresAt > Date()
        else {
            diag("resume: pending flow expired/unreadable — discarded")
            UserDefaults.standard.removeObject(forKey: Self.pendingKey)
            return
        }
        diag("resume: restored code \(pending.userCode), polling again")
        let restored = GitHubAuth.DeviceFlowStart(
            deviceCode: pending.deviceCode,
            userCode: pending.userCode,
            verificationUri: pending.verificationUri,
            interval: pending.interval,
            expiresIn: nil,
            error: nil
        )
        flow = restored
        expiresAt = pending.expiresAt
        pollTask = Task {
            do {
                let login = try await GitHubAuth.waitForAuthorization(
                    restored, until: pending.expiresAt, pollImmediately: true
                ) { [weak self] in self?.notePoll($0) }
                diag("signed in as @\(login)")
            } catch is CancellationError {
                return
            } catch {
                self.error = error.localizedDescription
                diag("failed: \(error.localizedDescription)")
            }
            finish()
        }
    }
}
