import { getEventKindText } from '#helpers/event-kind-text.js'
import {
  BROAD_EVENT_KIND,
  EVENT_ACCESS_PERMISSION,
  EVENT_ACCESS_PERSONAL_PERMISSION,
  LEGACY_CRYPTO_ACCESS_PERMISSION
} from '#helpers/window-message/browser/event-permissions.js'
import {
  permissionScopeEntry,
  SUPPORTED_PERMISSION_SCOPES
} from '#helpers/window-message/browser/permission-scopes.js'

const SECTION_ORDER = {
  eventData: 0,
  personalCopies: 1,
  encryption: 2,
  other: 3
}

export function permissionRecordId (permission) {
  return JSON.stringify([
    permission.appId,
    permission.name,
    permission.eKind,
    permission.scope ?? ''
  ])
}

export function groupPermissionsByApp (permissions) {
  const groups = new Map()
  for (const permission of permissions) {
    if (!permission?.appId) continue
    let group = groups.get(permission.appId)
    if (!group) groups.set(permission.appId, group = [])
    group.push(permission)
  }
  return [...groups].map(([appId, appPermissions]) => ({
    appId,
    permissions: appPermissions
  }))
}

export function describeStoredPermission (permission, {
  translate = key => key,
  translateKind = translate,
  scopeRegistry = SUPPORTED_PERMISSION_SCOPES
} = {}) {
  let sectionId = 'other'
  let title
  let broad = permission.eKind === BROAD_EVENT_KIND

  if (permission.name === LEGACY_CRYPTO_ACCESS_PERMISSION) {
    sectionId = 'encryption'
    title = translate('Encrypt or decrypt any data')
    broad = true
  } else if (permission.name === EVENT_ACCESS_PERSONAL_PERMISSION) {
    sectionId = 'personalCopies'
    title = permission.eKind === BROAD_EVENT_KIND
      ? translate('All personal data')
      : getEventKindText(permission.eKind, translateKind)
  } else if (permission.name === EVENT_ACCESS_PERMISSION) {
    sectionId = 'eventData'
    title = permission.eKind === BROAD_EVENT_KIND
      ? translate('All app data')
      : getEventKindText(permission.eKind, translateKind)
  } else {
    title = permission.name
  }

  const scope = permission.scope
    ? permissionScopeEntry(permission.eKind, permission.scope, scopeRegistry)
    : null

  return {
    id: permissionRecordId(permission),
    permission,
    sectionId,
    order: SECTION_ORDER[sectionId],
    title,
    broad,
    kind: permission.eKind,
    scopeLabel: scope ? translateKind(scope.labelKey) : ''
  }
}

export function groupStoredPermissions (permissions, options) {
  const groups = new Map()
  for (const permission of permissions) {
    const description = describeStoredPermission(permission, options)
    let group = groups.get(description.sectionId)
    if (!group) {
      groups.set(description.sectionId, group = {
        id: description.sectionId,
        order: description.order,
        rows: []
      })
    }
    group.rows.push(description)
  }
  return [...groups.values()]
    .sort((left, right) => left.order - right.order)
    .map(group => ({
      ...group,
      rows: group.rows.slice().sort((left, right) =>
        left.kind - right.kind || left.title.localeCompare(right.title)
      )
    }))
}
