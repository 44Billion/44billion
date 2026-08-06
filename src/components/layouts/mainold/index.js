// this layout forms the basis with the body and bottom panel
import { f } from '#f'

f('mainLayout', function () {
  return this.h`<div class='wrapper'>
    <div class='view-wrapper'>
      {store.views.map(view => <div key={view} style={{
        width: '100%', ...(store.view === view
          ? { display: 'flex', flexDirection: 'column' }
          : { display: 'none' })
      }}>
        {store.onceActiveViews[view] && (() => {
          const { [view]: ViewComponent } = store.componentByView

          return <ViewComponent {...props} />
        })()}
      </div>)}
    </div>
    <div class='footer' style={{
      borderTop: '1px solid var(--mg2)',
      backgroundColor: 'var(--bg2)',
      color: 'var(--fg2)'
    }}>
      <div>App 1</div>
      <div>App 2</div>
    </div>
  </div>`
}
