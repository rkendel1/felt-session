import Foundation

/// A pending AskUserQuestion from a session (WS `ask_question` frame).
/// Answered with an `answer_question` frame mapping question text to the
/// chosen option label (or free text).
struct AskQuestion: Identifiable, Equatable, Sendable {
    struct Option: Decodable, Equatable, Sendable {
        let label: String
        let description: String?
    }

    struct Question: Decodable, Equatable, Sendable {
        let question: String
        let header: String?
        let options: [Option]?
        let multiSelect: Bool?
    }

    /// The server's questionId, echoed back in the answer.
    let id: String
    let questions: [Question]
}
