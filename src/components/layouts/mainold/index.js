// this layout forms the basis with the body and bottom panel
import { f } from 'f'

f(function mainLayout () {
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
      borderTop: '1px solid #111',
      backgroundColor: '#333',
      color: '#999'
    }}>
      <div>App 1</div>
      <div>App 2</div>
    </div>
  </div>`
}
