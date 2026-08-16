export const FIRST_ACCOUNT_ATTENTION_SIGNAL = 'firstVaultAccountAttention'
export const FIRST_ACCOUNT_ATTENTION_MS = 2200

export function firstAccountActivationMetadata ({
  hasOnlyDefaultUser,
  defaultUserPk,
  nextUserPks
}) {
  // The first incoming account is the one that replaces the default user,
  // even when a batch (e.g. device sync) imports several accounts at once.
  const userPk = Array.isArray(nextUserPks) && nextUserPks.length > 0
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
    userPks.includes(attention.userPk) &&
    activeUserPk === attention.userPk &&
    activeUserPk !== defaultUserPk
  )
}
