// Small fetch-based client for the PWDSafe REST API. See
// pwdsafe-cli/internal/api/client.go for the reference implementation.

export class ApiError extends Error {
    constructor(message, status, data) {
        super(message)
        this.name = 'ApiError'
        this.status = status
        this.data = data
    }
}

async function request(baseUrl, path, { method = 'GET', token, body } = {}) {
    const headers = { Accept: 'application/json' }
    if (body !== undefined) {
        headers['Content-Type'] = 'application/json'
    }
    if (token) {
        headers['Authorization'] = `Bearer ${token}`
    }

    const resp = await fetch(baseUrl.replace(/\/+$/, '') + path, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
    })

    const text = await resp.text()
    const data = text ? JSON.parse(text) : null

    if (!resp.ok) {
        throw new ApiError(data?.message || `Request failed (HTTP ${resp.status})`, resp.status, data)
    }

    return data
}

/** GET /api/vault/preflight?email=... */
export function preflight(baseUrl, email) {
    return request(baseUrl, `/api/vault/preflight?email=${encodeURIComponent(email)}`)
}

/** POST /api/auth/login */
export function login(baseUrl, body) {
    return request(baseUrl, '/api/auth/login', { method: 'POST', body })
}

/** POST /api/auth/logout */
export function logout(baseUrl, token) {
    return request(baseUrl, '/api/auth/logout', { method: 'POST', token })
}

/** GET /api/vault/key-data */
export function keyData(baseUrl, token) {
    return request(baseUrl, '/api/vault/key-data', { token })
}

/** GET /api/credentials/search?domain=... */
export function searchCredentials(baseUrl, token, params) {
    const qs = new URLSearchParams(params).toString()
    return request(baseUrl, `/api/credentials/search?${qs}`, { token })
}

/** GET /api/credentials/{id} */
export function getCredential(baseUrl, token, id) {
    return request(baseUrl, `/api/credentials/${id}`, { token })
}
