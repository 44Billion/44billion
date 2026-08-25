import { f, useComputed, useMemo, useSignal, useTask } from '#f'
import { cssVars } from '#assets/styles/theme.js'
import { useWebStorage } from '#f'
import '#shared/back-btn.js'
import '#shared/app-icon.js'
import '#shared/avatar.js'
import { getEffectiveLocale, getT } from '#i18n/index.js'
import {
  duplicateStickySession,
  gcStickySessions,
  isClaimActive,
  listSessionWorkspaceAppGroups,
  markStickySessionsSeen,
  requestStickySessionDelete
} from '#services/sticky-sessions/index.js'

export const stickySessionsLocales = getLocales()
const t = getT(stickySessionsLocales)

f('sticky-session-app-tile', function () {
  const storage = useWebStorage(localStorage)
  const app$ = useComputed(() => ({
    id: this.props.appId,
    key: this.props.appId
  }))
  const appName$ = useComputed(() => {
    const name = storage[`session_appById_${this.props.appId}_name$`]()
    return typeof name === 'string' && name ? name : this.props.appId
  })
  const openCount = this.props.openCount
  const minimizedCount = this.props.minimizedCount
  const totalCount = openCount + minimizedCount
  const badges = []
  if (openCount > 0) {
    badges.push({ key: 'open', count: openCount, color: cssVars.colors.bg3Primary })
  }
  if (minimizedCount > 0) {
    badges.push({ key: 'minimized', count: minimizedCount, color: cssVars.colors.bg3Secondary })
  }

  return this.h`
    <div
      style=${`
        position: relative;
        width: 44px;
        height: 44px;
        display: flex;
        align-items: center;
        justify-content: center;
      `}
      title=${`${appName$()} (${totalCount})`}
    >
      <app-icon props=${{ app$ }} />
      <div
        style=${`
          position: absolute;
          top: -4px;
          right: -4px;
          display: flex;
          flex-direction: column;
          align-items: flex-end;
          gap: 2px;
        `}
      >
        ${badges.map(badge => this.h({ key: badge.key })`
          <div
            style=${`
          min-width: 16px;
          height: 16px;
          border-radius: 8px;
          padding: 0 4px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 11rem;
          font-weight: bold;
              background-color: ${badge.color};
          color: ${cssVars.colors.fgAccent};
            `}
          >${badge.count}</div>
        `)}
      </div>
    </div>
  `
})

f('sticky-sessions', function () {
  const storage = useWebStorage(localStorage)
  const tabStorage = useWebStorage(sessionStorage)

  const sessions$ = useComputed(() => {
    storage.local_stickySessionSnapshots$()
    storage.local_stickySessionClaims$()
    const myTabId = tabStorage.session_stickyTabId$?.()
    const snapshots = JSON.parse(localStorage.getItem('local_stickySessionSnapshots') || '{}')
    const claims = JSON.parse(localStorage.getItem('local_stickySessionClaims') || '{}')
    const now = Date.now()
    return Object.entries(snapshots)
      .map(([id, snapshot]) => ({
        id,
        updatedAt: snapshot?.updatedAt ?? 0,
        workspaceKeys: Array.isArray(snapshot?.workspaceKeys) ? snapshot.workspaceKeys : [],
        workspaces: snapshot?.workspaces ?? {},
        claimed: id === myTabId || isClaimActive(claims?.[id], now)
      }))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  })

  const pendingRestore$ = useSignal(new Set())
  const pendingTimers = useMemo(() => new Map())
  useTask(({ cleanup }) => {
    cleanup(() => {
      for (const timer of pendingTimers.values()) clearTimeout(timer)
      pendingTimers.clear()
    })
  })

  const handlePrimaryAction = session => {
    if (pendingRestore$().has(session.id)) return
    pendingRestore$(new Set([...pendingRestore$(), session.id]))
    const timer = setTimeout(() => {
      const next = new Set(pendingRestore$())
      next.delete(session.id)
      pendingRestore$(next)
      pendingTimers.delete(session.id)
    }, 8000)
    pendingTimers.set(session.id, timer)
    const targetId = session.claimed
      ? duplicateStickySession({
        localStorageArea: localStorage,
        snapshotId: session.id
      })
      : session.id
    if (targetId) window.open(`/?sticky=${encodeURIComponent(targetId)}`, '_blank')
  }

  useTask(() => {
    gcStickySessions({ localStorageArea: localStorage })
    markStickySessionsSeen({ localStorageArea: localStorage })
  })

  return this.h`
    <style>${/* css */`
      sticky-sessions {
        flex-grow: 1;
        max-width: 900px;
        display: flex !important;
        flex-direction: column;
        height: 100%;
        background-color: ${cssVars.colors.bg};
        color: ${cssVars.colors.fg};

        .header {
          height: 55px;
          display: flex;
          align-items: center;
          padding: 0 10px;
          flex-shrink: 0;
          border-bottom: 1px solid ${cssVars.colors.bg2};
        }
        .title {
          flex-grow: 1;
          font-weight: 500;
          font-size: 18rem;
          margin-left: 10px;
        }
        .content {
          padding: 20px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .session {
          padding: 14px;
          background-color: ${cssVars.colors.bg2};
          border-radius: 8px;
        }
        .session-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 10px;
        }
        .session-date {
          font-size: 14rem;
          color: ${cssVars.colors.fg2};
        }
        .session-actions {
          display: flex;
          gap: 8px;
        }
        .session-action {
          padding: 8px 16px;
          border-radius: 6px;
          border: none;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 14rem;
          cursor: pointer;
          background-color: ${cssVars.colors.overlayHover};
        }
        .session-action:hover {
          background-color: ${cssVars.colors.overlaySelected};
        }
        .session-action.primary {
          font-weight: 600;
          background-color: ${cssVars.colors.bgAccentPrimary};
          color: ${cssVars.colors.fgAccent};
          transition: filter 0.2s;
        }
        .session-action.primary:hover {
          filter: brightness(1.1);
          background-color: ${cssVars.colors.bgAccentPrimary};
        }
        .session-action.disabled {
          opacity: 0.55;
          pointer-events: none;
          cursor: default;
        }
        .workspace {
          margin-top: 10px;
        }
        .workspace-label {
          display: flex;
          align-items: center;
          gap: 6px;
          font-size: 12rem;
          color: ${cssVars.colors.fgMuted};
          margin-bottom: 6px;
        }
        .workspace-apps {
          display: flex;
          flex-wrap: wrap;
          gap: 6px;
        }
        .empty {
          color: ${cssVars.colors.fg2};
          font-size: 14rem;
          text-align: center;
          padding: 30px 0;
        }
      }
    `}</style>
    <div class="header">
      <back-btn />
      <div class="title">${t('Sticky Sessions')}</div>
    </div>
    <div class="content">
      ${sessions$().length === 0
        ? [this.h`<div class="empty">${t('No saved sessions yet.')}</div>`]
        : sessions$().map(session => {
          const isPending = pendingRestore$().has(session.id)
          return this.h({ key: session.id })`
          <div class="session">
            <div class="session-head">
              <div class="session-date">${new Date(session.updatedAt).toLocaleString(getEffectiveLocale())}</div>
              <div class="session-actions">
                <div
                  class=${{ 'session-action': true, primary: true, disabled: isPending }}
                  onclick=${() => handlePrimaryAction(session)}
                >${session.claimed ? t('Duplicate') : t('Restore')}</div>
                <div
                  class="session-action"
                  onclick=${() => {
                    requestStickySessionDelete({ localStorageArea: localStorage, snapshotId: session.id })
                  }}
                >${t('Delete')}</div>
              </div>
            </div>
            ${session.workspaceKeys.map(wsKey => {
              const ws = session.workspaces[wsKey]
              if (!ws) return ''
              const openKeys = Array.isArray(ws.openKeys) ? ws.openKeys : []
              const minimizedKeys = Array.isArray(ws.minimizedKeys) ? ws.minimizedKeys : []
              if (openKeys.length === 0 && minimizedKeys.length === 0) return ''
              const wsUserPk = storage[`session_workspaceByKey_${wsKey}_userPk$`]()
              const isDefaultUser = wsUserPk && wsUserPk === storage.session_defaultUserPk$()
              const profile = wsUserPk ? storage[`session_accountByUserPk_${wsUserPk}_profile$`]() : null
              const workspaceLabel = !wsUserPk
                ? wsKey
                : isDefaultUser
                  ? t('Default User')
                  : profile?.name || profile?.npub || wsUserPk
              return this.h({ key: `${session.id}:${wsKey}` })`
                <div class="workspace">
                  <div class="workspace-label" title=${wsKey}>
                    ${wsUserPk
                      ? this.h`<div
                          style=${`
                            width: 16px;
                            height: 16px;
                            flex-shrink: 0;
                            display: inline-block;
                            overflow: hidden;
                            border-radius: 50%;
                          `}
                        >
                          <a-avatar
                            props=${{
                              pk$: wsUserPk,
                              size: '16px',
                              weight$: 'duotone',
                              strokeWidth$: 1
                            }}
                          />
                        </div>`
                      : ''}
                    <span>${workspaceLabel}</span>
                  </div>
                  <div class="workspace-apps">
                    ${listSessionWorkspaceAppGroups({
                      localStorageArea: localStorage,
                      wsKey,
                      openKeys,
                      minimizedKeys
                    }).map(group => this.h({ key: `${session.id}:${wsKey}:${group.appId}` })`
                      <sticky-session-app-tile
                        props=${{
                          appId: group.appId,
                          openCount: group.openCount,
                          minimizedCount: group.minimizedCount
                        }}
                      />
                    `)}
                  </div>
                </div>
              `
            }).filter(Boolean)}
          </div>
          `
        })}
    </div>
  `
})

function getLocales () {
  return {
    'Sticky Sessions': { en: 'Sticky Sessions', fr: 'Sessions persistantes', it: 'Sessioni persistenti', de: 'Sticky-Sitzungen', es: 'Sesiones persistentes', 'pt-BR': 'Sessões persistentes', ru: 'Липкие сессии', 'zh-CN': '粘性会话', 'zh-TW': '黏性工作階段', ja: 'スティッキーセッション', ko: '고정 세션' },
    'Default User': { en: 'Default User', fr: 'Utilisateur par défaut', it: 'Utente predefinito', de: 'Standardbenutzer', es: 'Usuario predeterminado', 'pt-BR': 'Usuário padrão', ru: 'Пользователь по умолчанию', 'zh-CN': '默认用户', 'zh-TW': '預設使用者', ja: 'デフォルトユーザー', ko: '기본 사용자' },
    'No saved sessions yet.': { en: 'No saved sessions yet.', fr: 'Aucune session enregistrée pour le moment.', it: 'Nessuna sessione salvata finora.', de: 'Noch keine gespeicherten Sitzungen.', es: 'Aún no hay sesiones guardadas.', 'pt-BR': 'Ainda não há sessões salvas.', ru: 'Пока нет сохранённых сессий.', 'zh-CN': '暂无已保存的会话。', 'zh-TW': '尚無已儲存的工作階段。', ja: '保存済みセッションはまだありません。', ko: '아직 저장된 세션이 없습니다.' },
    Restore: { en: 'Restore', fr: 'Restaurer', it: 'Ripristina', de: 'Wiederherstellen', es: 'Restaurar', 'pt-BR': 'Restaurar', ru: 'Восстановить', 'zh-CN': '恢复', 'zh-TW': '還原', ja: '復元', ko: '복원' },
    Duplicate: { en: 'Duplicate', fr: 'Dupliquer', it: 'Duplica', de: 'Duplizieren', es: 'Duplicar', 'pt-BR': 'Duplicar', ru: 'Дублировать', 'zh-CN': '复制', 'zh-TW': '複製', ja: '複製', ko: '복제' },
    Delete: { en: 'Delete', fr: 'Supprimer', it: 'Elimina', de: 'Löschen', es: 'Eliminar', 'pt-BR': 'Excluir', ru: 'Удалить', 'zh-CN': '删除', 'zh-TW': '刪除', ja: '削除', ko: '삭제' }
  }
}
