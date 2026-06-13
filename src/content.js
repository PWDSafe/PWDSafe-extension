// Two things happen here:
//  1. Listen for 'pwdsafe:fill' messages from the popup and fill the page's
//     login form.
//  2. If PWDSafe has saved credentials for this site, show a small lock icon
//     next to the username and password fields that opens an in-page picker.

const TEXT_LIKE_TYPES = new Set(['text', 'email', 'tel'])

function isTextLikeInput(el) {
    if (!(el instanceof HTMLInputElement)) {
        return false
    }
    const type = (el.getAttribute('type') || 'text').toLowerCase()
    return TEXT_LIKE_TYPES.has(type)
}

function isVisible(el) {
    return el.offsetParent !== null
}

function findUsernameField(passwordInput) {
    const scope = passwordInput.closest('form') || document
    const inputs = Array.from(scope.querySelectorAll('input'))

    const byAutocomplete = inputs.find(
        (el) => isTextLikeInput(el) && /username|email/i.test(el.autocomplete || ''),
    )
    if (byAutocomplete) {
        return byAutocomplete
    }

    const pwIndex = inputs.indexOf(passwordInput)
    for (let i = pwIndex - 1; i >= 0; i--) {
        if (isTextLikeInput(inputs[i])) {
            return inputs[i]
        }
    }

    return inputs.find((el, i) => i !== pwIndex && isTextLikeInput(el)) || null
}

/** Set an input's value via the native setter so framework (React/Vue) state updates too. */
function setNativeValue(input, value) {
    const proto = Object.getPrototypeOf(input)
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) {
        setter.call(input, value)
    } else {
        input.value = value
    }
    input.dispatchEvent(new Event('input', { bubbles: true }))
    input.dispatchEvent(new Event('change', { bubbles: true }))
}

function fillField(passwordInput, username, password) {
    const usernameInput = findUsernameField(passwordInput)
    if (usernameInput && username) {
        setNativeValue(usernameInput, username)
    }
    setNativeValue(passwordInput, password)
}

browser.runtime.onMessage.addListener((message) => {
    if (message.type !== 'pwdsafe:fill') {
        return
    }

    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible)
    if (passwordInputs.length === 0) {
        return
    }

    fillField(passwordInputs[0], message.username, message.password)
})

// --- In-page "fill" icon ---

let overlayRoot = null

// anchorField -> { icon, passwordField }
const icons = new Map()
let dropdown = null

function ensureOverlay() {
    if (overlayRoot) {
        return overlayRoot
    }

    const host = document.createElement('div')
    host.style.cssText = 'position:absolute; top:0; left:0; width:0; height:0;'
    document.documentElement.appendChild(host)

    // "open" mode so document-level listeners can use composedPath() to tell
    // whether a click landed inside our overlay (needed to avoid closing the
    // dropdown before its own click handlers run).
    const shadow = host.attachShadow({ mode: 'open' })
    const style = document.createElement('style')
    style.textContent = `
        .icon {
            position: fixed;
            width: 22px;
            height: 22px;
            border-radius: 4px;
            border: 1px solid rgba(0, 0, 0, 0.1);
            background: #fff;
            color: #1f2937;
            box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
            cursor: pointer;
            font-size: 13px;
            line-height: 1;
            display: flex;
            align-items: center;
            justify-content: center;
            z-index: 2147483647;
            padding: 0;
        }
        .icon:hover {
            background: #eff6ff;
        }
        .dropdown {
            position: fixed;
            min-width: 200px;
            max-width: 280px;
            max-height: 240px;
            overflow-y: auto;
            background: #fff;
            color: #1f2937;
            border: 1px solid #d1d5db;
            border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
            z-index: 2147483647;
            font-family: system-ui, sans-serif;
            font-size: 13px;
        }
        .item {
            display: flex;
            flex-direction: column;
            align-items: flex-start;
            width: 100%;
            border: none;
            background: none;
            text-align: left;
            padding: 6px 10px;
            cursor: pointer;
            box-sizing: border-box;
            color: inherit;
            font: inherit;
        }
        .item:hover {
            background: #eff6ff;
        }
        .item .site {
            font-weight: 500;
        }
        .item .user {
            color: #6b7280;
            font-size: 12px;
        }
        .empty {
            padding: 8px 10px;
            color: #6b7280;
        }
        .search {
            position: sticky;
            top: 0;
            font: inherit;
            padding: 6px 10px;
            border: none;
            border-bottom: 1px solid #d1d5db;
            box-sizing: border-box;
            width: 100%;
            background: #fff;
            color: inherit;
        }
        .search:focus {
            outline: none;
        }
        .unlock-form {
            display: flex;
            flex-direction: column;
            gap: 6px;
            padding: 8px 10px;
            box-sizing: border-box;
        }
        .unlock-label {
            font-weight: 500;
        }
        .unlock-form input {
            font: inherit;
            padding: 4px 6px;
            border: 1px solid #d1d5db;
            border-radius: 4px;
            box-sizing: border-box;
            width: 100%;
        }
        .unlock-error {
            color: #dc2626;
            font-size: 12px;
        }
        .unlock-error.hidden {
            display: none;
        }
        .unlock-actions {
            display: flex;
            justify-content: flex-end;
            gap: 6px;
        }
        .unlock-actions button {
            font: inherit;
            padding: 4px 10px;
            border: 1px solid #d1d5db;
            border-radius: 4px;
            background: #fff;
            cursor: pointer;
            color: inherit;
        }
        .unlock-actions button:hover {
            background: #eff6ff;
        }
        .unlock-actions button[type="submit"] {
            background: #2563eb;
            border-color: #2563eb;
            color: #fff;
        }
        .unlock-actions button[type="submit"]:hover {
            background: #1d4ed8;
        }

        @media (prefers-color-scheme: dark) {
            .icon {
                background: #27272a;
                color: #f3f4f6;
                border-color: rgba(255, 255, 255, 0.15);
                box-shadow: 0 1px 3px rgba(0, 0, 0, 0.6);
            }
            .icon:hover {
                background: #3f3f46;
            }
            .dropdown {
                background: #27272a;
                color: #f3f4f6;
                border-color: #3f3f46;
                box-shadow: 0 4px 12px rgba(0, 0, 0, 0.5);
            }
            .item:hover {
                background: #3f3f46;
            }
            .item .user {
                color: #a1a1aa;
            }
            .empty {
                color: #a1a1aa;
            }
            .search {
                background: #27272a;
                border-color: #3f3f46;
            }
            .unlock-form input {
                background: #18181b;
                color: #f3f4f6;
                border-color: #3f3f46;
            }
            .unlock-actions button {
                background: #27272a;
                border-color: #3f3f46;
                color: inherit;
            }
            .unlock-actions button:hover {
                background: #3f3f46;
            }
            .unlock-actions button[type="submit"] {
                background: #2563eb;
                border-color: #2563eb;
                color: #fff;
            }
            .unlock-actions button[type="submit"]:hover {
                background: #1d4ed8;
            }
        }
    `
    shadow.appendChild(style)

    overlayRoot = shadow
    return overlayRoot
}

function positionIcon(field, icon) {
    const rect = field.getBoundingClientRect()
    icon.style.top = `${rect.top + (rect.height - 22) / 2}px`
    icon.style.left = `${rect.right - 26}px`
}

function repositionAll() {
    for (const [field, { icon }] of icons) {
        if (isVisible(field)) {
            positionIcon(field, icon)
        }
    }
    if (dropdown) {
        positionDropdown(dropdown.el, dropdown.anchorIcon)
    }
}

function positionDropdown(el, icon) {
    const rect = icon.getBoundingClientRect()
    el.style.top = `${rect.bottom + 4}px`
    el.style.left = `${Math.max(4, rect.right - 240)}px`
}

function closeDropdown() {
    if (dropdown) {
        dropdown.el.remove()
        document.removeEventListener('mousedown', onOutsideClick, true)
        dropdown = null
    }
}

function onOutsideClick(e) {
    if (!dropdown) {
        return
    }

    const path = e.composedPath()
    if (path.includes(dropdown.el)) {
        return
    }
    for (const { icon } of icons.values()) {
        if (path.includes(icon)) {
            return
        }
    }

    closeDropdown()
}

async function toggleDropdown(passwordField, icon) {
    if (dropdown) {
        const wasThis = dropdown.anchorIcon === icon
        closeDropdown()
        if (wasThis) {
            return
        }
    }

    const root = ensureOverlay()
    const el = document.createElement('div')
    el.className = 'dropdown empty'
    el.textContent = 'Loading…'
    root.appendChild(el)
    positionDropdown(el, icon)

    dropdown = { el, anchorIcon: icon }
    document.addEventListener('mousedown', onOutsideClick, true)

    let matches = []
    try {
        matches = await browser.runtime.sendMessage({ type: 'tab:matches', payload: { url: location.href } })
    } catch {
        // background unavailable
    }

    if (!dropdown || dropdown.el !== el) {
        return // closed while loading
    }

    const entries = matches.flatMap((group) =>
        group.credentials.map((cred) => ({ ...cred, accountId: group.accountId, locked: group.locked })),
    )

    renderEntryList(el, entries, passwordField)
}

const SEARCH_THRESHOLD = 6

function renderEntryList(el, entries, passwordField) {
    el.textContent = ''
    el.classList.remove('empty')

    if (entries.length === 0) {
        el.classList.add('empty')
        el.textContent = 'No saved credentials for this site'
        return
    }

    const list = document.createElement('div')

    let searchInput = null
    if (entries.length > SEARCH_THRESHOLD) {
        searchInput = document.createElement('input')
        searchInput.type = 'search'
        searchInput.className = 'search'
        searchInput.placeholder = 'Filter…'
        searchInput.autocomplete = 'off'
        searchInput.spellcheck = false
        searchInput.addEventListener('keydown', (e) => e.stopPropagation())
        searchInput.addEventListener('input', () => {
            renderItems(searchInput.value)
            if (dropdown) {
                positionDropdown(el, dropdown.anchorIcon)
            }
        })
        el.appendChild(searchInput)
    }

    el.appendChild(list)

    function renderItems(filter) {
        list.textContent = ''

        const query = filter.trim().toLowerCase()
        const filtered = query
            ? entries.filter(
                  (cred) =>
                      cred.site.toLowerCase().includes(query) || cred.username.toLowerCase().includes(query),
              )
            : entries

        if (filtered.length === 0) {
            const empty = document.createElement('div')
            empty.className = 'empty'
            empty.textContent = 'No matches'
            list.appendChild(empty)
            return
        }

        for (const cred of filtered) {
            const item = document.createElement('button')
            item.className = 'item'
            item.type = 'button'

            const site = document.createElement('span')
            site.className = 'site'
            site.textContent = cred.site

            const user = document.createElement('span')
            user.className = 'user'
            user.textContent = cred.username

            item.append(site, user)
            item.addEventListener('click', async () => {
                if (cred.locked) {
                    renderUnlockForm(el, cred, entries, passwordField)
                    return
                }
                item.disabled = true
                try {
                    const resp = await browser.runtime.sendMessage({
                        type: 'credential:decrypt',
                        payload: { accountId: cred.accountId, credentialId: cred.id },
                    })
                    if (resp.status === 'ok') {
                        fillField(passwordField, resp.username, resp.password)
                        closeDropdown()
                    } else {
                        console.error('PWDSafe: could not decrypt credential', resp)
                        item.disabled = false
                    }
                } catch (err) {
                    console.error('PWDSafe: failed to fill credential', err)
                    item.disabled = false
                }
            })

            list.appendChild(item)
        }
    }

    renderItems('')

    if (searchInput) {
        setTimeout(() => searchInput.focus(), 0)
    }
}

function renderUnlockForm(el, cred, entries, passwordField) {
    el.textContent = ''
    el.classList.remove('empty')

    const form = document.createElement('form')
    form.className = 'unlock-form'
    form.autocomplete = 'off'

    const label = document.createElement('div')
    label.className = 'unlock-label'
    label.textContent = `Unlock to fill ${cred.username}`

    const input = document.createElement('input')
    // Start as type="text" so Firefox's saved-login autofill (which scans
    // for type="password" fields as soon as they appear, even inside a
    // shadow root) doesn't match this field against the page's saved
    // password. Switched to "password" right after insertion, before the
    // user can type.
    input.type = 'text'
    input.placeholder = 'Vault password'
    input.name = 'pwdsafe-vault-password'
    input.autocomplete = 'new-password'
    input.setAttribute('autocorrect', 'off')
    input.setAttribute('autocapitalize', 'off')
    input.spellcheck = false
    input.readOnly = true
    input.addEventListener('focus', () => {
        input.readOnly = false
    }, { once: true })

    const error = document.createElement('div')
    error.className = 'unlock-error hidden'

    const cancelBtn = document.createElement('button')
    cancelBtn.type = 'button'
    cancelBtn.textContent = 'Cancel'
    cancelBtn.addEventListener('click', () => renderEntryList(el, entries, passwordField))

    const submitBtn = document.createElement('button')
    submitBtn.type = 'submit'
    submitBtn.textContent = 'Unlock'

    const actions = document.createElement('div')
    actions.className = 'unlock-actions'
    actions.append(cancelBtn, submitBtn)

    form.append(label, input, error, actions)
    el.appendChild(form)

    if (dropdown) {
        positionDropdown(el, dropdown.anchorIcon)
    }
    setTimeout(() => {
        input.type = 'password'
        input.focus()
    }, 0)

    form.addEventListener('submit', async (e) => {
        e.preventDefault()
        submitBtn.disabled = true
        cancelBtn.disabled = true
        input.disabled = true
        error.classList.add('hidden')

        try {
            const unlockResp = await browser.runtime.sendMessage({
                type: 'accounts:unlock',
                payload: { accountId: cred.accountId, vaultPassword: input.value },
            })
            if (unlockResp.status !== 'ok') {
                throw new Error('incorrect password')
            }

            const resp = await browser.runtime.sendMessage({
                type: 'credential:decrypt',
                payload: { accountId: cred.accountId, credentialId: cred.id },
            })
            if (resp.status !== 'ok') {
                throw new Error('decrypt failed')
            }

            fillField(passwordField, resp.username, resp.password)
            closeDropdown()
        } catch {
            error.textContent = 'Incorrect password'
            error.classList.remove('hidden')
            submitBtn.disabled = false
            cancelBtn.disabled = false
            input.disabled = false
            input.value = ''
            input.focus()
        }
    })
}

function createIcon(anchorField, passwordField) {
    const root = ensureOverlay()
    const icon = document.createElement('button')
    icon.className = 'icon'
    icon.type = 'button'
    icon.title = 'Fill with PWDSafe'
    icon.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
        <path fill-rule="evenodd" d="M12 1.5a5.25 5.25 0 00-5.25 5.25v3a3 3 0 00-3 3v6.75a3 3 0 003 3h10.5a3 3 0 003-3v-6.75a3 3 0 00-3-3v-3c0-2.9-2.35-5.25-5.25-5.25zm3.75 8.25v-3a3.75 3.75 0 10-7.5 0v3h7.5z" clip-rule="evenodd"/>
    </svg>`
    icon.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        toggleDropdown(passwordField, icon)
    })
    root.appendChild(icon)
    positionIcon(anchorField, icon)
    icons.set(anchorField, { icon, passwordField })
}

let hasMatches = null

async function checkHasMatches() {
    if (hasMatches !== null) {
        return hasMatches
    }
    try {
        const matches = await browser.runtime.sendMessage({ type: 'tab:matches', payload: { url: location.href } })
        hasMatches = Array.isArray(matches) && matches.some((g) => g.credentials.length > 0)
    } catch {
        hasMatches = false
    }
    return hasMatches
}

async function scan() {
    if (!(await checkHasMatches())) {
        return
    }

    const passwordInputs = Array.from(document.querySelectorAll('input[type="password"]')).filter(isVisible)
    const wantedAnchors = new Set()

    for (const passwordField of passwordInputs) {
        wantedAnchors.add(passwordField)
        if (!icons.has(passwordField)) {
            createIcon(passwordField, passwordField)
        }

        const usernameField = findUsernameField(passwordField)
        if (usernameField && isVisible(usernameField)) {
            wantedAnchors.add(usernameField)
            if (!icons.has(usernameField)) {
                createIcon(usernameField, passwordField)
            }
        }
    }

    for (const [anchor, { icon }] of icons) {
        if (!document.contains(anchor) || !isVisible(anchor) || !wantedAnchors.has(anchor)) {
            icon.remove()
            icons.delete(anchor)
            if (dropdown?.anchorIcon === icon) {
                closeDropdown()
            }
        }
    }

    repositionAll()
}

const observer = new MutationObserver(() => scan())
observer.observe(document.documentElement, { childList: true, subtree: true })

window.addEventListener('scroll', repositionAll, true)
window.addEventListener('resize', repositionAll)

scan()
