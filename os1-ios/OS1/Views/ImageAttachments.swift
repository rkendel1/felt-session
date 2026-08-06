import SwiftUI
import PhotosUI
import CoreTransferable
import UniformTypeIdentifiers
#if canImport(UIKit)
import UIKit
#endif

/// Paperclip button that appends picked images to a binding. iOS picks from
/// the photo library (PhotosPicker); macOS opens the file panel — the natural
/// source on each platform.
struct AttachImagesButton: View {
    @Binding var images: [AttachedImage]
    var maxCount: Int = 6

    #if os(iOS)
    @State private var pickerItems: [PhotosPickerItem] = []
    #else
    @State private var importing = false
    #endif

    private var remaining: Int { max(0, maxCount - images.count) }

    var body: some View {
        #if os(iOS)
        PhotosPicker(
            selection: $pickerItems,
            maxSelectionCount: remaining,
            matching: .images
        ) {
            icon
        }
        // Plain, like the macOS branch: the default picker button style
        // tints the paperclip blue instead of leaving it secondary gray.
        .buttonStyle(.plain)
        .disabled(remaining == 0)
        .onChange(of: pickerItems) {
            guard !pickerItems.isEmpty else { return }
            let picked = pickerItems
            pickerItems = []
            Task {
                for item in picked {
                    guard let data = try? await item.loadTransferable(type: Data.self),
                          let image = AttachedImage(rawData: data)
                    else { continue }
                    if images.count < maxCount { images.append(image) }
                }
            }
        }
        #else
        Button {
            importing = true
        } label: {
            icon
        }
        .buttonStyle(.plain)
        .disabled(remaining == 0)
        .fileImporter(
            isPresented: $importing,
            allowedContentTypes: [.image],
            allowsMultipleSelection: true
        ) { result in
            guard case .success(let urls) = result else { return }
            for url in urls.prefix(remaining) {
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                guard let data = try? Data(contentsOf: url),
                      let image = AttachedImage(rawData: data)
                else { continue }
                images.append(image)
            }
        }
        #endif
    }

    private var icon: some View {
        Image(systemName: "paperclip")
            .font(.system(size: 17, weight: .medium))
            .foregroundStyle(.secondary)
            #if os(iOS)
            .frame(width: 44, height: 44)
            #else
            .frame(width: 27, height: 27)
            #endif
            .contentShape(Circle())
    }
}

/// Horizontal strip of attached-image thumbnails, each removable.
struct AttachedImagesRow: View {
    let images: [AttachedImage]
    let onRemove: (AttachedImage) -> Void

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(images) { image in
                    ZStack(alignment: .topTrailing) {
                        DataImage(data: image.jpegData)
                            .frame(width: 56, height: 56)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        Button {
                            onRemove(image)
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(.system(size: 15))
                                .symbolRenderingMode(.palette)
                                .foregroundStyle(.white, .black.opacity(0.6))
                        }
                        .buttonStyle(.plain)
                        .padding(2)
                    }
                }
            }
            .padding(.vertical, 2)
        }
    }
}

/// Renders encoded image bytes (or a `data:` URL) cross-platform.
struct DataImage: View {
    let data: Data

    init(data: Data) {
        self.data = data
    }

    init?(dataURL: String) {
        guard let data = Self.decode(dataURL: dataURL) else { return nil }
        self.data = data
    }

    static func decode(dataURL: String) -> Data? {
        guard let comma = dataURL.range(of: ";base64,"),
              dataURL.hasPrefix("data:image/")
        else { return nil }
        return Data(base64Encoded: String(dataURL[comma.upperBound...]))
    }

    var body: some View {
        #if canImport(UIKit)
        if let image = UIImage(data: data) {
            Image(uiImage: image).resizable().scaledToFill()
        } else {
            placeholder
        }
        #else
        if let image = NSImage(data: data) {
            Image(nsImage: image).resizable().scaledToFill()
        } else {
            placeholder
        }
        #endif
    }

    private var placeholder: some View {
        RoundedRectangle(cornerRadius: 10, style: .continuous)
            .fill(.fill.tertiary)
            .overlay {
                Image(systemName: "photo")
                    .foregroundStyle(.tertiary)
            }
    }
}

/// A sent conversation image that opens into the familiar full-screen iOS
/// viewer. Composer thumbnails deliberately stay non-expandable because their
/// primary interaction is removing the attachment before sending.
struct ExpandableDataImage: View {
    let data: Data

    #if os(iOS)
    @State private var previewPresented = false
    #endif

    init(data: Data) {
        self.data = data
    }

    init?(dataURL: String) {
        guard let data = DataImage.decode(dataURL: dataURL) else { return nil }
        self.data = data
    }

    var body: some View {
        #if os(iOS)
        Button {
            previewPresented = true
        } label: {
            DataImage(data: data)
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Open image")
        .accessibilityHint("Shows the image full screen")
        .fullScreenCover(isPresented: $previewPresented) {
            FullScreenImagePreview(data: data)
        }
        #else
        DataImage(data: data)
        #endif
    }
}

/// Lazily resolves either an inline data URL, a bounded transcript blob, or a
/// remote image before handing it to the full-screen-capable renderer.
struct ConversationImage: View {
    let source: String
    let sessionId: String

    @State private var data: Data?
    @State private var failed = false
    @State private var retryCount = 0

    init(source: String, sessionId: String) {
        self.source = source
        self.sessionId = sessionId
        _data = State(initialValue: DataImage.decode(dataURL: source))
    }

    var body: some View {
        Group {
            if let data {
                ExpandableDataImage(data: data)
            } else if failed {
                Button {
                    retryCount += 1
                } label: {
                    imagePlaceholder(showingError: true)
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Retry image")
            } else {
                imagePlaceholder(showingError: false)
            }
        }
        .task(id: "\(source)#\(retryCount)") {
            guard data == nil else { return }
            failed = false
            do {
                data = try await OS1API.conversationImage(source: source, sessionId: sessionId)
            } catch {
                failed = true
            }
        }
    }

    private func imagePlaceholder(showingError: Bool) -> some View {
        RoundedRectangle(cornerRadius: 12, style: .continuous)
            .fill(.fill.tertiary)
            .overlay {
                if showingError {
                    Image(systemName: "arrow.clockwise")
                        .foregroundStyle(.tertiary)
                } else {
                    ProgressView()
                        .controlSize(.small)
                }
            }
    }
}

#if os(iOS)
private struct FullScreenImagePreview: View {
    private let image: UIImage?

    @Environment(\.dismiss) private var dismiss
    @State private var dragOffset: CGSize = .zero

    init(data: Data) {
        image = UIImage(data: data)
    }

    private var dismissalProgress: CGFloat {
        min(abs(dragOffset.height) / 280, 1)
    }

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black
                .opacity(1 - dismissalProgress * 0.55)
                .ignoresSafeArea()

            if let image {
                ZoomableImage(
                    image: image,
                    onDragChanged: { dragOffset = $0 },
                    onDragEnded: { translation, projected in
                        if abs(translation.height) > 100 || abs(projected.height) > 220 {
                            dismiss()
                        } else {
                            withAnimation(.spring(response: 0.3, dampingFraction: 0.8)) {
                                dragOffset = .zero
                            }
                        }
                    },
                    onEscape: { dismiss() }
                )
                .offset(x: dragOffset.width * 0.08, y: dragOffset.height)
                .scaleEffect(1 - dismissalProgress * 0.08)
                .ignoresSafeArea()
            }

            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 15, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 36, height: 36)
                    .background(.black.opacity(0.55), in: Circle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Close image")
            .padding(16)
        }
        .statusBarHidden()
    }
}

/// Pinch-, double-tap- and pan-to-zoom, on a `UIScrollView`.
///
/// SwiftUI has no zooming container even on iOS 26, and composed
/// `MagnifyGesture`/`DragGesture` can't reach the feel people expect from
/// Photos: rubber-banding past the zoom limits, pan deceleration, and panning
/// with two fingers still down mid-pinch (a `DragGesture` ends the moment a
/// second finger lands). UIKit gives all of that for free.
///
/// Drag-to-dismiss lives in here too rather than as a SwiftUI gesture on the
/// parent: the scroll view's own pan recognizer begins whether or not there is
/// anywhere to scroll and wins the arbitration, so a parent `DragGesture`
/// would simply never fire. The dismissal pan is a UIKit recognizer that only
/// begins while fully zoomed out (zoomed in, a swipe pans the image instead)
/// and never with a second finger down, so a sloppy pinch can't dismiss the
/// viewer. Its translation is reported back so SwiftUI keeps owning the
/// backdrop fade and the dismiss/spring-back decision.
private struct ZoomableImage: UIViewRepresentable {
    let image: UIImage
    let onDragChanged: (CGSize) -> Void
    let onDragEnded: (_ translation: CGSize, _ projected: CGSize) -> Void
    let onEscape: () -> Void

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ZoomScrollView {
        let scrollView = ZoomScrollView()
        scrollView.delegate = context.coordinator
        scrollView.contentInsetAdjustmentBehavior = .never
        scrollView.showsHorizontalScrollIndicator = false
        scrollView.showsVerticalScrollIndicator = false
        scrollView.backgroundColor = .clear
        scrollView.imageView.image = image
        context.coordinator.scrollView = scrollView

        let doubleTap = UITapGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDoubleTap(_:))
        )
        doubleTap.numberOfTapsRequired = 2
        scrollView.addGestureRecognizer(doubleTap)

        let dismissPan = UIPanGestureRecognizer(
            target: context.coordinator,
            action: #selector(Coordinator.handleDismissPan(_:))
        )
        // A pinch is two fingers: capping the touch count is what keeps one
        // from ever being read as a dismissal drag.
        dismissPan.maximumNumberOfTouches = 1
        dismissPan.delegate = context.coordinator
        scrollView.addGestureRecognizer(dismissPan)

        return scrollView
    }

    func updateUIView(_ scrollView: ZoomScrollView, context: Context) {
        context.coordinator.onDragChanged = onDragChanged
        context.coordinator.onDragEnded = onDragEnded
        scrollView.onEscape = onEscape
        if scrollView.imageView.image !== image {
            scrollView.imageView.image = image
            scrollView.setNeedsLayout()
        }
    }

    final class Coordinator: NSObject, UIScrollViewDelegate, UIGestureRecognizerDelegate {
        weak var scrollView: ZoomScrollView?
        var onDragChanged: ((CGSize) -> Void)?
        var onDragEnded: ((CGSize, CGSize) -> Void)?

        func viewForZooming(in scrollView: UIScrollView) -> UIView? {
            (scrollView as? ZoomScrollView)?.imageView
        }

        func scrollViewDidZoom(_ scrollView: UIScrollView) {
            (scrollView as? ZoomScrollView)?.zoomDidChange()
        }

        @objc func handleDoubleTap(_ gesture: UITapGestureRecognizer) {
            guard let scrollView else { return }
            guard scrollView.isZoomedOut else {
                scrollView.setZoomScale(scrollView.minimumZoomScale, animated: true)
                return
            }
            let target = scrollView.doubleTapZoomScale
            let point = gesture.location(in: scrollView.imageView)
            let size = CGSize(
                width: scrollView.bounds.width / target,
                height: scrollView.bounds.height / target
            )
            scrollView.zoom(
                to: CGRect(
                    x: point.x - size.width / 2,
                    y: point.y - size.height / 2,
                    width: size.width,
                    height: size.height
                ),
                animated: true
            )
        }

        @objc func handleDismissPan(_ gesture: UIPanGestureRecognizer) {
            guard let scrollView else { return }
            let translation = gesture.translation(in: scrollView)
            switch gesture.state {
            case .changed:
                onDragChanged?(CGSize(width: translation.x, height: translation.y))
            case .ended:
                // Stand-in for SwiftUI's `predictedEndTranslation`, which the
                // dismissal thresholds were tuned against.
                let velocity = gesture.velocity(in: scrollView)
                onDragEnded?(
                    CGSize(width: translation.x, height: translation.y),
                    CGSize(
                        width: translation.x + velocity.x * 0.25,
                        height: translation.y + velocity.y * 0.25
                    )
                )
            case .cancelled, .failed:
                onDragEnded?(.zero, .zero)
            default:
                break
            }
        }

        /// Dismissal only from the fit scale, and only for a vertical drag —
        /// zoomed in, the scroll view's own pan owns every direction.
        func gestureRecognizerShouldBegin(_ gesture: UIGestureRecognizer) -> Bool {
            guard let pan = gesture as? UIPanGestureRecognizer,
                  let scrollView,
                  scrollView.isZoomedOut
            else { return false }
            let velocity = pan.velocity(in: scrollView)
            return abs(velocity.y) > abs(velocity.x)
        }

        func gestureRecognizer(
            _ gesture: UIGestureRecognizer,
            shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
        ) -> Bool {
            true
        }
    }
}

/// Scroll view that keeps its zoom limits in step with its bounds and the
/// image, and keeps the image centered while it is smaller than the screen.
final class ZoomScrollView: UIScrollView {
    let imageView = UIImageView()
    var onEscape: (() -> Void)?
    private(set) var doubleTapZoomScale: CGFloat = 1

    private var laidOutBounds: CGSize = .zero
    private var laidOutImage: CGSize = .zero

    override init(frame: CGRect) {
        super.init(frame: frame)
        imageView.contentMode = .scaleAspectFit
        imageView.isAccessibilityElement = true
        imageView.accessibilityTraits = .image
        imageView.accessibilityLabel = "Image"
        addSubview(imageView)
        bouncesZoom = true
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) { fatalError("init(coder:) is not used") }

    var isZoomedOut: Bool { zoomScale <= minimumZoomScale + 0.01 }

    override func layoutSubviews() {
        super.layoutSubviews()
        guard bounds.width > 0, bounds.height > 0,
              let size = imageView.image?.size, size.width > 0, size.height > 0
        else { return }
        // Rebuilding on every pass would fight `zoom(to:)`; only a genuinely
        // new box or image invalidates the scales. The first pass inside a
        // `fullScreenCover` can be zero-sized, which is why it is guarded.
        if bounds.size != laidOutBounds || size != laidOutImage {
            laidOutBounds = bounds.size
            laidOutImage = size
            configureZoom(for: size)
        }
        centerContent()
    }

    private func configureZoom(for size: CGSize) {
        imageView.frame = CGRect(origin: .zero, size: size)
        contentSize = size

        let fit = min(bounds.width / size.width, bounds.height / size.height)
        // Zooming to one image pixel per device pixel is what makes the dense
        // UI screenshots this viewer mostly shows readable; the 4x floor keeps
        // small images zoomable at all.
        let displayScale = traitCollection.displayScale > 0 ? traitCollection.displayScale : 2
        let pixelPerfect = (imageView.image?.scale ?? 1) / displayScale
        minimumZoomScale = fit
        maximumZoomScale = max(fit * 4, pixelPerfect)
        doubleTapZoomScale = min(maximumZoomScale, max(fit * 2, pixelPerfect))
        zoomScale = fit
        zoomDidChange()
    }

    /// Called on every zoom change: the image only bounces once there is
    /// somewhere to pan, so at the fit scale a vertical drag belongs entirely
    /// to the dismissal gesture.
    func zoomDidChange() {
        bounces = !isZoomedOut
        centerContent()
    }

    private func centerContent() {
        let insetX = max(0, (bounds.width - imageView.frame.width) / 2)
        let insetY = max(0, (bounds.height - imageView.frame.height) / 2)
        contentInset = UIEdgeInsets(top: insetY, left: insetX, bottom: insetY, right: insetX)
    }

    /// VoiceOver's two-finger scrub, which users expect to close a full-screen
    /// cover.
    override func accessibilityPerformEscape() -> Bool {
        onEscape?()
        return true
    }
}
#endif

// ── Pasting images ────────────────────────────────────────────────────────

#if os(macOS)
extension View {
    /// Cmd+V of a copied screenshot/image drops it into the attachments.
    ///
    /// Not `onPasteCommand`: with a focused TextEditor/TextField the backing
    /// NSTextView is the first responder for the Paste command and swallows
    /// image pastes silently, so SwiftUI's handler never fires. A local
    /// key-event monitor scoped to this view's window sees Cmd+V before the
    /// responder chain, claims it only when the pasteboard actually carries
    /// an image, and lets every other paste reach the text view untouched.
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6
    ) -> some View {
        background(ImagePasteMonitor(images: images, maxCount: maxCount))
    }
}

private struct ImagePasteMonitor: NSViewRepresentable {
    @Binding var images: [AttachedImage]
    var maxCount: Int

    func makeNSView(context: Context) -> MonitorView { MonitorView() }

    func updateNSView(_ view: MonitorView, context: Context) {
        view.onPaste = { datas in
            for data in datas {
                guard images.count < maxCount,
                      let image = AttachedImage(rawData: data)
                else { continue }
                images.append(image)
            }
        }
    }

    final class MonitorView: NSView {
        var onPaste: (([Data]) -> Void)?
        private var monitor: Any?

        override func viewDidMoveToWindow() {
            super.viewDidMoveToWindow()
            if window == nil {
                removeMonitor()
            } else if monitor == nil {
                monitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) {
                    [weak self] event in
                    guard let self, self.claims(event) else { return event }
                    return nil
                }
            }
        }

        /// Plain Cmd+V, in this view's own window, with image content on the
        /// pasteboard. Anything else stays on the normal responder path.
        private func claims(_ event: NSEvent) -> Bool {
            guard event.window === window,
                  event.modifierFlags.intersection(
                      [.command, .shift, .option, .control]
                  ) == .command,
                  event.charactersIgnoringModifiers?.lowercased() == "v"
            else { return false }
            let datas = NSPasteboard.general.imageDataRepresentations()
            guard !datas.isEmpty else { return false }
            onPaste?(datas)
            return true
        }

        private func removeMonitor() {
            if let monitor {
                NSEvent.removeMonitor(monitor)
                self.monitor = nil
            }
        }

        deinit { removeMonitor() }
    }
}

extension NSPasteboard {
    /// Raw bytes of every image on the pasteboard: direct image flavors
    /// (screenshots, a browser's "Copy Image") plus copied files that are
    /// themselves images (Finder, the screenshot thumbnail).
    func imageDataRepresentations() -> [Data] {
        (pasteboardItems ?? []).compactMap { item in
            if let type = item.types.first(where: {
                UTType($0.rawValue)?.conforms(to: .image) == true
            }) {
                return item.data(forType: type)
            }
            guard let urlString = item.string(forType: .fileURL),
                  let url = URL(string: urlString),
                  let type = UTType(filenameExtension: url.pathExtension),
                  type.conforms(to: .image)
            else { return nil }
            return try? Data(contentsOf: url)
        }
    }
}
#else
extension View {
    /// Long-press → Paste on the composer accepts images. SwiftUI text
    /// fields on iOS reject image pastes outright, so a background probe
    /// finds the UIKit text input backing the field, gives it a paste
    /// configuration that accepts images, a paste delegate that routes
    /// image flavors into the attachments — text pastes flow through
    /// untouched — and, via `ImagePasteMenu`, the Paste item the edit menu
    /// otherwise withholds. No extra button; the system edit menu is the
    /// affordance.
    func pastesImages(
        into images: Binding<[AttachedImage]>, maxCount: Int = 6
    ) -> some View {
        background(TextInputPasteAugmenter(images: images, maxCount: maxCount))
    }
}

private struct TextInputPasteAugmenter: UIViewRepresentable {
    @Binding var images: [AttachedImage]
    var maxCount: Int

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeUIView(context: Context) -> ProbeView {
        let view = ProbeView()
        view.coordinator = context.coordinator
        return view
    }

    func updateUIView(_ view: ProbeView, context: Context) {
        context.coordinator.append = { data in
            guard images.count < maxCount,
                  let image = AttachedImage(rawData: data)
            else { return }
            images.append(image)
        }
        view.coordinator = context.coordinator
        view.augmentSoon()
    }

    final class Coordinator: NSObject, UITextPasteDelegate {
        var append: ((Data) -> Void)?

        func textPasteConfigurationSupporting(
            _ textPasteConfigurationSupporting: UITextPasteConfigurationSupporting,
            transform item: UITextPasteItem
        ) {
            let provider = item.itemProvider
            guard let type = provider.registeredTypeIdentifiers.first(where: {
                UTType($0)?.conforms(to: .image) == true
            }) else {
                item.setDefaultResult()
                return
            }
            provider.loadDataRepresentation(forTypeIdentifier: type) { data, _ in
                guard let data else { return }
                DispatchQueue.main.async { self.append?(data) }
            }
            item.setNoResult()
        }
    }

    /// Invisible view that locates the text input near it in the UIKit
    /// hierarchy and attaches the paste configuration + delegate. Re-runs on
    /// every update — SwiftUI can recreate the backing view under us.
    final class ProbeView: UIView {
        weak var coordinator: Coordinator?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            augmentSoon()
        }

        func augmentSoon() {
            DispatchQueue.main.async { [weak self] in self?.augment() }
        }

        private func augment() {
            guard let coordinator else { return }
            // The probe sits as the field's background, so the input is a
            // close relative — walk a few ancestors, searching each subtree.
            var scope: UIView? = self
            for _ in 0..<5 {
                scope = scope?.superview
                guard let scope else { return }
                if let input = Self.findTextInput(in: scope) {
                    input.pasteConfiguration = UIPasteConfiguration(
                        forAccepting: UIImage.self
                    )
                    input.pasteDelegate = coordinator
                    ImagePasteMenu.enable(on: input)
                    return
                }
            }
        }

        private static func findTextInput(
            in view: UIView
        ) -> (UIView & UITextPasteConfigurationSupporting)? {
            if let match = view as? UIView & UITextPasteConfigurationSupporting {
                return match
            }
            for sub in view.subviews {
                if let match = findTextInput(in: sub) { return match }
            }
            return nil
        }
    }
}

/// Puts Paste back in the edit menu when the clipboard holds only an image.
///
/// SwiftUI's text views answer the menu's "does Paste apply here?" from the
/// text flavors alone and ignore the paste configuration set above, so an
/// image-only clipboard offers no Paste at all — even though the paste
/// pipeline underneath works (measured on iOS 26: configuration and delegate
/// both installed, `paste(nil)` attaches the image, `canPerformAction(paste:)`
/// false, long-press shows only AutoFill).
///
/// So the one broken link gets patched and nothing else: the augmented view
/// moves to a subclass that overrides `canPerformAction` alone, additively —
/// whatever the original answered yes to still wins, so no text paste can
/// regress — and adds Paste while an image is on the clipboard. Choosing it
/// runs the view's own paste, through the delegate installed above.
private enum ImagePasteMenu {
    private static let namePrefix = "OS1ImagePaste_"
    private static var subclasses: [ObjectIdentifier: AnyClass] = [:]

    static func enable(on input: UIView & UITextPasteConfigurationSupporting) {
        guard let current = object_getClass(input),
              !NSStringFromClass(current).hasPrefix(namePrefix),
              let patched = subclass(of: current)
        else { return }
        object_setClass(input, patched)
    }

    /// One subclass per base class, derived from the class the instance is
    /// actually wearing rather than one looked up by name: KVO plays the same
    /// trick, and layering on top of whatever is there keeps its behavior.
    private static func subclass(of base: AnyClass) -> AnyClass? {
        if let made = subclasses[ObjectIdentifier(base)] { return made }
        let selector = #selector(UIResponder.canPerformAction(_:withSender:))
        guard let method = class_getInstanceMethod(base, selector),
              let made = objc_allocateClassPair(
                  base, namePrefix + NSStringFromClass(base), 0
              )
        else { return nil }
        typealias Original =
            @convention(c) (AnyObject, Selector, Selector, AnyObject?) -> Bool
        let original = unsafeBitCast(
            method_getImplementation(method), to: Original.self
        )
        let override: @convention(block) (AnyObject, Selector, AnyObject?) -> Bool = {
            view, action, sender in
            if original(view, selector, action, sender) { return true }
            guard action == #selector(UIResponder.paste(_:)),
                  let input = view as? UITextPasteConfigurationSupporting,
                  input.pasteDelegate != nil
            else { return false }
            // Metadata only: asking whether the clipboard holds images never
            // trips the paste-permission alert, where reading them would.
            return UIPasteboard.general.hasImages
        }
        class_addMethod(
            made,
            selector,
            imp_implementationWithBlock(override),
            method_getTypeEncoding(method)
        )
        objc_registerClassPair(made)
        subclasses[ObjectIdentifier(base)] = made
        return made
    }
}
#endif
