# Injected app API

Apps launched by 44billion receive the `window.napp` object before their own
scripts run.

## Locale

`getLocale()` resolves to the launcher's current effective locale. The value is
always one of `en`, `fr`, `it`, `de`, `es`, `pt-BR`, `ru`, `zh-CN`, `zh-TW`,
`ja`, or `ko`; the internal `auto` preference is never exposed.

```js
const locale = await window.napp.getLocale()
```

`onLocaleChanged()` calls its listener once with the current locale after the
launcher handshake, then calls it for each effective change. It returns an
idempotent function that stops future notifications.

```js
const unlisten = window.napp.onLocaleChanged(locale => {
  updateTranslations(locale)
})

unlisten()
```

Reading or observing the locale does not request a permission. Apps cannot use
this API to change the launcher's language preference.
