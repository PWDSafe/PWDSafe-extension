import * as api from './lib/api.js'
import {
    deriveVaultKey,
    deriveLoginHash,
    deriveLoginHashIndependent,
    decryptPrivkey,
    decryptCredential,
} from './lib/crypto.js'
import {
    getAccounts,
    addAccount,
    getAccount,
    removeAccount,
    getUnlockedKeys,
    setUnlockedKey,
    clearUnlockedKey,
} from './lib/storage.js'

const DEVICE_NAME = 'Firefox extension'

function normalizeUrl(url) {
    return url.trim().replace(/\/+$/, '')
}

/**
 * Candidate substrings to match against the "url" field of credentials,
 * derived from a page hostname. The server matches with
 * `url LIKE %domain%`, so we pass progressively shorter suffixes
 * (registrable-domain-ish) so that e.g. a credential for "example.com"
 * still matches a page on "accounts.example.com", and vice versa.
 */
function domainCandidates(hostname) {
    const labels = hostname.split('.')
    const candidates = [hostname]
    if (labels.length > 2) {
        candidates.push(labels.slice(-2).join('.'))
    }
    if (labels.length > 3) {
        candidates.push(labels.slice(-3).join('.'))
    }
    return [...new Set(candidates)]
}

/**
 * Extract candidate hostnames/IPs from a credential's "url" field. The
 * field may be empty, a full URL, a "host/path" string, just a hostname,
 * or a human label that mentions a host anywhere in it (e.g.
 * "Portainer (192.168.130.3:9443)"), so every delimiter-separated token
 * is treated as a candidate.
 */
function extractHostnames(url) {
    return (url ?? '')
        .trim()
        .toLowerCase()
        .split(/[\s/:?#()]+/)
        .filter(Boolean)
}

/**
 * Whether `siteHost` (from a credential's url) is relevant to `hostname`
 * (the current page). The broad `LIKE %domain%` search can return unrelated
 * sibling subdomains (e.g. "other.example.com" when matching against
 * "example.com" derived from "mail.example.com"), so this restricts
 * results to the same host, a parent domain of it, or a subdomain of it.
 */
function isRelatedDomain(hostname, siteHost) {
    return (
        siteHost === hostname ||
        hostname.endsWith(`.${siteHost}`) ||
        siteHost.endsWith(`.${hostname}`)
    )
}

/**
 * Sign in to a PWDSafe instance and store it as a new account.
 * Mirrors resources/js/login.js's client-side login-hash derivation.
 */
async function loginAccount({ url, email, password, totpCode }) {
    const baseUrl = normalizeUrl(url)
    const pre = await api.preflight(baseUrl, email)

    let vaultKey, loginHash
    if (pre.salt) {
        vaultKey = await deriveVaultKey(password, pre.salt)
        loginHash = await deriveLoginHash(vaultKey, password)
    }

    let loginPassword
    if (pre.separate_vault_password && pre.login_salt) {
        loginPassword = await deriveLoginHashIndependent(password, pre.login_salt)
    } else if (pre.uses_login_hash && loginHash) {
        loginPassword = loginHash
    } else {
        loginPassword = password
    }

    let loginResp
    try {
        loginResp = await api.login(baseUrl, {
            email,
            password: loginPassword,
            device_name: DEVICE_NAME,
            ...(totpCode ? { totp_code: totpCode } : {}),
        })
    } catch (err) {
        if (err instanceof api.ApiError && err.data?.needs_2fa) {
            return { status: 'needs_2fa' }
        }
        throw err
    }

    const account = {
        id: crypto.randomUUID(),
        url: baseUrl,
        email,
        token: loginResp.token,
        pubkey: loginResp.vault_data?.pubkey ?? null,
        encryptedPrivkey: loginResp.vault_data?.encrypted_privkey ?? null,
        vaultSalt: loginResp.vault_data?.salt ?? null,
    }

    await addAccount(account)

    // Case 1 (most common): the login password also derives the vault key,
    // so unlock immediately. If it's wrong (separate vault password), the
    // account stays locked until the user enters the vault/safe password.
    if (vaultKey && account.encryptedPrivkey) {
        try {
            const privkeyPem = await decryptPrivkey(account.encryptedPrivkey, vaultKey)
            await setUnlockedKey(account.id, privkeyPem)
            return { status: 'ok', accountId: account.id }
        } catch {
            // fall through
        }
    }

    return { status: 'needs_vault_password', accountId: account.id }
}

/** Unlock a previously-added account using its vault/safe password. */
async function unlockAccount(accountId, vaultPassword) {
    const account = await getAccount(accountId)
    if (!account) {
        throw new Error('Unknown account')
    }
    if (!account.encryptedPrivkey || !account.vaultSalt) {
        throw new Error('This account has no vault configured yet.')
    }

    const vaultKey = await deriveVaultKey(vaultPassword, account.vaultSalt)
    const privkeyPem = await decryptPrivkey(account.encryptedPrivkey, vaultKey)
    await setUnlockedKey(accountId, privkeyPem)

    return { status: 'ok' }
}

async function lockAccount(accountId) {
    await clearUnlockedKey(accountId)
    return { status: 'ok' }
}

async function removeAccountAndLogout(accountId) {
    const account = await getAccount(accountId)
    if (account) {
        try {
            await api.logout(account.url, account.token)
        } catch {
            // best effort — still remove locally even if the server call fails
        }
    }
    await removeAccount(accountId)
    return { status: 'ok' }
}

async function listAccounts() {
    const accounts = await getAccounts()
    const unlocked = await getUnlockedKeys()
    return accounts.map((a) => ({
        id: a.id,
        url: a.url,
        email: a.email,
        locked: !unlocked[a.id],
    }))
}

/**
 * Find credentials across all configured accounts matching the given page URL.
 */
async function getMatchesForUrl(url) {
    let hostname
    try {
        hostname = new URL(url).hostname
    } catch {
        return []
    }

    const accounts = await getAccounts()
    const unlocked = await getUnlockedKeys()
    const candidates = domainCandidates(hostname)

    const results = []
    for (const account of accounts) {
        const seen = new Set()
        const credentials = []

        for (const domain of candidates) {
            try {
                const found = await api.searchCredentials(account.url, account.token, { domain })
                for (const c of found) {
                    if (
                        !seen.has(c.id) &&
                        extractHostnames(c.url).some((h) => isRelatedDomain(hostname, h))
                    ) {
                        seen.add(c.id)
                        credentials.push(c)
                    }
                }
            } catch {
                // skip this account/candidate on error (e.g. expired token, offline)
            }
        }

        if (credentials.length > 0) {
            results.push({
                accountId: account.id,
                label: `${account.email} — ${new URL(account.url).hostname}`,
                locked: !unlocked[account.id],
                credentials,
            })
        }
    }

    return results
}

/**
 * Search for credentials by free-text query across all configured accounts,
 * regardless of the current page. Used by the popup's search box.
 */
async function searchAccounts(query) {
    const accounts = await getAccounts()
    const unlocked = await getUnlockedKeys()

    const results = []
    for (const account of accounts) {
        try {
            const found = await api.searchCredentials(account.url, account.token, { q: query })
            if (found.length > 0) {
                results.push({
                    accountId: account.id,
                    label: `${account.email} — ${new URL(account.url).hostname}`,
                    locked: !unlocked[account.id],
                    credentials: found,
                })
            }
        } catch {
            // skip this account on error (e.g. expired token, offline)
        }
    }

    return results
}

/** Fetch and decrypt a credential's username/password. */
async function decryptCredentialById(accountId, credentialId) {
    const account = await getAccount(accountId)
    if (!account) {
        throw new Error('Unknown account')
    }

    const unlocked = await getUnlockedKeys()
    const privkeyPem = unlocked[accountId]
    if (!privkeyPem) {
        return { status: 'locked' }
    }

    const credential = await api.getCredential(account.url, account.token, credentialId)
    const password = await decryptCredential(credential.data, privkeyPem)

    return { status: 'ok', username: credential.username, password }
}

/** Decrypt a credential and send it to the content script to fill in. */
async function fillCredential(accountId, credentialId, tabId) {
    const result = await decryptCredentialById(accountId, credentialId)
    if (result.status !== 'ok') {
        return result
    }

    await browser.tabs.sendMessage(tabId, {
        type: 'pwdsafe:fill',
        username: result.username,
        password: result.password,
    })

    return { status: 'ok' }
}

async function updateBadge(tabId, url) {
    if (!url || !(url.startsWith('http://') || url.startsWith('https://'))) {
        await browser.action.setBadgeText({ tabId, text: '' })
        return
    }

    try {
        const matches = await getMatchesForUrl(url)
        const count = matches.reduce((sum, m) => sum + m.credentials.length, 0)
        await browser.action.setBadgeBackgroundColor({ color: '#2563eb' })
        await browser.action.setBadgeText({ tabId, text: count ? String(count) : '' })
    } catch {
        await browser.action.setBadgeText({ tabId, text: '' })
    }
}

browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    if (changeInfo.status === 'complete') {
        updateBadge(tabId, tab.url)
    }
})

browser.tabs.onActivated.addListener(({ tabId }) => {
    browser.tabs.get(tabId).then((tab) => updateBadge(tabId, tab.url))
})

browser.runtime.onMessage.addListener((message, sender) => {
    switch (message.type) {
        case 'accounts:list':
            return listAccounts()
        case 'accounts:login':
            return loginAccount(message.payload)
        case 'accounts:unlock':
            return unlockAccount(message.payload.accountId, message.payload.vaultPassword)
        case 'accounts:lock':
            return lockAccount(message.payload.accountId)
        case 'accounts:remove':
            return removeAccountAndLogout(message.payload.accountId)
        case 'tab:matches':
            return getMatchesForUrl(message.payload.url)
        case 'accounts:search':
            return searchAccounts(message.payload.query)
        case 'credential:decrypt':
            return decryptCredentialById(message.payload.accountId, message.payload.credentialId)
        case 'credential:fill':
            return fillCredential(
                message.payload.accountId,
                message.payload.credentialId,
                message.payload.tabId ?? sender.tab?.id,
            )
        default:
            return undefined
    }
})
