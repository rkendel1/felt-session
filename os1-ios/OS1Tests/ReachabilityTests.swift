import XCTest
@testable import OS1

/// The tailnet diagnosis rests on Tailscale's address space, so these pin the
/// range arithmetic: claiming "not connected to Tailscale" about a server that
/// was simply down would be worse than the timeout it replaces.
final class ReachabilityTests: XCTestCase {
    private func ipv4(_ dotted: String) -> UInt32 {
        let parts = dotted.split(separator: ".").map { UInt32($0)! }
        return parts.reduce(0) { $0 << 8 | $1 }
    }

    func testCgnatRangeIsTheTailnetRange() {
        XCTAssertTrue(Reachability.isTailnetIPv4(ipv4("100.64.0.0")))
        XCTAssertTrue(Reachability.isTailnetIPv4(ipv4("100.101.102.103")))
        XCTAssertTrue(Reachability.isTailnetIPv4(ipv4("100.127.255.255")))
    }

    func testAddressesEitherSideOfTheRangeAreNot() {
        XCTAssertFalse(Reachability.isTailnetIPv4(ipv4("100.63.255.255")))
        XCTAssertFalse(Reachability.isTailnetIPv4(ipv4("100.128.0.0")))
        // 100.0.0.0/8 is ordinary public space outside the /10.
        XCTAssertFalse(Reachability.isTailnetIPv4(ipv4("100.0.0.1")))
        XCTAssertFalse(Reachability.isTailnetIPv4(ipv4("192.168.1.10")))
        XCTAssertFalse(Reachability.isTailnetIPv4(ipv4("127.0.0.1")))
    }

    func testTailscaleUlaPrefixIsRecognisedAndNeighboursArent() {
        XCTAssertTrue(
            Reachability.isTailnetIPv6([0xFD, 0x7A, 0x11, 0x5C, 0xA1, 0xE0, 0xAB, 0x12])
        )
        XCTAssertFalse(
            Reachability.isTailnetIPv6([0xFD, 0x7A, 0x11, 0x5C, 0xA1, 0xE1, 0x00, 0x00])
        )
        // Another site's ULA, and a plain link-local.
        XCTAssertFalse(Reachability.isTailnetIPv6([0xFD, 0x00, 0x00, 0x00, 0x00, 0x00]))
        XCTAssertFalse(Reachability.isTailnetIPv6([0xFE, 0x80, 0x00, 0x00, 0x00, 0x00]))
        XCTAssertFalse(Reachability.isTailnetIPv6([]))
    }

    func testMagicDnsNamesAreTailnetOnlyByName() {
        XCTAssertTrue(Reachability.isTailnetHostname("os.tail1234.ts.net"))
        XCTAssertTrue(Reachability.isTailnetHostname("OS.Tail1234.TS.NET"))
        XCTAssertFalse(Reachability.isTailnetHostname("os.example.com"))
        XCTAssertFalse(Reachability.isTailnetHostname("ts.network.example.com"))
    }

    func testOnlyErrorsThatMeanNothingCameBackGetTheDiagnosis() {
        XCTAssertTrue(Reachability.blamesTheNetwork(URLError(.timedOut)))
        XCTAssertTrue(Reachability.blamesTheNetwork(URLError(.cannotConnectToHost)))
        XCTAssertTrue(Reachability.blamesTheNetwork(URLError(.cannotFindHost)))
        XCTAssertTrue(Reachability.blamesTheNetwork(URLError(.networkConnectionLost)))
    }

    func testAnAnsweringServerKeepsItsOwnWording() {
        // The device is plainly offline — already the whole story.
        XCTAssertFalse(Reachability.blamesTheNetwork(URLError(.notConnectedToInternet)))
        // These all prove packets made the trip.
        XCTAssertFalse(Reachability.blamesTheNetwork(URLError(.secureConnectionFailed)))
        XCTAssertFalse(Reachability.blamesTheNetwork(URLError(.badServerResponse)))
        // An HTTP status, decoded and thrown by the API client.
        XCTAssertFalse(Reachability.blamesTheNetwork(NSError(domain: "OS1", code: 500)))
    }

    /// The sessions screen shows a connection failure differently from an
    /// empty server, so the flag that picks between them has to be right.
    /// Only the branches that need no network are pinned here — the tailnet
    /// question resolves a hostname and reads this device's interfaces.
    @MainActor
    func testOfflineIsAConnectionProblemEvenThoughItKeepsItsOwnWording() async {
        let diagnosis = await Reachability.diagnose(URLError(.notConnectedToInternet))
        XCTAssertTrue(diagnosis.isConnection)
        XCTAssertEqual(diagnosis.title, "No internet connection")
        XCTAssertNotNil(diagnosis.fix)
        XCTAssertEqual(diagnosis.detail, URLError(.notConnectedToInternet).localizedDescription)
    }

    @MainActor
    func testAnAnsweredRequestIsNotAConnectionProblem() async {
        let diagnosis = await Reachability.diagnose(OS1API.APIError.http(500))
        XCTAssertFalse(diagnosis.isConnection)
        // Nothing to advise: the screen falls back to the system's wording.
        XCTAssertNil(diagnosis.fix)
        XCTAssertEqual(diagnosis.detail, OS1API.APIError.http(500).localizedDescription)
    }

    /// The placeholder shows exactly one button, so the diagnosis has to pick
    /// it: nothing that a retry can't fix should offer one.
    @MainActor
    func testTheThingsSettingsCanFixAskForSettings() async {
        for error in [OS1API.APIError.notConfigured, .http(401)] {
            let diagnosis = await Reachability.diagnose(error)
            XCTAssertEqual(diagnosis.remedy, .settings, "\(error)")
            XCTAssertNotNil(diagnosis.fix, "\(error)")
        }
        // An http:// server on a remote host: stopped by App Transport
        // Security before it leaves the device, and fixed by the scheme.
        let insecure = await Reachability.diagnose(
            URLError(.appTransportSecurityRequiresSecureConnection)
        )
        XCTAssertEqual(insecure.remedy, .settings)
        XCTAssertNotNil(insecure.fix)
        // A server that simply didn't answer is the retry case.
        let offline = await Reachability.diagnose(URLError(.notConnectedToInternet))
        XCTAssertEqual(offline.remedy, .retry)
    }
}
