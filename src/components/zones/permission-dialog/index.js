import { f, useGlobalStore, useClosestStore, useStore, useCallback } from '#f'
import '#f/components/f-to-signals.js'
import '#shared/modal.js'
import { hasPermission, createOrUpdatePermission } from '#services/idb/browser/queries/permission.js'
import { BROAD_EVENT_KIND, EVENT_ACCESS_PERMISSION, EVENT_ACCESS_PERSONAL_PERMISSION, ONE_TIME_DELETE_PERMISSION } from '#helpers/window-message/browser/event-permissions.js'
import { cssStrings, cssClasses, cssVars, jsVars } from '#assets/styles/theme.js'
import '#shared/app-icon.js'
import '#shared/icons/icon-x.js'
import useWebStorage from '#hooks/use-web-storage.js'

function createPermissionDialogStore () {
  return {
    isOpen$ () { return this.queue$().length > 0 },
    close () {
      let lengthSnapshot = this.queue$().length
      let promise = Promise.resolve()
      while (lengthSnapshot-- > 0) {
        promise = promise.then(() => this.resolveCurrent(false))
      }
    },
    queue$: [],
    getPermissionId (req) { return `${req.app.id}:${req.name}:${req.eKind ?? ''}` },
    isSingularPermission (req) {
      return req.remember === false || req.eKind == null || (req.app.id && req.name === 'openApp')
    },
    addPermissionRequest (req) {
      this.queue$(v => {
        let duplicate
        if (
          !this.isSingularPermission(req) &&
          (duplicate = v.find(v2 => v2.id === req.id))
        ) {
          duplicate.promise.then(req.resolve).catch(req.reject)
          return v
        }

        v.push({
          id: req.id,
          app: {
            id: req.app.id,
            napp: req.app.napp,
            alias: req.app.alias,
            name: req.app.name,
            icon: {
              fx: req.app.icon?.fx,
              url: req.app.icon?.url
            }
          },
          name: req.name,
          eKind: req.eKind,
          meta: {
            // params: req.meta.params (NIP07)
            // targetApp: req.meta.targetApp (OPEN_APP)
            ...req.meta
          },
          promise: req.promise,
          resolve: req.resolve,
          reject: req.reject
        })
        return v
      })
    },
    removeCurrent (current) {
      if (this.queue$().length === 0) return

      const req = current ?? this.queue$()[0]
      this.queue$(v => current
        ? v.filter(v2 => v2.id !== req.id)
        : v.slice(1)
      )
    },
    async resolveCurrent (granted, current) {
      if (this.queue$().length === 0) return

      const req = current ?? this.queue$()[0]
      if (granted) {
        // grant just once
        if (this.isSingularPermission(req)) {
          req.resolve(true)
          this.removeCurrent(current)
          return
        }

        // remember
        await createOrUpdatePermission(req.app.id, req.name, req.eKind)
        req.resolve(true)
        this.removeCurrent(current)
      } else {
        req.reject(new Error('Permission denied'))
        this.removeCurrent(current)
      }
    },
    async queryPermission (req) {
      if (this.isSingularPermission(req)) return false
      return hasPermission(req.app.id, req.name, req.eKind)
    },
    async requestPermission (req) {
      const granted = await this.queryPermission(req)
      if (granted) return true

      const p = Promise.withResolvers()
      this.addPermissionRequest({
        ...req,
        ...p,
        id: this.isSingularPermission(req)
          ? `${this.getPermissionId(req)}:${Date.now()}:${Math.random()}`
          : this.getPermissionId(req)
      })
      return p.promise
    }
  }
}

export function usePermissionDialogStore () {
  return useGlobalStore('<permission-dialog>', createPermissionDialogStore)
}

// On the nip07 handler, call await pdStore.requestPermission(req)
f('permissionDialog', function () {
  const pdStore = usePermissionDialogStore()
  const modalProps = useStore(() => ({
    isOpen$: pdStore.isOpen$,
    close: pdStore.close.bind(pdStore),
    shouldAlwaysDisplay$: true,
    render: useCallback(function () {
      return this.h`<permission-dialog-stack />`
    })
  }))

  return this.h`<a-modal props=${modalProps} />`
})

f('permissionDialogStack', function () {
  const storage = useWebStorage(localStorage)
  const pdStore = usePermissionDialogStore()
  const store = useClosestStore('<permission-dialog-stack>', () => ({
    resolveCurrent: pdStore.resolveCurrent.bind(pdStore),
    eKindToText: {
      0: 'profiles',
      1: 'short text notes',
      3: 'follow lists',
      4: '(legacy) direct messages',
      5: 'deletion requests',
      6: 'short text renotes',
      7: 'reactions',
      13: 'message seals',
      14: '(public) chat messages', // if signed, they won't be gift-wrapped/sealed
      15: '(public) file decryption keys',
      16: 'renotes',
      20: 'pictures',
      21: 'videos',
      22: 'short vertical videos',
      62: 'delete-all requests',
      1018: 'poll responses',
      1059: 'recipient directions',
      1068: 'polls',
      1111: 'comments',
      1222: 'short voice notes',
      1244: 'short voice comments',
      1984: 'misconduct reports',
      3560: 'private-channel broadcasts',
      7376: 'nutzap redemption logs',
      9321: 'nutzaps',
      9734: 'bitcoin pre-payment data',
      9735: 'bitcoin receipts',
      10002: 'home server configurations',
      10019: 'nutzap receiving addresses',
      26300: 'private-channel router rows',
      27235: 'API authentication requests',
      30008: 'profile badges',
      30009: 'profile badge definitions',
      30023: 'long text notes',
      30311: 'livestreams',
      30402: 'classified listings',
      30403: '(draft) classified listings',
      31922: 'date events',
      31923: 'time events',
      31924: 'calendars',
      31925: 'event RSVPs',
      34601: 'files',
      35128: 'site manifests',
      35129: '(next) site manifests',
      35130: '(draft) site manifests'
    },
    getEKindToText (kind, name) {
      if (name === 'readProfile') return 'your profile'
      if (kind === BROAD_EVENT_KIND) return 'all app data'
      let result = this.eKindToText[kind]
      if (!result) {
        if (kind == null) result = 'app data'
        else result = `app data type ${kind}`
      }
      return result
    },
    nameToText: {
      readProfile: 'read',
      [EVENT_ACCESS_PERMISSION]: 'access',
      [EVENT_ACCESS_PERSONAL_PERMISSION]: 'access personal',
      [ONE_TIME_DELETE_PERMISSION]: 'delete',
      openApp: 'open'
    },
    getNameToText (name) {
      return this.nameToText[name] || name
    },
    scopeToText (scope, eKind) {
      if (!scope) return ''
      const value = String(scope)
      const normalized = value.replace(/\s+/g, ' ').trim()
      if (!normalized) return ''
      const clipped = normalized.length > 48
        ? `${normalized.slice(0, 32)}...${normalized.slice(-12)}`
        : normalized
      if (eKind === 26300 && /^[0-9a-f]{64}$/i.test(normalized)) {
        return `Channel: ${normalized.slice(0, 8)}...${normalized.slice(-8)}`
      }
      return `Scope: ${clipped}`
    },
    getPemissionText (name, eKind, meta) {
      let dynText
      if (eKind === 22242) dynText = 'access content that needs login'
      else if (name === ONE_TIME_DELETE_PERMISSION && eKind === 5) {
        const event = meta?.params?.[0]
        if (!event) throw new Error('Missing event parameter for eKind 5 permission')

        const deleteTags = ['e', 'a']
        const deleteCount = event.tags.filter(t => deleteTags.includes(t[0])).length || 1
        dynText = `delete ${deleteCount} ${deleteCount === 1 ? 'item' : 'items'}`
      } else if (name === ONE_TIME_DELETE_PERMISSION && eKind === 62) {
        const event = meta?.params?.[0]
        if (!event) throw new Error('Missing event parameter for eKind 62 permission')
        const relayTags = event.tags.filter(t => t[0] === 'relay')
        const relayCount = relayTags.some(tag => tag[1] === 'ALL_RELAYS')
          ? Infinity
          : relayTags.length || 1
        dynText = `delete ALL your items from ${relayCount === Infinity
          ? 'ALL servers'
          : `${relayCount} ${relayCount === 1 ? 'server' : 'servers'}`
        }`
      } else if (name === 'openApp') {
        const { targetApp } = meta ?? {}
        if (!targetApp) throw new Error('Missing app parameter for openApp permission')

        const {
          [`session_appById_${targetApp.id}_name$`]: cachedTargetAppName$
        } = storage
        const appName = targetApp.name || cachedTargetAppName$() || targetApp.alias || targetApp.napp
        if (appName == null) throw new Error('Missing app name for openApp permission')
        dynText = `${this.getNameToText(name)} the ${appName} app`
      }

      if (!dynText) {
        const eKindText = this.getEKindToText(eKind, name)
        const permissionText = this.getNameToText(name)
        dynText = [permissionText, eKindText].filter(Boolean).join(' ')
      }
      const scopeText = this.scopeToText(meta?.scope, eKind)
      return `Can I ${dynText}${scopeText ? ` (${scopeText})` : ''}?`
    },
    permissionRequests$ () {
      return pdStore.queue$()
    }
  }))

  return this.h`
    <style>${/* css */`
      #permission-dialog-stack {
        &${cssStrings.defaultTheme}

        display: flex;
        flex-direction: column;
        padding: 4px;
        min-width: 200px;
        @media ${jsVars.breakpoints.desktop} {
          margin: 0 auto;
          max-width: 500px;
        }
        background-color: ${cssVars.colors.bg2Lighter};
        color: ${cssVars.colors.fg2};
        border-radius: 8px;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
        overflow: hidden;

        @media ${jsVars.breakpoints.mobile} {
          border-radius: 0;
        }
      }
      /* this fixes syntax highlight */
    `}</style>
    <div id='permission-dialog-stack' class=${cssClasses.defaultTheme}>
      ${store.permissionRequests$().map((req, index) => this.h({ key: req.id })`
        <f-to-signals
          props=${{
            from: ['req', 'index'], req, index, render ({ h, props: { req$, index$ } }) {
              return h`<permission-dialog-card
                props=${{
                  req$,
                  index$
                }}
              />`
            }
          }}
        />
      `)}
    </div>
  `
})

f('permissionDialogCard', function () {
  const storage = useWebStorage(localStorage)
  const pdsStore = useClosestStore('<permission-dialog-stack>')
  const store = useStore(() => ({
    req$: this.props.req$,
    index$: this.props.index$,
    resolveCurrent (granted) { return pdsStore.resolveCurrent(granted, this.req$()) },
    isButtonsDisabled$: false,
    allow () {
      this.isButtonsDisabled$(true)
      return this.resolveCurrent(true)
    },
    deny () {
      this.isButtonsDisabled$(true)
      return this.resolveCurrent(false)
    },
    permissionText$ () {
      const req = this.req$()
      return pdsStore.getPemissionText(req.name, req.eKind, req.meta)
    },
    appName$ () {
      const req = this.req$()
      const {
        [`session_appById_${req.app.id}_name$`]: cachedAppName$
      } = storage
      const cachedAppName = cachedAppName$()
      return req.app.name || cachedAppName || req.app.alias || req.app.napp || 'App'
    }
  }))
  const appIconProps = useStore(() => ({
    app$: () => ({
      id: store.req$().app.id,
      index: '?'
    })
  }))
  return this.h`
    <style>${`
      .permission-dialog-card {
        border-radius: 8px;
        display: flex;
        align-items: flex-start;
        padding: 5px 8px;
        transition: background-color 0.2s;

        &:hover {
          background-color: rgba(255, 255, 255, 0.05);
        }

        .app-icon {
          margin-right: 12px;
          flex-shrink: 0;
          width: 40px;
          height: 40px;
          position: relative;
          overflow: hidden;
          border-radius: 10px;
          background-color: ${cssVars.colors.bgAvatar};
          color: ${cssVars.colors.fg3};
        }

        .app-info {
          flex: 1;
          min-width: 0;
          margin-right: 10px;
          top: 1px;
          position: relative;
        }

        .app-name {
          font-size: 15rem;
          font-weight: 600;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .permission-text {
          font-size: 16rem;
          line-height: 1.3;
          color: rgba(255, 255, 255, 0.7);
          margin-top: 2px;
          display: -webkit-box;
          -webkit-box-orient: vertical;
          -webkit-line-clamp: 3;
          overflow: hidden;
          overflow-wrap: anywhere;
        }

        .permission-actions {
          display: flex;
          align-self: flex-start;
          gap: 8px;
          margin-left: 8px;
          padding-top: 2px;
        }

        .permission-button {
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 14rem;
          font-weight: 500;
          cursor: pointer;
          transition: background-color 0.2s, opacity 0.2s;
          border: none;
        }

        .permission-button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        .allow-button {
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
        }

        .allow-button:hover:not(:disabled) {
          background-color: ${cssVars.colors.bgPrimary};
        }

        .deny-button {
          background-color: transparent;
          color: ${cssVars.colors.fg2};
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          padding: 0;
        }

        .deny-button:hover:not(:disabled) {
          background-color: rgba(255, 255, 255, 0.1);
        }

        .deny-button svg {
          width: 16px;
          height: 16px;
        }

        @media ${jsVars.breakpoints.mobile} {
          .permission-dialog-card {
            border-radius: 2px;
            padding: 8px 12px;
          }

          .app-icon {
            overflow: hidden;
            border-radius: 10px;
            width: 32px;
            height: 32px;
            margin-right: 10px;
          }

          .app-name {
            font-size: 14rem;
          }

          .permission-text {
            font-size: 16rem;
          }

          .permission-actions {
            gap: 6px;
          }

          .permission-button {
            padding: 4px 8px;
            font-size: 13rem;
          }

          .deny-button {
            width: 28px;
            height: 28px;
          }

          .deny-button svg {
            width: 14px;
            height: 14px;
          }
        }
      }
    `}</style>
    <div class='permission-dialog-card'>
      <div class="app-icon">
        <app-icon props=${appIconProps} />
      </div>
      <div class="app-info">
        <div class="app-name">${store.appName$()}</div>
        <div class="permission-text">${store.permissionText$()}</div>
      </div>
      <div class="permission-actions">
        <button
          class="permission-button allow-button"
          onclick=${store.allow}
          disabled=${store.isButtonsDisabled$()}
        >
          Allow
        </button>
        <button
          class="permission-button deny-button"
          onclick=${store.deny}
          disabled=${store.isButtonsDisabled$()}
        >
          <icon-x props=${{ size: '16px' }} />
        </button>
      </div>
    </div>
  `
})
