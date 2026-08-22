import { f } from '#f'
import '#shared/icons/icon-hourglass-high.js'
import { cssVars } from '#assets/styles/theme.js'

f('pending-indicator', function () {
  const textValue = this.props.text$ ?? this.props.text
  const text = typeof textValue === 'function' ? textValue() : textValue

  return this.h`
    <style>${/* css */`
      pending-indicator .pending-indicator-root {
        width: 100%;
        height: 100%;
        min-height: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 10px;
        padding: 16px;
        box-sizing: border-box;
        color: ${cssVars.colors.fg2};
        font-size: 14rem;
      }

      pending-indicator .pending-indicator-root icon-hourglass-high {
        flex-shrink: 0;
      }

      pending-indicator .pending-indicator-root .pending-indicator-label {
        animation: pendingIndicatorPulse 2s cubic-bezier(.4, 0, .6, 1) infinite;
      }

      @keyframes pendingIndicatorPulse {
        50% { opacity: .5; }
      }
    `}</style>
    <div class='pending-indicator-root'>
      <icon-hourglass-high props=${{ size: '20px', style: 'color:' + cssVars.colors.bgAccentSecondary }} />
      <span class='pending-indicator-label'>${text}</span>
    </div>
  `
})
