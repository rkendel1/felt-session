import AVFoundation
import Foundation
import Observation

/// Lifecycle states Desk's voice UI drives off of.
enum DeskVoiceState: String {
    case idle
    case connecting
    case listening
    case thinking
    case speaking
    case action
    case error

    /// The one spoken-status wording, shared by the call screen and the Desk
    /// header so the two can never drift apart.
    var label: String {
        switch self {
        case .idle: ""
        case .connecting: "Connecting…"
        case .listening: "Listening"
        case .thinking: "Thinking…"
        case .speaking: "Speaking"
        case .action: "Working…"
        case .error: "Voice call failed"
        }
    }
}

/// The line currently being spoken, streamed in as deltas arrive so the call
/// screen can show live captions. Finals overwrite the partial they complete.
struct DeskVoiceCaption: Equatable {
    enum Role { case user, assistant }

    var role: Role
    var text: String
}

/// A live voice conversation with OpenAI's Realtime API over a raw WebSocket
/// (no WebRTC — the app takes no third-party dependencies). Mic audio streams
/// up as base64 PCM16 frames, model audio streams down the same way, and tool
/// calls / transcripts relay through our own server (`desk-voice.ts`) so the
/// real OpenAI key never reaches the client.
@MainActor
@Observable
final class DeskVoiceEngine {
    private(set) var state: DeskVoiceState = .idle
    private(set) var errorMessage: String?

    /// Smoothed 0…1 loudness for the call orb: the mic while we're listening,
    /// the model's own voice while it speaks. Sampled off the realtime audio
    /// threads and republished at ~15Hz — never per audio buffer, which would
    /// re-render the call screen hundreds of times a second.
    private(set) var audioLevel: Float = 0
    /// Latest caption line, updated from transcript deltas during the call.
    private(set) var caption: DeskVoiceCaption?
    /// Mic muted locally: capture keeps running, frames stop going up.
    private(set) var muted = false {
        didSet { rt.muted = muted }
    }

    var active: Bool { state != .idle && state != .error }

    /// Realtime minutes are expensive; an abandoned call must die on its own.
    private static let idleTimeout: Duration = .seconds(180)

    private let engine = AVAudioEngine()
    /// State the Core Audio realtime tap/render callbacks touch — those run
    /// off the main actor and can't hop to it per frame, so this lives in a
    /// small `@unchecked Sendable` box rather than on `self`.
    private let rt = DeskVoiceAudioBridge()

    private var playerNode: AVAudioPlayerNode?
    private var receiveTask: Task<Void, Never>?
    private var idleTimer: Task<Void, Never>?
    private var levelTimer: Task<Void, Never>?
    private var transcriptChain: Task<Void, Never>?
    /// Transcript item the streaming caption is currently accumulating, so a
    /// delta for a new item starts a fresh line instead of appending to the
    /// last one.
    private var captionItemId: String?
    /// Distinguishes an intentional `stop()` from the socket dying under us —
    /// only the latter should flip `state` to `.error`.
    private var stopping = false

    func start() async {
        guard state == .idle || state == .error else { return }
        errorMessage = nil
        stopping = false
        caption = nil
        captionItemId = nil
        audioLevel = 0
        muted = false

        guard await requestMicPermission() else {
            fail("Microphone access is off. Enable it for OS1 in Settings to start a voice call.")
            return
        }

        state = .connecting

        let secret: OS1API.DeskVoiceSecret
        do {
            secret = try await OS1API.deskVoiceSecret()
        } catch {
            fail(error.localizedDescription)
            return
        }

        var components = URLComponents(string: "wss://api.openai.com/v1/realtime")
        components?.queryItems = [URLQueryItem(name: "model", value: secret.model)]
        guard let url = components?.url else {
            fail("Could not build the Realtime connection URL.")
            return
        }
        var request = URLRequest(url: url)
        request.setValue("Bearer \(secret.clientSecret)", forHTTPHeaderField: "Authorization")
        let task = URLSession.shared.webSocketTask(with: request)
        rt.webSocketTask = task
        task.resume()

        do {
            try configureAudioSession()
            try startAudioEngine()
        } catch {
            rt.webSocketTask = nil
            task.cancel(with: .goingAway, reason: nil)
            fail("Could not start audio: \(error.localizedDescription)")
            return
        }

        state = .listening
        armIdleTimer()
        startLevelSampling()

        receiveTask = Task { [weak self] in
            await self?.receiveLoop(task)
        }
    }

    func stop() {
        guard state != .idle else { return }
        stopping = true
        teardown(resetError: true)
    }

    /// Local mute. The uplink simply stops carrying frames — server-side VAD
    /// hears silence, so the model waits rather than being told anything.
    func toggleMute() {
        guard active else { return }
        muted.toggle()
        if muted { audioLevel = 0 }
    }

    // MARK: - Permission

    private func requestMicPermission() async -> Bool {
        #if os(iOS)
        await AVAudioApplication.requestRecordPermission()
        #else
        await withCheckedContinuation { continuation in
            AVCaptureDevice.requestAccess(for: .audio) { granted in
                continuation.resume(returning: granted)
            }
        }
        #endif
    }

    // MARK: - Audio setup

    private func configureAudioSession() throws {
        #if os(iOS)
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord, mode: .voiceChat,
            options: [.defaultToSpeaker, .allowBluetoothHFP]
        )
        try session.setActive(true)
        #endif
    }

    private func startAudioEngine() throws {
        let inputNode = engine.inputNode
        // Echo cancellation is essential once the model's voice is coming
        // out of the speaker while we're still listening — must happen
        // before reading input/output formats, since enabling it changes
        // them.
        try? inputNode.setVoiceProcessingEnabled(true)

        let inputFormat = inputNode.outputFormat(forBus: 0)
        guard let uplinkFormat = AVAudioFormat(
            commonFormat: .pcmFormatInt16, sampleRate: 24_000, channels: 1, interleaved: true
        ) else {
            throw DeskVoiceEngineError.audioSetup
        }
        guard let converter = AVAudioConverter(from: inputFormat, to: uplinkFormat) else {
            throw DeskVoiceEngineError.audioSetup
        }
        rt.uplinkConverter = converter
        rt.uplinkFormat = uplinkFormat

        // ~0.1s of frames at the input's native rate per tap callback.
        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate * 0.1)
        let rt = self.rt
        inputNode.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) { buffer, _ in
            rt.handleCapturedBuffer(buffer)
        }

        guard let playbackFormat = AVAudioFormat(
            commonFormat: .pcmFormatFloat32, sampleRate: 24_000, channels: 1, interleaved: false
        ) else {
            throw DeskVoiceEngineError.audioSetup
        }
        let player = AVAudioPlayerNode()
        engine.attach(player)
        engine.connect(player, to: engine.mainMixerNode, format: playbackFormat)
        // Metered at the player rather than where deltas are decoded: buffers
        // are scheduled ahead of playback, so metering on arrival would run
        // the orb ahead of the voice coming out of the speaker.
        player.installTap(onBus: 0, bufferSize: 1_024, format: playbackFormat) { buffer, _ in
            rt.noteOutputLevel(buffer)
        }
        playerNode = player
        rt.playerNode = player
        rt.playbackFormat = playbackFormat
        rt.onPlaybackDrained = { [weak self] in
            Task { @MainActor in
                guard let self, self.state == .speaking else { return }
                self.state = .listening
            }
        }

        engine.prepare()
        try engine.start()
        player.play()
    }

    // MARK: - WebSocket receive loop

    private func receiveLoop(_ task: URLSessionWebSocketTask) async {
        while true {
            do {
                let message = try await task.receive()
                let data: Data?
                switch message {
                case .string(let text): data = Data(text.utf8)
                case .data(let raw): data = raw
                @unknown default: data = nil
                }
                guard let data else { continue }
                await handle(data)
            } catch {
                // The server cancels our socket on a normal stop(); only a
                // socket that dies out from under an active call is an error.
                if !stopping {
                    fail("Connection lost")
                }
                return
            }
        }
    }

    /// Frames are small JSON (base64 audio nested inside), but parsing still
    /// happens off the main actor so a burst of deltas can't contend with UI
    /// work — only the resulting state changes hop back.
    private func handle(_ data: Data) async {
        let event = await Task.detached(priority: .userInitiated) {
            (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        }.value
        guard let event, let type = event["type"] as? String else { return }

        switch type {
        case "input_audio_buffer.speech_started":
            // The server cancels its own in-flight response; dropping queued
            // local playback so the model doesn't keep talking over us is
            // our job.
            rt.stopPlayback()
            state = .listening
            armIdleTimer()

        case "response.created":
            state = .thinking
            armIdleTimer()

        case "response.output_audio.delta", "response.audio.delta":
            if let delta = event["delta"] as? String {
                rt.schedulePlayback(base64PCM16: delta)
                state = .speaking
            }

        case "response.done":
            if state != .speaking {
                state = .listening
            }
            armIdleTimer()

        case "conversation.item.input_audio_transcription.delta":
            appendCaption(event, role: .user)

        case "response.output_audio_transcript.delta", "response.audio_transcript.delta":
            appendCaption(event, role: .assistant)

        case "conversation.item.input_audio_transcription.completed":
            if let itemId = event["item_id"] as? String,
               let transcript = event["transcript"] as? String {
                setCaption(itemId: itemId, role: .user, text: transcript)
                mirrorTranscript(id: "voice-\(itemId)", role: "user", text: transcript)
            }

        case "response.output_audio_transcript.done", "response.audio_transcript.done":
            if let itemId = event["item_id"] as? String,
               let transcript = event["transcript"] as? String {
                setCaption(itemId: itemId, role: .assistant, text: transcript)
                mirrorTranscript(id: "voice-\(itemId)", role: "assistant", text: transcript)
            }

        case "response.function_call_arguments.done":
            await handleFunctionCall(event)

        case "error":
            let message = (event["error"] as? [String: Any])?["message"] as? String
                ?? event["message"] as? String
                ?? "Realtime connection error"
            fail(message)

        default:
            break
        }
    }

    private func handleFunctionCall(_ event: [String: Any]) async {
        guard let callId = event["call_id"] as? String,
              let name = event["name"] as? String
        else { return }
        state = .action
        armIdleTimer()

        let argumentsString = event["arguments"] as? String ?? "{}"
        let args = (try? JSONSerialization.jsonObject(
            with: Data(argumentsString.utf8)
        )) as? [String: Any] ?? [:]

        let output: String
        do {
            output = try await OS1API.deskVoiceTool(callId: callId, name: name, args: args)
        } catch {
            if let data = try? JSONSerialization.data(withJSONObject: ["error": error.localizedDescription]),
               let text = String(data: data, encoding: .utf8) {
                output = text
            } else {
                output = "{\"error\":\"Tool call failed\"}"
            }
        }

        rt.send([
            "type": "conversation.item.create",
            "item": ["type": "function_call_output", "call_id": callId, "output": output],
        ])
        rt.send(["type": "response.create"])
    }

    // MARK: - Captions

    /// Deltas for the item already on screen extend it; anything else starts a
    /// new line, which is what makes the caption follow the turn-taking.
    private func appendCaption(_ event: [String: Any], role: DeskVoiceCaption.Role) {
        guard let delta = event["delta"] as? String, !delta.isEmpty else { return }
        let itemId = event["item_id"] as? String
        if itemId != captionItemId || caption?.role != role {
            captionItemId = itemId
            caption = DeskVoiceCaption(role: role, text: delta)
        } else {
            caption?.text.append(delta)
        }
    }

    private func setCaption(itemId: String, role: DeskVoiceCaption.Role, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        captionItemId = itemId
        caption = DeskVoiceCaption(role: role, text: trimmed)
    }

    // MARK: - Transcript mirroring

    /// Chained on `transcriptChain` so rapid finals (a quick back-and-forth)
    /// can't land on the server out of order.
    private func mirrorTranscript(id: String, role: String, text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let previous = transcriptChain
        transcriptChain = Task { [id, role, trimmed] in
            _ = await previous?.value
            do {
                try await OS1API.deskVoiceTranscript(entries: [(id: id, role: role, text: trimmed)])
            } catch {
                print("DeskVoiceEngine: transcript mirror failed: \(error)")
            }
        }
    }

    // MARK: - Level sampling

    /// Polls the realtime audio threads' latest loudness and eases the
    /// published value toward it. Polling (rather than pushing from the taps)
    /// is what keeps ~100 buffers/second from becoming ~100 view updates.
    private func startLevelSampling() {
        levelTimer?.cancel()
        levelTimer = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .milliseconds(66))
                guard !Task.isCancelled, let self, self.active else { return }
                let target = self.muted && self.state != .speaking
                    ? 0
                    : self.rt.currentLevel(speaking: self.state == .speaking)
                // Ease toward the reading so the orb glides rather than jitters.
                let eased = self.audioLevel + (target - self.audioLevel) * 0.45
                if abs(eased - self.audioLevel) > 0.004 {
                    self.audioLevel = eased
                }
            }
        }
    }

    // MARK: - Idle timeout

    private func armIdleTimer() {
        idleTimer?.cancel()
        idleTimer = Task { [weak self] in
            try? await Task.sleep(for: Self.idleTimeout)
            guard !Task.isCancelled else { return }
            self?.idleTimedOut()
        }
    }

    private func idleTimedOut() {
        guard active else { return }
        stop()
    }

    // MARK: - Teardown

    private func fail(_ message: String) {
        errorMessage = message
        state = .error
        teardown(resetError: false)
    }

    /// Shared by `stop()` and the error path — must be safe to call more
    /// than once (deinit-safety: everything here is idempotent).
    private func teardown(resetError: Bool) {
        receiveTask?.cancel()
        receiveTask = nil
        idleTimer?.cancel()
        idleTimer = nil
        levelTimer?.cancel()
        levelTimer = nil
        transcriptChain?.cancel()
        transcriptChain = nil

        engine.inputNode.removeTap(onBus: 0)
        playerNode?.removeTap(onBus: 0)
        if engine.isRunning {
            engine.stop()
        }
        playerNode?.stop()
        playerNode = nil
        audioLevel = 0
        rt.resetLevels()

        rt.playerNode = nil
        rt.uplinkConverter = nil
        rt.uplinkFormat = nil
        rt.playbackFormat = nil
        rt.onPlaybackDrained = nil
        rt.webSocketTask?.cancel(with: .goingAway, reason: nil)
        rt.webSocketTask = nil

        #if os(iOS)
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        #endif

        if resetError {
            state = .idle
            errorMessage = nil
            caption = nil
            captionItemId = nil
            muted = false
        }
    }
}

private enum DeskVoiceEngineError: Error {
    case audioSetup
}

/// Mutable state the Core Audio realtime tap and player-completion callbacks
/// touch, kept off the `@MainActor` so those callbacks never need to hop.
/// `@unchecked Sendable` is deliberate: `webSocketTask.send` is documented
/// thread-safe, the converter/format properties are set once before the tap
/// starts and only read from it afterward, and `scheduledCount` is guarded by
/// its own lock.
private final class DeskVoiceAudioBridge: @unchecked Sendable {
    var webSocketTask: URLSessionWebSocketTask?
    var uplinkConverter: AVAudioConverter?
    var uplinkFormat: AVAudioFormat?
    var playerNode: AVAudioPlayerNode?
    var playbackFormat: AVAudioFormat?
    /// Fired on the main actor when the last scheduled playback buffer
    /// finishes, so the engine can flip `speaking` back to `listening`.
    var onPlaybackDrained: (@Sendable () -> Void)?
    /// Set from the main actor, read on the capture thread — a plain `Bool`
    /// load/store, and a frame either side of the flip is inaudible.
    var muted = false

    private let scheduledCount = LockedCounter()
    private let inputLevel = LockedLevel()
    private let outputLevel = LockedLevel()

    /// Whoever is talking drives the orb: the model while it speaks, the mic
    /// the rest of the time.
    func currentLevel(speaking: Bool) -> Float {
        speaking ? outputLevel.value : inputLevel.value
    }

    func resetLevels() {
        inputLevel.value = 0
        outputLevel.value = 0
    }

    /// Runs on the player's tap thread.
    func noteOutputLevel(_ buffer: AVAudioPCMBuffer) {
        guard let channel = buffer.floatChannelData, buffer.frameLength > 0 else { return }
        let samples = channel[0]
        var sum: Float = 0
        for index in 0..<Int(buffer.frameLength) {
            let sample = samples[index]
            sum += sample * sample
        }
        outputLevel.value = Self.normalize(sqrt(sum / Float(buffer.frameLength)))
    }

    /// Speech RMS sits well below full scale, so scale it into a range the orb
    /// can actually show, then clamp.
    static func normalize(_ rms: Float) -> Float {
        min(1, max(0, rms * 5.5))
    }

    /// Runs on Core Audio's realtime tap thread — convert to PCM16 mono
    /// 24kHz and ship it upstream. Server-side VAD handles turn-taking, so
    /// this only ever appends; it never sends a commit.
    func handleCapturedBuffer(_ buffer: AVAudioPCMBuffer) {
        guard let converter = uplinkConverter, let uplinkFormat else { return }
        let ratio = uplinkFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 16
        guard let outBuffer = AVAudioPCMBuffer(pcmFormat: uplinkFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var conversionError: NSError?
        let status = converter.convert(to: outBuffer, error: &conversionError) { _, inputStatus in
            if consumed {
                inputStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            inputStatus.pointee = .haveData
            return buffer
        }
        guard status != .error,
              outBuffer.frameLength > 0,
              let int16 = outBuffer.int16ChannelData
        else { return }

        var sum: Float = 0
        for index in 0..<Int(outBuffer.frameLength) {
            let sample = Float(int16[0][index]) / 32_768.0
            sum += sample * sample
        }
        inputLevel.value = Self.normalize(sqrt(sum / Float(outBuffer.frameLength)))

        // Muted still captures (and still meters, so the level dies visibly) —
        // it just stops anything leaving the device.
        guard !muted else { return }
        let byteCount = Int(outBuffer.frameLength) * MemoryLayout<Int16>.size
        let audioData = Data(bytes: UnsafeRawPointer(int16[0]), count: byteCount)
        send(["type": "input_audio_buffer.append", "audio": audioData.base64EncodedString()])
    }

    /// Decode a base64 PCM16 mono 24kHz delta into Float32 and schedule it.
    func schedulePlayback(base64PCM16: String) {
        guard let playerNode, let playbackFormat,
              let raw = Data(base64Encoded: base64PCM16), !raw.isEmpty
        else { return }
        let frameCount = raw.count / MemoryLayout<Int16>.size
        guard frameCount > 0,
              let buffer = AVAudioPCMBuffer(pcmFormat: playbackFormat, frameCapacity: AVAudioFrameCount(frameCount)),
              let floatChannel = buffer.floatChannelData
        else { return }
        buffer.frameLength = AVAudioFrameCount(frameCount)

        raw.withUnsafeBytes { (rawBytes: UnsafeRawBufferPointer) in
            let samples = rawBytes.bindMemory(to: Int16.self)
            let out = floatChannel[0]
            for index in 0..<frameCount {
                out[index] = Float(samples[index]) / 32768.0
            }
        }

        scheduledCount.increment()
        playerNode.scheduleBuffer(buffer) { [weak self] in
            guard let self else { return }
            if self.scheduledCount.decrementAndGet() <= 0 {
                self.onPlaybackDrained?()
            }
        }
    }

    /// Barge-in: drop everything queued so the model's old response stops
    /// coming out of the speaker immediately.
    func stopPlayback() {
        playerNode?.stop()
        scheduledCount.reset()
        outputLevel.value = 0
        // `stop()` halts playback state on the node; re-arm `play()` so
        // subsequently scheduled buffers actually play.
        playerNode?.play()
    }

    func send(_ frame: [String: Any]) {
        guard let webSocketTask,
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        webSocketTask.send(.string(text)) { _ in }
    }
}

/// A lock-guarded `Float`, written from the realtime audio taps and read by
/// the level sampler on the main actor.
private final class LockedLevel: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: Float = 0

    var value: Float {
        get {
            lock.lock()
            defer { lock.unlock() }
            return storage
        }
        set {
            lock.lock()
            storage = newValue
            lock.unlock()
        }
    }
}

/// A tiny lock-guarded counter — used instead of `OSAllocatedUnfairLock` to
/// avoid pinning to a specific `os` module availability for one integer.
private final class LockedCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var value = 0

    func increment() {
        lock.lock()
        value += 1
        lock.unlock()
    }

    func decrementAndGet() -> Int {
        lock.lock()
        value -= 1
        let result = value
        lock.unlock()
        return result
    }

    func reset() {
        lock.lock()
        value = 0
        lock.unlock()
    }
}
