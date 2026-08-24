import { AUTH, HTTP_AUTH, NWT } from 'libp2r2p/kind'

export const READ_ONLY_TEMPORARY_ACCOUNT = 'READ_ONLY_TEMPORARY_ACCOUNT'
export const READ_ONLY_ACCOUNT = 'READ_ONLY_ACCOUNT'
export const VAULT_LOCKED = 'VAULT_LOCKED'

// Public-key reads never require a signer, so they are always allowed.
const PUBLIC_KEY_METHODS = new Set(['peek_public_key', 'get_public_key'])

// Signer-backed wire methods. Anything outside this set is left to the vault
// so unknown methods keep answering UNSUPPORTED_METHOD as today.
const SIGNER_METHODS = new Set([
  'sign_event',
  'double_sign_event',
  'get_relays',
  'nip04_encrypt',
  'nip04_decrypt',
  'nip44_encrypt',
  'nip44_decrypt',
  'nip44v3_encrypt',
  'nip44v3_decrypt',
  'nip44v3_encrypt_double_dh',
  'nip44v3_decrypt_double_dh',
  'nip44_encrypt_double_dh',
  'nip44_decrypt_double_dh',
  'obfuscate'
])

const SIGN_METHODS = new Set(['sign_event', 'double_sign_event'])

// AUTH/HTTP_AUTH/NWT signing is still blocked for default/read-only/locked
// accounts, but it must not trigger the attention tooltip.
const EXEMPT_SIGN_KINDS = new Set([AUTH, HTTP_AUTH, NWT])

export function readSignerAccountFlags (userPk, {
  defaultUserPk,
  storage = globalThis.localStorage
} = {}) {
  const isDefaultUser = userPk === defaultUserPk
  if (isDefaultUser) {
    return { isDefaultUser: true, isReadOnly: false, isLocked: false }
  }

  const isReadOnly = storage?.getItem(`session_accountByUserPk_${userPk}_isReadOnly`) === 'true'
  const isLocked = !isReadOnly && storage?.getItem(`session_accountByUserPk_${userPk}_isLocked`) === 'true'
  return { isDefaultUser: false, isReadOnly, isLocked }
}

// Throws a controlled error when the request cannot be fulfilled by the
// current account type or vault lock state. Calls `onAttention` only for
// signing requests whose kind is not AUTH/HTTP_AUTH/NWT and only for account
// states that should surface a tooltip (default user and locked accounts).
export function guardSignerRequest ({
  method,
  params = [],
  account = {},
  onAttention
} = {}) {
  if (PUBLIC_KEY_METHODS.has(method)) return
  if (!SIGNER_METHODS.has(method)) return

  const { isDefaultUser = false, isReadOnly = false, isLocked = false } = account
  if (!isDefaultUser && !isReadOnly && !isLocked) return

  const code = isDefaultUser
    ? READ_ONLY_TEMPORARY_ACCOUNT
    : isReadOnly
      ? READ_ONLY_ACCOUNT
      : VAULT_LOCKED

  if (
    SIGN_METHODS.has(method) &&
    !EXEMPT_SIGN_KINDS.has(params?.[0]?.kind) &&
    (isDefaultUser || isLocked)
  ) {
    onAttention?.(isDefaultUser ? 'create-account' : 'unlock-account')
  }

  const error = new Error(code)
  error.code = code
  throw error
}
