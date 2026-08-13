export const FIRST_ACCOUNT_ATTENTION_SIGNAL = 'firstVaultAccountAttention'
export const FIRST_ACCOUNT_ATTENTION_MS = 2200

export function firstAccountActivationMetadata ({
  hasOnlyDefaultUser,
  defaultUserPk,
  nextUserPks
}) {
  const userPk = Array.isArray(nextUserPks) && nextUserPks.length === 1
    ? nextUserPks[0]
    : null
  const activatedFirstAccount = Boolean(
    hasOnlyDefaultUser &&
    defaultUserPk &&
    userPk &&
    userPk !== defaultUserPk
  )
  return {
    activatedFirstAccount,
    userPk: activatedFirstAccount ? userPk : null
  }
}

export function shouldShowFirstAccountAttention ({
  attention,
  activeUserPk,
  accountUserPks,
  defaultUserPk,
  now = Date.now()
}) {
  const userPks = Array.isArray(accountUserPks) ? accountUserPks : []
  return Boolean(
    attention?.userPk &&
    attention.expiresAt > now &&
    userPks.length === 1 &&
    userPks[0] === attention.userPk &&
    activeUserPk === attention.userPk &&
    activeUserPk !== defaultUserPk
  )
}
