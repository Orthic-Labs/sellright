import Foundation

enum APIError: LocalizedError {
    case invalidURL
    case http(status: Int, message: String)
    case decoding(Error)
    case transport(Error)

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL"
        case let .http(status, message): return "\(message) (HTTP \(status))"
        case let .decoding(err): return "Unexpected server response: \(err.localizedDescription)"
        case let .transport(err): return err.localizedDescription
        }
    }

    var isUnauthorized: Bool {
        if case .http(401, _) = self { return true }
        return false
    }
}

/// Thin async client for the SellRight admin REST API (/v1/admin/*).
/// Bearer-token auth (CSRF-exempt on the server), store selection via the
/// x-store-slug header — the same contract the web admin SPA uses.
struct APIClient: Sendable {
    var baseURL: URL
    var token: String?
    var storeSlug: String?

    private static let decoder: JSONDecoder = {
        let d = JSONDecoder()
        // The API emits Date.toISOString() — fractional seconds — but be
        // lenient and accept plain ISO8601 too.
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let plain = ISO8601DateFormatter()
        d.dateDecodingStrategy = .custom { decoder in
            let s = try decoder.singleValueContainer().decode(String.self)
            if let date = fractional.date(from: s) ?? plain.date(from: s) { return date }
            throw DecodingError.dataCorrupted(.init(
                codingPath: decoder.codingPath,
                debugDescription: "Unrecognized date: \(s)"
            ))
        }
        return d
    }()

    func get<Out: Decodable>(_ path: String, query: [URLQueryItem] = []) async throws -> Out {
        try await send(path: path, method: "GET", query: query, body: nil as Never?)
    }

    func post<In: Encodable, Out: Decodable>(_ path: String, body: In) async throws -> Out {
        try await send(path: path, method: "POST", query: [], body: body)
    }

    func post<Out: Decodable>(_ path: String) async throws -> Out {
        try await send(path: path, method: "POST", query: [], body: nil as Never?)
    }

    func patch<In: Encodable, Out: Decodable>(_ path: String, body: In) async throws -> Out {
        try await send(path: path, method: "PATCH", query: [], body: body)
    }

    private func send<In: Encodable, Out: Decodable>(
        path: String, method: String, query: [URLQueryItem], body: In?
    ) async throws -> Out {
        guard var components = URLComponents(url: baseURL.appending(path: path), resolvingAgainstBaseURL: false) else {
            throw APIError.invalidURL
        }
        if !query.isEmpty { components.queryItems = query }
        guard let url = components.url else { throw APIError.invalidURL }

        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        if let token { request.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        if let storeSlug { request.setValue(storeSlug, forHTTPHeaderField: "x-store-slug") }
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }

        let data: Data
        let response: URLResponse
        do {
            (data, response) = try await URLSession.shared.data(for: request)
        } catch {
            throw APIError.transport(error)
        }

        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            let message = (try? Self.decoder.decode(APIErrorBody.self, from: data))?.error ?? "Request failed"
            throw APIError.http(status: status, message: message)
        }
        do {
            return try Self.decoder.decode(Out.self, from: data)
        } catch {
            throw APIError.decoding(error)
        }
    }
}

/// Empty JSON object for endpoints whose success body we don't consume.
struct EmptyResponse: Decodable {}
