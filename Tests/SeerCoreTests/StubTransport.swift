import Foundation
@testable import SeerCore
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

/// Scripted transport: hands back queued responses in order and records what was sent.
///
/// The queue is per-URL-path so a test can script "404 for the 3.6 model, 200 for 3.5"
/// and assert the chain walked correctly.
actor StubTransport: HTTPTransport {
    struct Response {
        var status: Int
        var body: Data
        var headers: [String: String] = [:]

        static func ok(_ json: String) -> Response { Response(status: 200, body: Data(json.utf8)) }
        static func error(_ status: Int, message: String = "nope", headers: [String: String] = [:]) -> Response {
            Response(
                status: status,
                body: Data(#"{"error":{"message":"\#(message)"}}"#.utf8),
                headers: headers
            )
        }
    }

    private var queue: [Response]
    private(set) var requests: [URLRequest] = []
    /// Transport-level errors to throw before consuming the queue, in order.
    private var pendingTransportErrors: [Error]

    init(_ responses: [Response], transportErrors: [Error] = []) {
        self.queue = responses
        self.pendingTransportErrors = transportErrors
    }

    var requestedPaths: [String] { requests.compactMap(\.url?.path) }
    var requestCount: Int { requests.count }

    func send(_ request: URLRequest) async throws -> (Data, HTTPURLResponse) {
        requests.append(request)

        if !pendingTransportErrors.isEmpty {
            throw pendingTransportErrors.removeFirst()
        }
        guard !queue.isEmpty else {
            throw ExtractionError.malformedResponse("StubTransport ran out of scripted responses")
        }
        let next = queue.removeFirst()
        let response = HTTPURLResponse(
            url: request.url!, statusCode: next.status, httpVersion: "HTTP/1.1", headerFields: next.headers
        )!
        return (next.body, response)
    }
}
