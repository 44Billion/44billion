import { useTask } from '#f'
import { SUBDOMAIN_STATE_KEY } from '#helpers/subdomain-mapping.js'
import { processSubdomainCleanup } from '#services/subdomain-cleanup.js'

export function useSubdomainCleanup () {
  useTask(({ cleanup }) => {
    let timers = []
    const run = () => processSubdomainCleanup().catch(error => console.warn('[subdomain-cleanup]', error))
    const schedule = () => {
      timers.forEach(clearTimeout)
      // Reservation release precedes completion of navigation away from the
      // origin. Retry that short client-drain gap without blocking app opens.
      timers = [0, 1000, 5000].map(delay => setTimeout(run, delay))
    }
    const onStorage = event => {
      if (event.storageArea === localStorage && (event.key === null || event.key === SUBDOMAIN_STATE_KEY)) schedule()
    }
    schedule()
    window.addEventListener('storage', onStorage)
    window.addEventListener('online', schedule)
    window.addEventListener('subdomain-idle', schedule)
    cleanup(() => {
      timers.forEach(clearTimeout)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('online', schedule)
      window.removeEventListener('subdomain-idle', schedule)
    })
  })
}
