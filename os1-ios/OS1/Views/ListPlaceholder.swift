import SwiftUI

/// What stands in for a list with no rows — nothing to show, or nothing that
/// came back.
///
/// SwiftUI's `ContentUnavailableView` is the obvious fit and was the first
/// try; its proportions are what didn't fit. It draws the glyph large enough
/// to own a phone screen and sets the title at `.title2` bold, so a routine
/// "nothing here" arrived shouting in an app whose every other surface sits
/// at 13-17pt. This keeps the same anatomy — mark, headline, one line,
/// actions — at the app's own scale.
struct ListPlaceholder<Actions: View>: View {
    let symbol: String
    let title: String
    var message: String?
    @ViewBuilder var actions: Actions

    var body: some View {
        VStack(spacing: 0) {
            Image(systemName: symbol)
                // Hierarchical, so the mark reads as one quiet shape rather
                // than a flat stencil at full strength.
                .symbolRenderingMode(.hierarchical)
                .font(.system(size: 27))
                .foregroundStyle(OS1VisualStyle.textDim)
                .padding(.bottom, 13)
            Text(title)
                .font(.title3.weight(.semibold))
                .foregroundStyle(OS1VisualStyle.text)
            if let message {
                Text(message)
                    .font(.subheadline)
                    .foregroundStyle(OS1VisualStyle.textDim)
                    .padding(.top, 4)
            }
            VStack(spacing: 2) {
                actions
            }
            .padding(.top, 18)
        }
        .multilineTextAlignment(.center)
        // A short measure holds the message to two lines at most, so the
        // block stays a block instead of becoming a paragraph.
        .frame(maxWidth: 300)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.horizontal, 28)
    }
}

/// The placeholder's buttons: a quiet capsule for the action worth taking,
/// dim text for the one that is merely available.
///
/// Neither is filled. A placeholder is not urgent — the poll keeps trying, the
/// list may fill by itself — and a black pill in the middle of an empty screen
/// reads as an alert about something that isn't one.
struct PlaceholderActionStyle: ButtonStyle {
    var prominent = true

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(prominent ? .subheadline.weight(.medium) : .footnote)
            .foregroundStyle(prominent ? OS1VisualStyle.text : OS1VisualStyle.textDim)
            .padding(.horizontal, prominent ? 15 : 8)
            .padding(.vertical, prominent ? 8 : 5)
            .background {
                if prominent { Capsule().fill(OS1VisualStyle.raised) }
            }
            // The capsule stays the size the type asks for; the target around
            // it is a thumb's worth either way.
            .frame(minWidth: 44, minHeight: 44)
            .contentShape(Rectangle())
            .opacity(configuration.isPressed ? 0.55 : 1)
            .scaleEffect(configuration.isPressed ? 0.97 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}
