f('catchAll', function () {
  // const sessionstore = useSessionContext()
  const store = useRouter()

  // if (!sessionstore.isReady$.get()) return
  return this.h`
    <div style=${{
      position: 'relative', display: 'flex', flexDirection: 'column', width: '100%',
      overflow: 'hidden'
    }}>
    ${store.stack$.get().map((v, i) => {
      return this.h({ key: `${i}${v}` })`<a-card key=${`${i}${v}`} props=${{ v, i }}>
        ${(store.path$.get(false) === v && store.stackIndex$.get(false) !== i) || (Math.abs(store.stackIndex$.get(false) - i) > 4)
          ? null // unmount if same path but inactive or if too far away
          : this.h`<a-route props=${{
              stackIndex: i,
              path: v,
              navigationState: store.stackIndex$.get(false) === i ? store.navigationState$.get(false) : {},
              isActive: store.stackIndex$.get(false) === i
            }} />`}
      </a-card>`
    })}
    </div>
  `
})

function useRouter (init = false) {
  if (!init) return useGlobalStore('useRouter')

  const store = useGlobalStore('useRouter', {

  })

  // listen for navigation and update store
  useTask(() => {

  })
}
