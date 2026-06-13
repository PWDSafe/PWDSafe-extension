// Persistence for configured PWDSafe accounts.
//
// - browser.storage.local holds account metadata: server URL, email, the
//   Sanctum bearer token, and the (still-encrypted) vault key material
//   (encrypted_privkey, salt, pubkey). All of this is the same data the
//   PWDSafe server itself stores, so it's safe at rest.
// - browser.storage.session holds the *decrypted* RSA private key PEM per
//   account, in memory only. It is cleared when the browser closes, so a
//   vault password is needed again on next browser start ("locked").

const ACCOUNTS_KEY = 'pwdsafe_accounts'
const UNLOCKED_KEY = 'pwdsafe_unlocked_privkeys'

/** @returns {Promise<Array<object>>} */
export async function getAccounts() {
    const result = await browser.storage.local.get(ACCOUNTS_KEY)
    return result[ACCOUNTS_KEY] || []
}

/** @param {Array<object>} accounts */
export async function saveAccounts(accounts) {
    await browser.storage.local.set({ [ACCOUNTS_KEY]: accounts })
}

export async function addAccount(account) {
    const accounts = await getAccounts()
    accounts.push(account)
    await saveAccounts(accounts)
}

export async function getAccount(id) {
    const accounts = await getAccounts()
    return accounts.find((a) => a.id === id) || null
}

export async function removeAccount(id) {
    const accounts = await getAccounts()
    await saveAccounts(accounts.filter((a) => a.id !== id))
    await clearUnlockedKey(id)
}

/** @returns {Promise<Record<string, string>>} map of account id -> decrypted private key PEM */
export async function getUnlockedKeys() {
    const result = await browser.storage.session.get(UNLOCKED_KEY)
    return result[UNLOCKED_KEY] || {}
}

export async function setUnlockedKey(id, privkeyPem) {
    const keys = await getUnlockedKeys()
    keys[id] = privkeyPem
    await browser.storage.session.set({ [UNLOCKED_KEY]: keys })
}

export async function clearUnlockedKey(id) {
    const keys = await getUnlockedKeys()
    delete keys[id]
    await browser.storage.session.set({ [UNLOCKED_KEY]: keys })
}
