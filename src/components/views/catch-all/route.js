// import Router from 'url-router'
// import { f, useStore, useTask, useSignal, useStateSignal, useClosestStore } from '#f'

// export const router = new Router({
//   // https://esbuild.github.io/api/#glob
//   // note that esbuild does understand dynamic import paths if stating with ./ or ../
//   // such as import('../views/${path}.js') but esbuild would include all possible
//   // files there to the bundle
//   '/(.*)': { tag: 'a-temp', loadModule: () => import('#views/catch-all/temp.js') },
//   '/temp2': { tag: 'a-temp-2', loadModule: () => import('#views/catch-all/temp2.js') }

//   // "/(.*)": { Page: Index },
//   // "/nevent1(.*)": { Page: EventsShow },

//   // "/:nevent(nevent1.*)": { tag: 'maybe-events-show', loadModule: () => import('#views/events/show/maybe.js') },
//   // "/n/(.*)": { Page: Groups },
// })

// f('aRoute', function () {
//   const {
//     handler: { tag, loadModule }, params
//   } = router.find(path)
//   const isActive$ = useStateSignal(isActive)

//   useClosestStore('aRoute', {
//     stackIndex,
//     path,
//     navigationState, // initial state
//     params,
//     isActive$
//   })

//   const isLoaded$ = useSignal(false)
//   useTask(async () => {
//     await loadModule()
//     isLoaded$.set(true)
//   })

//   if (!isLoaded$.get()) return

//   // dynamic tag doesn't work with uhtml: return this.h`<${tag} props=${{ stackIndex, path, navigationState, params }} />`
//   return this.h([`<${tag} props=`, ' />'], { stackIndex, path, navigationState, params })
// })
