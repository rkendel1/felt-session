import AVKit
import SwiftUI
#if canImport(UIKit)
import UIKit
#else
import AppKit
#endif

/// The agent's demo of a user-visible change, inline in the transcript where
/// it was published: a short screen recording, the writeup, and before/after
/// stills. The web viewer renders the same card in the session — until now the
/// walkthroughs an agent published from the phone were only visible from a
/// browser, which is a strange thing for the app the work was done in.
///
/// It reads as a raised card rather than a message, because it summarizes a
/// stretch of the conversation rather than continuing it.
struct WalkthroughCard: View {
    let walkthrough: SessionWalkthrough

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            header
            if let video = walkthrough.video, let url = OS1API.mediaURL(path: video) {
                WalkthroughVideo(url: url)
            }
            if !walkthrough.summary.isEmpty {
                MarkdownBody(walkthrough.summary)
            }
            ForEach(walkthrough.stills) { shot in
                WalkthroughShotView(shot: shot)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(OS1VisualStyle.panel, in: RoundedRectangle(cornerRadius: 14, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .stroke(OS1VisualStyle.border, lineWidth: 0.5)
        }
        // It ends in media where its neighbours end in text, so it needs more
        // room after it than between ordinary blocks.
        .padding(.bottom, 6)
    }

    private var header: some View {
        HStack(spacing: 6) {
            Image(systemName: "play.rectangle")
                .font(.system(size: 11, weight: .semibold))
            Text("Walkthrough")
                .font(.caption.weight(.semibold))
            if let by = walkthrough.publishedBy, !by.isEmpty {
                Text("· \(by)")
                    .font(.caption)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
            Spacer(minLength: 4)
            if let published = walkthrough.publishedDate {
                Text(published, format: .dateTime.month(.abbreviated).day().hour().minute())
                    .font(.caption2)
                    .foregroundStyle(OS1VisualStyle.textFaint)
            }
        }
        .foregroundStyle(OS1VisualStyle.textDim)
    }
}

/// The demo recording. `VideoPlayer` streams it over the same range-enabled
/// media route the web `<video>` uses, so it seeks without downloading first.
private struct WalkthroughVideo: View {
    let url: URL

    @State private var player: AVPlayer?

    var body: some View {
        VideoPlayer(player: player)
            .frame(height: 200)
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            .onAppear {
                guard player == nil else { return }
                player = AVPlayer(url: url)
            }
            // Deliberately not autoplaying: a transcript that starts talking
            // at you while you scroll past is worse than a tap.
            .onDisappear { player?.pause() }
    }
}

/// One before/after pair, stacked rather than side by side — at phone width
/// two half-width screenshots are too small to show what changed.
private struct WalkthroughShotView: View {
    let shot: WalkthroughShot

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let caption = shot.caption, !caption.isEmpty {
                Text(caption)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(OS1VisualStyle.textDim)
            }
            if let before = shot.before {
                labelled("Before", path: before)
            }
            if let after = shot.after {
                labelled("After", path: after)
            }
        }
    }

    private func labelled(_ label: String, path: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.system(size: 10, weight: .semibold))
                .foregroundStyle(OS1VisualStyle.textFaint)
            MediaImage(path: path)
        }
    }
}

/// A staged still, fetched with the session's credentials and tappable into
/// the same full-screen viewer transcript images use.
private struct MediaImage: View {
    let path: String

    @State private var data: Data?
    /// The still's own aspect ratio. `DataImage` renders `scaledToFill`, which
    /// crops a wide screenshot to whatever box it lands in — sizing the box to
    /// the image's ratio is what makes fill behave as fit, so a walkthrough
    /// shot is shown whole rather than with its right edge cut off.
    @State private var ratio: CGFloat?
    @State private var failed = false
    @State private var retryCount = 0

    var body: some View {
        Group {
            if let data {
                ExpandableDataImage(data: data)
                    .aspectRatio(ratio ?? 16 / 9, contentMode: .fit)
                    // A tall screenshot would otherwise take the whole screen
                    // and bury the rest of the walkthrough under it.
                    .frame(maxWidth: .infinity, maxHeight: 420)
                    .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            } else {
                Button { retryCount += 1 } label: {
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .fill(.fill.tertiary)
                        .frame(height: 120)
                        .overlay {
                            if failed {
                                Image(systemName: "arrow.clockwise")
                                    .foregroundStyle(.tertiary)
                            } else {
                                ProgressView().controlSize(.small)
                            }
                        }
                }
                .buttonStyle(.plain)
                .disabled(!failed)
            }
        }
        .task(id: "\(path)#\(retryCount)") {
            guard data == nil else { return }
            failed = false
            do {
                let loaded = try await OS1API.media(path: path)
                ratio = Self.aspectRatio(of: loaded)
                data = loaded
            } catch {
                failed = true
            }
        }
    }

    private static func aspectRatio(of data: Data) -> CGFloat? {
        #if canImport(UIKit)
        let size = UIImage(data: data)?.size
        #else
        let size = NSImage(data: data)?.size
        #endif
        guard let size, size.width > 0, size.height > 0 else { return nil }
        return size.width / size.height
    }
}
