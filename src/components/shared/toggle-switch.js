import { f } from '#f'
import { cssVars } from '#assets/styles/theme.js'

f('toggle-switch', function () {
  const { checked, onChange } = this.props

  return this.h`
    <style>${`
      .switch {
        position: relative;
        display: inline-block;
        width: 40px;
        height: 24px;
      }
      .switch input {
        opacity: 0;
        width: 0;
        height: 0;
      }
      .slider {
        position: absolute;
        cursor: pointer;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background-color: light-dark(
          oklch(from ${cssVars.colors.bg3} calc(0.8 - l) c calc(h + 180)),
          ${cssVars.colors.bg3}
        );
        transition: .4s;
        border-radius: 24px;
      }
      .slider:before {
        position: absolute;
        content: "";
        height: 18px;
        width: 18px;
        left: 3px;
        bottom: 3px;
        background-color: light-dark(#a3a3a3, #fff);
        transition: .4s;
        border-radius: 50%;
      }
      input:checked + .slider {
        background-color: ${cssVars.colors.bgAccentPrimary};
        background-color: light-dark(
          oklch(from ${cssVars.colors.bgAccentPrimary} calc(1.15 - l) c h),
          ${cssVars.colors.bgAccentPrimary}
        );
      }
      input:checked + .slider:before {
        transform: translateX(16px);
      }
    `}</style>
    <label class="switch">
      <input type="checkbox" checked=${checked} onchange=${e => onChange(e.target.checked)} />
      <span class="slider"></span>
    </label>
  `
})
