const accountsEl = document.getElementById('accounts')
const form = document.getElementById('login-form')
const urlInput = document.getElementById('url')
const emailInput = document.getElementById('email')
const passwordInput = document.getElementById('password')
const totpRow = document.getElementById('totp-row')
const totpInput = document.getElementById('totp')
const submitBtn = document.getElementById('submit')
const messageEl = document.getElementById('message')

function showMessage(text, isError) {
    messageEl.textContent = text
    messageEl.classList.toggle('error', !!isError)
    messageEl.classList.remove('hidden')
}

function hideMessage() {
    messageEl.classList.add('hidden')
}

async function renderAccounts() {
    const accounts = await browser.runtime.sendMessage({ type: 'accounts:list' })
    accountsEl.innerHTML = ''

    if (accounts.length === 0) {
        accountsEl.innerHTML = '<p class="empty">No accounts configured yet.</p>'
        return
    }

    for (const account of accounts) {
        const row = document.createElement('div')
        row.className = 'account-row'

        const info = document.createElement('div')
        info.className = 'account-info'
        const email = document.createElement('strong')
        email.textContent = account.email
        const url = document.createElement('span')
        url.textContent = account.url
        info.append(email, url)
        row.appendChild(info)

        const status = document.createElement('span')
        status.className = `status ${account.locked ? 'locked' : 'unlocked'}`
        status.textContent = account.locked ? 'Locked' : 'Unlocked'
        row.appendChild(status)

        if (account.locked) {
            const pwInput = document.createElement('input')
            pwInput.type = 'password'
            pwInput.placeholder = 'Vault password'

            const unlockBtn = document.createElement('button')
            unlockBtn.textContent = 'Unlock'
            unlockBtn.addEventListener('click', async () => {
                unlockBtn.disabled = true
                try {
                    const resp = await browser.runtime.sendMessage({
                        type: 'accounts:unlock',
                        payload: { accountId: account.id, vaultPassword: pwInput.value },
                    })
                    if (resp.status === 'ok') {
                        await renderAccounts()
                    } else {
                        unlockBtn.disabled = false
                        pwInput.value = ''
                        pwInput.placeholder = 'Incorrect password'
                    }
                } catch (err) {
                    unlockBtn.disabled = false
                    pwInput.value = ''
                    pwInput.placeholder = err.message || 'Incorrect password'
                }
            })
            pwInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') {
                    unlockBtn.click()
                }
            })

            row.append(pwInput, unlockBtn)
        } else {
            const lockBtn = document.createElement('button')
            lockBtn.className = 'secondary'
            lockBtn.textContent = 'Lock'
            lockBtn.addEventListener('click', async () => {
                await browser.runtime.sendMessage({ type: 'accounts:lock', payload: { accountId: account.id } })
                await renderAccounts()
            })
            row.appendChild(lockBtn)
        }

        const removeBtn = document.createElement('button')
        removeBtn.className = 'danger'
        removeBtn.textContent = 'Remove'
        removeBtn.addEventListener('click', async () => {
            if (!confirm(`Remove account ${account.email}?`)) {
                return
            }
            await browser.runtime.sendMessage({ type: 'accounts:remove', payload: { accountId: account.id } })
            await renderAccounts()
        })
        row.appendChild(removeBtn)

        accountsEl.appendChild(row)
    }
}

form.addEventListener('submit', async (e) => {
    e.preventDefault()
    hideMessage()
    submitBtn.disabled = true
    submitBtn.textContent = 'Signing in…'

    try {
        const resp = await browser.runtime.sendMessage({
            type: 'accounts:login',
            payload: {
                url: urlInput.value.trim(),
                email: emailInput.value.trim(),
                password: passwordInput.value,
                totpCode: totpInput.value.trim() || undefined,
            },
        })

        if (resp.status === 'needs_2fa') {
            totpRow.classList.remove('hidden')
            totpInput.focus()
            showMessage('Enter your two-factor authentication code.', false)
            return
        }

        if (resp.status === 'needs_vault_password') {
            showMessage('Signed in. Enter your safe password below to unlock this account.', false)
        }

        form.reset()
        totpRow.classList.add('hidden')
        await renderAccounts()
    } catch (err) {
        showMessage(err.message || 'Sign in failed.', true)
    } finally {
        submitBtn.disabled = false
        submitBtn.textContent = 'Sign in'
    }
})

renderAccounts()
