const contentEl = document.getElementById('content')
const searchInput = document.getElementById('search')

document.getElementById('open-options').addEventListener('click', () => {
    browser.runtime.openOptionsPage()
})

let activeTab = null
let searchDebounce = null

async function getActiveTab() {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true })
    return tab
}

function flashFeedback(button, text) {
    const original = button.textContent
    button.textContent = text
    setTimeout(() => {
        button.textContent = original
    }, 1000)
}

/**
 * Ensure `group`'s account is unlocked, prompting inline for the vault
 * password if it isn't. Resolves to `true` once unlocked, or `false` if the
 * user cancels. Concurrent callers for the same group share one prompt.
 */
function ensureUnlocked(group, section) {
    if (!group.locked) {
        return Promise.resolve(true)
    }
    if (group.unlockPromise) {
        return group.unlockPromise
    }

    group.unlockPromise = new Promise((resolve) => {
        const row = document.createElement('div')
        row.className = 'unlock-row'

        const input = document.createElement('input')
        input.type = 'password'
        input.placeholder = 'Vault password'

        const button = document.createElement('button')
        button.type = 'button'
        button.textContent = 'Unlock'

        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.title = 'Cancel'
        cancel.textContent = '✕'

        async function attempt() {
            button.disabled = true
            cancel.disabled = true
            input.disabled = true
            try {
                const resp = await browser.runtime.sendMessage({
                    type: 'accounts:unlock',
                    payload: { accountId: group.accountId, vaultPassword: input.value },
                })
                if (resp.status === 'ok') {
                    group.locked = false
                    group.unlockPromise = null
                    row.remove()
                    resolve(true)
                    return
                }
            } catch {
                // fall through to error display
            }
            button.disabled = false
            cancel.disabled = false
            input.disabled = false
            input.value = ''
            input.placeholder = 'Incorrect password'
            input.focus()
        }

        button.addEventListener('click', attempt)
        input.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                attempt()
            }
        })
        cancel.addEventListener('click', () => {
            group.unlockPromise = null
            row.remove()
            resolve(false)
        })

        row.append(input, button, cancel)
        section.insertBefore(row, section.children[1] || null)
        input.focus()
    })

    return group.unlockPromise
}

function renderCredentialRow(group, cred, section) {
    const row = document.createElement('div')
    row.className = 'credential'

    const main = document.createElement('button')
    main.className = 'cred-main'
    main.title = 'Fill into this page'

    const site = document.createElement('span')
    site.className = 'site'
    site.textContent = cred.site

    const user = document.createElement('span')
    user.className = 'user'
    user.textContent = cred.username

    main.append(site, user)
    row.appendChild(main)

    const actions = document.createElement('div')
    actions.className = 'cred-actions'

    const revealEl = document.createElement('div')
    revealEl.className = 'cred-reveal hidden'

    const revealBtn = document.createElement('button')
    revealBtn.className = 'icon-btn'
    revealBtn.title = 'Show password'
    revealBtn.textContent = '👁'

    const copyUserBtn = document.createElement('button')
    copyUserBtn.className = 'icon-btn'
    copyUserBtn.title = 'Copy username'
    copyUserBtn.textContent = '👤'

    const copyPassBtn = document.createElement('button')
    copyPassBtn.className = 'icon-btn'
    copyPassBtn.title = 'Copy password'
    copyPassBtn.textContent = '🔑'

    async function decrypt() {
        const resp = await browser.runtime.sendMessage({
            type: 'credential:decrypt',
            payload: { accountId: group.accountId, credentialId: cred.id },
        })
        if (resp.status !== 'ok') {
            throw new Error('locked')
        }
        return resp
    }

    main.addEventListener('click', async () => {
        if (!activeTab) return
        if (group.locked && !(await ensureUnlocked(group, section))) {
            return
        }
        main.disabled = true
        try {
            const resp = await browser.runtime.sendMessage({
                type: 'credential:fill',
                payload: { accountId: group.accountId, credentialId: cred.id, tabId: activeTab.id },
            })
            if (resp.status === 'ok') {
                window.close()
            } else {
                console.error('PWDSafe: could not fill credential', resp)
                main.disabled = false
            }
        } catch (err) {
            console.error('PWDSafe: failed to fill credential', err)
            main.disabled = false
        }
    })

    copyUserBtn.addEventListener('click', async () => {
        await navigator.clipboard.writeText(cred.username || '')
        flashFeedback(copyUserBtn, '✅')
    })

    copyPassBtn.addEventListener('click', async () => {
        if (group.locked && !(await ensureUnlocked(group, section))) {
            return
        }
        copyPassBtn.disabled = true
        try {
            const { password } = await decrypt()
            await navigator.clipboard.writeText(password)
            flashFeedback(copyPassBtn, '✅')
        } catch {
            flashFeedback(copyPassBtn, '⚠️')
        } finally {
            copyPassBtn.disabled = false
        }
    })

    revealBtn.addEventListener('click', async () => {
        if (!revealEl.classList.contains('hidden')) {
            revealEl.classList.add('hidden')
            revealEl.textContent = ''
            return
        }
        if (group.locked && !(await ensureUnlocked(group, section))) {
            return
        }
        revealBtn.disabled = true
        try {
            const { password } = await decrypt()
            revealEl.textContent = password
            revealEl.classList.remove('hidden')
            revealEl.title = 'Click to copy'
        } catch {
            flashFeedback(revealBtn, '⚠️')
        } finally {
            revealBtn.disabled = false
        }
    })

    revealEl.addEventListener('click', async () => {
        await navigator.clipboard.writeText(revealEl.textContent)
        flashFeedback(revealEl, 'Copied!')
    })

    actions.append(revealBtn, copyUserBtn, copyPassBtn)
    row.appendChild(actions)
    row.appendChild(revealEl)

    return row
}

function renderGroups(groups, emptyMessage) {
    contentEl.innerHTML = ''

    if (groups.length === 0) {
        const empty = document.createElement('p')
        empty.className = 'empty'
        empty.textContent = emptyMessage
        contentEl.appendChild(empty)
        return
    }

    for (const group of groups) {
        const section = document.createElement('div')
        section.className = 'account'

        const heading = document.createElement('div')
        heading.className = 'account-label'
        heading.textContent = group.label
        section.appendChild(heading)

        for (const cred of group.credentials) {
            section.appendChild(renderCredentialRow(group, cred, section))
        }

        contentEl.appendChild(section)
    }
}

async function renderMatches() {
    if (!activeTab?.url || !/^https?:/.test(activeTab.url)) {
        contentEl.innerHTML = '<p class="empty">No matches on this page.</p>'
        return
    }

    const accounts = await browser.runtime.sendMessage({ type: 'accounts:list' })
    if (accounts.length === 0) {
        contentEl.innerHTML =
            '<p class="empty">No PWDSafe accounts configured.<br><a id="setup" href="#">Add one</a>.</p>'
        document.getElementById('setup').addEventListener('click', (e) => {
            e.preventDefault()
            browser.runtime.openOptionsPage()
        })
        return
    }

    const matches = await browser.runtime.sendMessage({ type: 'tab:matches', payload: { url: activeTab.url } })
    renderGroups(
        matches,
        'No saved credentials for this site. If a credential for it exists but doesn’t mention this domain, try searching for it above.',
    )
}

async function runSearch(query) {
    contentEl.innerHTML = '<p class="empty">Searching…</p>'
    const results = await browser.runtime.sendMessage({ type: 'accounts:search', payload: { query } })
    renderGroups(results, 'No credentials match your search.')
}

searchInput.addEventListener('input', () => {
    clearTimeout(searchDebounce)
    const query = searchInput.value.trim()
    searchDebounce = setTimeout(() => {
        if (query) {
            runSearch(query)
        } else {
            renderMatches()
        }
    }, 200)
})

async function init() {
    activeTab = await getActiveTab()
    await renderMatches()
}

init()
