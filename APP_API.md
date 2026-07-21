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

## Event store

`eventStore` provides access to the app's Nostr event store. The object is
available before the launcher handshake finishes; method calls made before
then wait for the connection automatically.

```js
const { eventStore } = window.napp

await eventStore.add(event)
await eventStore.addPersonalCopy(unsignedEvent, { context: 'dm:alice' })

const { results } = await eventStore.query({ kinds: [1], limit: 20 })
const count = await eventStore.count({ kinds: [1] })
const features = await eventStore.supports()
```

The public methods are `add`, `addPersonalCopy`, `query`, `count`, `subscribe`,
and `supports`. Reads and writes may request the corresponding launcher
permission.

`subscribe()` returns an async iterator. Exiting a `for await` loop normally
invokes the iterator's `return()` method and cancels the remote subscription;
call it explicitly when consuming the iterator manually.

```js
const subscription = eventStore.subscribe({ kinds: [1] })

for await (const result of subscription) {
  renderEvent(result)
  if (shouldStop(result)) break // automatically calls return()
}
```

When calling `next()` manually, cancel explicitly with
`await subscription.return()` when the consumer no longer needs results.
