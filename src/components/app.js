import resetCssString from '#assets/styles/reset.css'
import globalCssString from '#assets/styles/global.css'

document.head.insertAdjacentHTML('beforeend', `<style>${resetCssString}${globalCssString}</style>`)

if (window.IS_DEVELOPMENT) {
  // https://esbuild.github.io/api/#live-reload
  new EventSource('/esbuild').addEventListener('change', () => location.reload())
}

console.log('hello world')
