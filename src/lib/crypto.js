// Client-side crypto for PWDSafe's zero-knowledge vault, ported to pure
// WebCrypto for the extension. Mirrors resources/js/vault.js and
// pwdsafe-cli's internal/vaultkey + internal/vaultcrypto packages.

const PBKDF2_ITERATIONS = 600_000
const GCM_NONCE_SIZE = 12

/**
 * Derive a 256-bit AES-GCM vault key from a password and a hex-encoded salt.
 * @param {string} password
 * @param {string} saltHex
 * @returns {Promise<CryptoKey>}
 */
export async function deriveVaultKey(password, saltHex) {
    const salt = hexToBytes(saltHex)
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey'],
    )

    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        true,
        ['encrypt', 'decrypt'],
    )
}

/**
 * login_hash = hex(PBKDF2-SHA256(key=vaultKey, salt=password, iterations=1))
 * @param {CryptoKey} vaultKey
 * @param {string} password
 * @returns {Promise<string>} 64-character hex string
 */
export async function deriveLoginHash(vaultKey, password) {
    const exported = await crypto.subtle.exportKey('raw', vaultKey)
    const baseKey = await crypto.subtle.importKey('raw', exported, 'PBKDF2', false, ['deriveBits'])
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt: new TextEncoder().encode(password), iterations: 1, hash: 'SHA-256' },
        baseKey,
        256,
    )
    return bytesToHex(new Uint8Array(bits))
}

/**
 * login_hash = hex(PBKDF2-SHA256(loginPassword, login_salt, 600000))
 * @param {string} loginPassword
 * @param {string} loginSaltHex
 * @returns {Promise<string>} 64-character hex string
 */
export async function deriveLoginHashIndependent(loginPassword, loginSaltHex) {
    const salt = hexToBytes(loginSaltHex)
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(loginPassword),
        'PBKDF2',
        false,
        ['deriveBits'],
    )
    const bits = await crypto.subtle.deriveBits(
        { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
        baseKey,
        256,
    )
    return bytesToHex(new Uint8Array(bits))
}

/**
 * Decrypt vault_data.encrypted_privkey: base64(iv[12] || AES-256-GCM(privkey_der_or_pem) || tag[16]).
 * @param {string} encryptedB64
 * @param {CryptoKey} vaultKey
 * @returns {Promise<string>} PEM-encoded RSA private key
 */
export async function decryptPrivkey(encryptedB64, vaultKey) {
    const raw = base64ToBytes(encryptedB64)
    const iv = raw.slice(0, GCM_NONCE_SIZE)
    const ciphertextWithTag = raw.slice(GCM_NONCE_SIZE)

    try {
        const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, vaultKey, ciphertextWithTag)
        return new TextDecoder().decode(decrypted)
    } catch {
        throw new Error('Could not decrypt vault. Incorrect password?')
    }
}

/**
 * Decrypt a Credential.data blob — dispatches to v2 (hybrid RSA-OAEP + AES-GCM)
 * or v1 (legacy chunked RSAES-PKCS1-v1.5).
 * @param {string} data
 * @param {string} privkeyPem PEM-encoded RSA private key (PKCS#1 or PKCS#8)
 * @returns {Promise<string>} decrypted plaintext (the raw password)
 */
export async function decryptCredential(data, privkeyPem) {
    if (data.startsWith('v2:')) {
        return decryptCredentialV2(data, privkeyPem)
    }

    return decryptCredentialV1(data, privkeyPem)
}

async function decryptCredentialV2(data, privkeyPem) {
    const parts = data.split(':')
    if (parts.length !== 3 || parts[0] !== 'v2') {
        throw new Error('Unsupported credential data format')
    }

    const body = base64ToBytes(parts[1])
    const wrappedKey = base64ToBytes(parts[2])

    const privKey = await importPrivateKey(privkeyPem, { name: 'RSA-OAEP', hash: 'SHA-256' }, ['decrypt'])
    const aesKeyRaw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privKey, wrappedKey)
    const aesKey = await crypto.subtle.importKey('raw', aesKeyRaw, { name: 'AES-GCM' }, false, ['decrypt'])

    const iv = body.slice(0, GCM_NONCE_SIZE)
    const ciphertext = body.slice(GCM_NONCE_SIZE)
    const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aesKey, ciphertext)

    return new TextDecoder().decode(plaintext)
}

/**
 * v1 credentials are RSAES-PKCS1-v1.5 encrypted, chunked with '-' between
 * base64 chunks (or a single base64 block for small payloads). WebCrypto
 * does not implement RSAES-PKCS1-v1.5 for encrypt/decrypt (it was removed
 * from the spec before any browser shipped it — only RSA-OAEP is
 * supported), so we do the RSA decryption and PKCS#1 v1.5 unpadding
 * ourselves using the key's raw integer fields.
 */
async function decryptCredentialV1(data, privkeyPem) {
    const fields = getPrivateKeyFields(privkeyPem)
    const modulusLength = fields.n.length

    const chunks = data.split('-').filter((chunk) => chunk.length > 0)
    if (chunks.length === 0) {
        throw new Error('Credential ciphertext is empty')
    }

    const parts = []
    for (const chunk of chunks) {
        const ciphertext = base64ToBytes(chunk)
        const padded = rsaDecryptRaw(ciphertext, fields, modulusLength)
        parts.push(pkcs1v15Unpad(padded))
    }

    return new TextDecoder().decode(concatBytes(parts))
}

/**
 * Import a PEM-encoded RSA private key for use with the given algorithm.
 *
 * WebCrypto's `importKey('pkcs8', ...)` is fussy about hand-rolled
 * PrivateKeyInfo wrappers (Firefox/NSS rejects some otherwise-valid
 * RSA-OAEP PKCS#8 keys with "Operation is not supported"), so instead we
 * parse the PKCS#1 RSAPrivateKey fields directly — extracting them from the
 * PKCS#8 wrapper first if necessary — and import as a JWK, which is
 * supported consistently across browsers.
 */
async function importPrivateKey(pem, algorithm, usages) {
    const fields = getPrivateKeyFields(pem)
    const jwk = {
        kty: 'RSA',
        n: toBase64Url(fields.n),
        e: toBase64Url(fields.e),
        d: toBase64Url(fields.d),
        p: toBase64Url(fields.p),
        q: toBase64Url(fields.q),
        dp: toBase64Url(fields.dp),
        dq: toBase64Url(fields.dq),
        qi: toBase64Url(fields.qi),
        ext: true,
    }

    return crypto.subtle.importKey('jwk', jwk, algorithm, false, usages)
}

/** Parse the raw RSA integer fields (n, e, d, p, q, dp, dq, qi) out of a PEM-encoded private key. */
function getPrivateKeyFields(pem) {
    let der = pemToDer(pem)
    if (!pem.includes('BEGIN RSA PRIVATE KEY')) {
        der = extractPkcs1FromPkcs8(der)
    }

    return parsePkcs1RsaPrivateKey(der)
}

// --- Manual RSAES-PKCS1-v1.5 decryption (not implemented by WebCrypto) ---

/** Decrypt a raw RSA ciphertext block via CRT, returning the `modulusLength`-byte padded message (EM). */
function rsaDecryptRaw(ciphertext, fields, modulusLength) {
    const c = bytesToBigInt(ciphertext)
    const p = bytesToBigInt(fields.p)
    const q = bytesToBigInt(fields.q)
    const dp = bytesToBigInt(fields.dp)
    const dq = bytesToBigInt(fields.dq)
    const qi = bytesToBigInt(fields.qi)

    const m1 = modPow(c % p, dp, p)
    const m2 = modPow(c % q, dq, q)
    let h = ((m1 - m2) * qi) % p
    if (h < 0n) {
        h += p
    }
    const m = m2 + h * q

    return bigIntToBytes(m, modulusLength)
}

/** Strip PKCS#1 v1.5 padding (0x00 0x02 <random non-zero bytes> 0x00 <message>) from a decrypted block. */
function pkcs1v15Unpad(em) {
    if (em[0] !== 0x00 || em[1] !== 0x02) {
        throw new Error('Invalid PKCS#1 v1.5 padding')
    }

    let i = 2
    while (i < em.length && em[i] !== 0x00) {
        i++
    }
    if (i >= em.length) {
        throw new Error('Invalid PKCS#1 v1.5 padding')
    }

    return em.slice(i + 1)
}

function modPow(base, exponent, modulus) {
    let result = 1n
    let b = base % modulus
    let e = exponent
    while (e > 0n) {
        if (e & 1n) {
            result = (result * b) % modulus
        }
        e >>= 1n
        b = (b * b) % modulus
    }
    return result
}

function bytesToBigInt(bytes) {
    let result = 0n
    for (const b of bytes) {
        result = (result << 8n) | BigInt(b)
    }
    return result
}

function bigIntToBytes(num, length) {
    const bytes = new Uint8Array(length)
    for (let i = length - 1; i >= 0; i--) {
        bytes[i] = Number(num & 0xffn)
        num >>= 8n
    }
    return bytes
}

// --- DER / PEM helpers ---

/** Read a DER length field starting at `offset`, returning its value and how many bytes it occupied. */
function readDerLength(der, offset) {
    let length = der[offset]
    let headerLength = 1

    if (length & 0x80) {
        const numBytes = length & 0x7f
        length = 0
        for (let i = 0; i < numBytes; i++) {
            length = (length << 8) | der[offset + 1 + i]
        }
        headerLength = 1 + numBytes
    }

    return { length, headerLength }
}

/** Read a DER INTEGER at `offset`, stripping any leading sign-padding zero byte. */
function readDerInteger(der, offset) {
    if (der[offset] !== 0x02) {
        throw new Error('Expected DER INTEGER')
    }

    const { length, headerLength } = readDerLength(der, offset + 1)
    const start = offset + 1 + headerLength
    let bytes = der.slice(start, start + length)

    let i = 0
    while (i < bytes.length - 1 && bytes[i] === 0x00) {
        i++
    }

    return { bytes: bytes.slice(i), next: start + length }
}

/** Parse a PKCS#1 RSAPrivateKey DER structure into its named integer fields. */
function parsePkcs1RsaPrivateKey(der) {
    if (der[0] !== 0x30) {
        throw new Error('Expected DER SEQUENCE')
    }

    const { headerLength } = readDerLength(der, 1)
    let offset = 1 + headerLength

    // version
    let result = readDerInteger(der, offset)
    offset = result.next

    const fields = {}
    for (const name of ['n', 'e', 'd', 'p', 'q', 'dp', 'dq', 'qi']) {
        result = readDerInteger(der, offset)
        fields[name] = result.bytes
        offset = result.next
    }

    return fields
}

/** Extract the inner PKCS#1 RSAPrivateKey octet string from a PKCS#8 PrivateKeyInfo DER. */
function extractPkcs1FromPkcs8(der) {
    if (der[0] !== 0x30) {
        throw new Error('Expected DER SEQUENCE')
    }

    let { headerLength } = readDerLength(der, 1)
    let offset = 1 + headerLength

    // version
    let result = readDerInteger(der, offset)
    offset = result.next

    // privateKeyAlgorithm (AlgorithmIdentifier SEQUENCE) — skip over it
    if (der[offset] !== 0x30) {
        throw new Error('Expected AlgorithmIdentifier SEQUENCE')
    }
    const algLength = readDerLength(der, offset + 1)
    offset = offset + 1 + algLength.headerLength + algLength.length

    // privateKey (OCTET STRING) wraps the PKCS#1 RSAPrivateKey
    if (der[offset] !== 0x04) {
        throw new Error('Expected OCTET STRING')
    }
    const octetLength = readDerLength(der, offset + 1)
    const start = offset + 1 + octetLength.headerLength

    return der.slice(start, start + octetLength.length)
}

function pemToDer(pem) {
    const b64 = pem
        .replace(/-----BEGIN [^-]+-----/, '')
        .replace(/-----END [^-]+-----/, '')
        .replace(/\s+/g, '')

    return base64ToBytes(b64)
}

function concatBytes(arrays) {
    const total = arrays.reduce((sum, a) => sum + a.length, 0)
    const out = new Uint8Array(total)
    let offset = 0
    for (const a of arrays) {
        out.set(a, offset)
        offset += a.length
    }
    return out
}

function hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2)
    for (let i = 0; i < hex.length; i += 2) {
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16)
    }
    return bytes
}

function bytesToHex(bytes) {
    return Array.from(bytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
}

function base64ToBytes(b64) {
    const binary = atob(b64)
    const bytes = new Uint8Array(binary.length)
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i)
    }
    return bytes
}

function toBase64Url(bytes) {
    let binary = ''
    for (const b of bytes) {
        binary += String.fromCharCode(b)
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
