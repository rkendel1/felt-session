import Foundation
import CoreGraphics
import ImageIO
import UniformTypeIdentifiers

/// One image attached to a message or new-session prompt, normalized at pick
/// time: downscaled to the vision path's useful size and re-encoded as JPEG so
/// a 12 MP camera photo doesn't ride the WebSocket at 40 MB of base64.
struct AttachedImage: Identifiable, Equatable {
    let id: String
    let jpegData: Data

    /// The wire form the server's composer paths expect (`msg.images`).
    var dataURL: String {
        "data:image/jpeg;base64," + jpegData.base64EncodedString()
    }

    /// Direct construction (tests, previews) — bypasses normalization.
    init(id: String, jpegData: Data) {
        self.id = id
        self.jpegData = jpegData
    }

    /// The inverse of `dataURL` — re-stage an image that has already been
    /// normalized (an unsent outbox message pulled back into the composer),
    /// without paying for a decode/re-encode round trip.
    init?(dataURL: String) {
        guard dataURL.hasPrefix("data:"),
              let comma = dataURL.firstIndex(of: ","),
              let data = Data(
                  base64Encoded: String(dataURL[dataURL.index(after: comma)...])
              )
        else { return nil }
        self.id = UUID().uuidString
        self.jpegData = data
    }

    init?(rawData: Data) {
        guard let jpeg = AttachedImage.normalizedJPEG(from: rawData) else {
            return nil
        }
        self.id = UUID().uuidString
        self.jpegData = jpeg
    }

    /// Decode any picked image format, downscale to ≤2048px on the long edge
    /// (honoring EXIF orientation), and re-encode as JPEG. ImageIO only — the
    /// same code path works on iOS and macOS.
    private static func normalizedJPEG(
        from raw: Data, maxPixel: Int = 2048
    ) -> Data? {
        guard let source = CGImageSourceCreateWithData(raw as CFData, nil) else {
            return nil
        }
        let thumbOptions: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixel,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(
            source, 0, thumbOptions as CFDictionary
        ) else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.jpeg.identifier as CFString, 1, nil
        ) else { return nil }
        CGImageDestinationAddImage(
            dest, image,
            [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary
        )
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }
}
