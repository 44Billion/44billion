import { isNappletAppId } from '#helpers/napplet.js'

// Built-in tools share workspace window records without a remote installation.
export const NAPPLET_STORE_APP_ID = 'builtin-napplet-store'
export const isBuiltInAppId = value => value === NAPPLET_STORE_APP_ID
export const isLauncherRenderedAppId = value => isBuiltInAppId(value) || isNappletAppId(value)
