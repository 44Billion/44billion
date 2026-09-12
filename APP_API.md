# Injected app API

Windows and widgets launched by 44billion receive `window.napp` and
`window.nostr` before their own scripts run. Promise-returning bridge methods
wait for the launcher handshake, including `setMinWidth`. These APIs also exist
in standalone embedded apps.

## Users and personas

```js
const publicKeys = await window.napp.getPersonaPublicKeys() // Promise<string[]>
const signer = window.napp.getWindowNostrFor(publicKeys[0]) // synchronous object
const eventStore = window.napp.getWindowNappEventStoreFor(publicKeys[0]) // synchronous object
const publicKey = await signer.getPublicKey()

const unsubscribe = window.napp.onPersonaPublicKeysChanged(publicKeys => {
  updateAvailableUsers(publicKeys)
})
unsubscribe() // safe to call repeatedly
```

Public keys are 64-character hexadecimal strings. A selection belongs to an
**app and workspace**, so every current and future window/widget of that app in
that workspace shares it. Without a persona, only the workspace user's key is
returned. “All Users” resolves the current connected real accounts, falling back
to the anonymous user only when there are no real accounts.

A persona can be selected only if it includes the workspace user. Removing that
user, deleting the persona or otherwise losing eligibility resets the selection
to the workspace user automatically. The launcher validates reads immediately,
including before the persisted selection is cleaned up.

`onPersonaPublicKeysChanged(listener)` returns an unsubscribe function. It calls
the listener asynchronously with the initial keys once known, then whenever the
**set** of keys changes. Reordering keys, selecting an equivalent set, or resetting
a single-user persona to that same user does not emit another notification.
Late subscribers receive the current list. Each delivery is an independent
array; synchronous throws and rejected promises from one listener are reported
without interrupting others. Passing a non-function throws `TypeError`.
Unsubscribing also cancels queued deliveries for that subscription.

`getPersonaPublicKeys()` reads the current selection on each call. The event
tracks member/account changes as well as selections, without reloading apps.
Closed/unloaded documents receive current state when they load again.

`getWindowNostrFor(pubkey)` returns the same method surface as `window.nostr`,
including `ns` and `withSharedKey`, targeting the specified key. Every method call
revalidates membership, including calls on previously created signer objects.
Malformed or no-longer-available keys reject with `error.code ===
'PUBKEY_NOT_IN_PERSONA'`. Creating the object does not grant signing permission;
normal permissions and locked/read-only account checks still apply.

## Nostr signer

`window.nostr` targets the instance's workspace account. To use another member of
the selected persona, obtain its signer with `getWindowNostrFor`.

The injected methods below return promises and forward their arguments to the
vault signer:

| Methods | Purpose |
| --- | --- |
| `peekPublicKey()`, `getPublicKey()` | Read the signing public key. |
| `signEvent(event)`, `doubleSignEvent(...params)` | Sign event data. |
| `nip04.encrypt(pubkey, plaintext)`, `nip04.decrypt(pubkey, ciphertext)` | NIP-04 encryption/decryption. |
| `nip44.encrypt(pubkey, plaintext)`, `nip44.decrypt(pubkey, ciphertext)` | NIP-44 encryption/decryption. |
| `nip44v3.encrypt(...params)`, `nip44v3.decrypt(...params)` | Vault NIP-44 v3 extension. |
| `nip44v3.encryptDoubleDH(...params)`, `nip44v3.decryptDoubleDH(...params)` | Vault double-DH extension. |
| `obfuscate(...params)` | Vault obfuscation extension. |

`ns(name, ...namespaceParams)` returns a method object using that namespace.
`withSharedKey(...sharedKeyParams)` returns a method object using a shared-key
context. Their arguments and extension-specific formats are forwarded to the
configured vault; the launcher does not implement those cryptographic operations.
The ordinary, unnamespaced public-key getters are answered directly by the
launcher. Other operations may require the vault, account unlock and permission.
Bridge errors reject the returned promise; inspect their `code` when provided.

## Instance metadata

```js
const metadata = await window.napp.getInstanceMetadata()
const unsubscribe = window.napp.onInstanceMetadataChanged(metadata => {
  renderInstanceState(metadata)
})
unsubscribe()
```

Snapshots contain `instanceKey`, `isWidget`, `isPinned`, `isLoaded`, `isVisible`
and `otherInstances`. Each peer contains the same fields except `otherInstances`.
The opaque key survives navigation, closure and reopening of a registered
instance. Peers are registered instances of the same app and effective identity,
including closed instances and matching identities in other workspaces.

Subscriptions receive the initial snapshot asynchronously and then changed
snapshots, with independent copies and idempotent cancellation. Runtime visibility
and loading describe this launcher context, not a cross-tab aggregate. See
[Instance metadata](docs/instance-metadata.md) for identity matching, visual
coverage, widget pins and standalone runtime-key rules.

## Minimum layout width

```js
await window.napp.setMinWidth(640) // safe to call before the handshake
await window.napp.setMinWidth(0) // disable the minimum-width override
```

`setMinWidth(value)` returns `Promise<void>`. It converts the value to a number and
rounds to whole CSS pixels; negative or non-finite results are ignored with a
warning. A positive minimum allows the launcher to render the app at a wider
virtual width and scale it into a narrow window/widget. It does not resize the
widget's grid placement. The value is runtime state, not a persisted preference.
Calls before the handshake wait for the connection and are sent in call order.
The promise resolves when the command is sent, without waiting for the layout to
finish updating. Invalid values resolve without sending a command.

## Locale

`getLocale()` resolves to the effective locale received at the handshake. Use
`onLocaleChanged()` to follow later changes. The value is
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
`removeLocal`, and `supports`. Reads and writes may request the corresponding launcher
permission. The event store remains scoped to the instance's workspace account
and app; selecting a persona does not merge its members' event stores. Bridge
errors reject method promises or the iterator's `next()` promise.

`addPersonalCopy` resolves to `{ event, result }`; `add` returns the result
directly. Storage admission failures have result `{ ok: false, code: 'quota', message,
stored: false, published: false, quotaCategory }`, where `quotaCategory` is
`public`, `private`, or `cache` for event quotas. Existing chunk-payload quota
failures may omit the category. Limits are shared across launcher accounts:
512 MiB public, 1 GiB personal copies, and 128 MiB / 50,000 cache events by default.
Users can increase or decrease the three byte limits in Settings → Advanced →
Event storage. The cache event ceiling scales with its bytes:
`floor(cacheBytes × 50,000 / 134,217,728)` (64 MiB → 25,000; zero → zero).
Public/private reductions preserve existing events and block growth while over
quota; cache reductions schedule automatic LRU cleanup.
Cache counts toward public usage; a public limit alone does not trigger eviction.
Personal-copy contexts and inner authors share the private limit. Limits count
UTF-8 JSON event bytes; external chunk payloads retain their separate policy.
Owner references can preserve third-party public events; other third-party events
are disposable cache and may be evicted by approximate LRU. Expiration, explicit
deletion and newer coordinate replacement still apply to preserved events.

No-growth duplicates and net non-growing replacements remain admissible above a
limit. A refusal never partially replaces an event; cache removals committed
while attempting admission may remain. Missing quota coordination or database
enumeration returns `ok: false, code: 'unavailable'`. Invalid new signatures
return `code: 'invalid'`. Quota results reveal no other account's events or
identity. Limit configuration and aggregate usage are launcher-only, not methods
of this injected object. Full app reads/subscription deliveries update approximate
cache recency; ID-only reads, counts and synchronization do not.

`window.napp.getWindowNappEventStoreFor(pubkey)` synchronously returns the same
six-method API for a member of the app's current persona. The public key uses
the same 64-character hexadecimal format as `getWindowNostrFor`. Calls made
before the handshake wait for the connection. This does not change
`window.napp.eventStore`, merge stores, or switch the instance's primary user.

```js
const publicKeys = await window.napp.getPersonaPublicKeys()
for (const pubkey of publicKeys) {
  const store = window.napp.getWindowNappEventStoreFor(pubkey)
  const { results } = await store.query({ kinds: [3] })
  updateKnownContacts(pubkey, results)
}
```

Each call validates current persona membership, including calls on previously
created objects. Invalid or unavailable keys reject with
`error.code === 'PUBKEY_NOT_IN_PERSONA'`; access is also checked after pending
permissions and before returning results. Existing event permissions still
apply, with the target account identified in permission requests. Signing and
personal-copy cryptography use the target account and its lock/read-only rules.

Subscriptions belong to the requesting document. They are cancelled on document
unload, and scoped subscriptions fail with `PUBKEY_NOT_IN_PERSONA` when the
member is removed, including while waiting for new events. Apps should follow
`onPersonaPublicKeysChanged` to reconcile consumers and discard data they no
longer need. Persona access does not define an app's inbox or account-switching
policy; those remain app-level decisions.

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


`subscribe(filter, { initial: true })` registers live delivery before querying
stored matches, then emits the snapshot followed by buffered and future matches.
Each item is `{ result: event }` (live items may also include metadata). Snapshot
and live results can overlap; deduplicate by event ID. Existing filters, app
claims and permissions apply to both phases. `return()` cancels live delivery
also while the snapshot is pending. Without `initial`, subscriptions remain
future-only. Feature detection: `(await eventStore.supports()).includes('subscribe:initial')`.
This option requires the companion launcher update.

### Personal copies

Personal copies are private signed kind-1006 wrappers, never relay publications.
`addPersonalCopy` encrypts and signs through the owner's vault and returns
`{ event: wrapper, result }`; check `result.ok` before reporting a successful save.
A self-authored unsigned input can contain only `kind`, `created_at`, `tags` and
`content`; the launcher supplies the owner. An optional own `pubkey` is normalized
away. Do not give an unsigned input an `id` or `sig`.

Always supply the intended context: `dm:<peer hex pubkey>` for a conversation,
including the owner's own pubkey for self chat, or `''` for generic private
account data. Query/subscribe return encrypted wrappers, not plaintext rumors.
For example, reading the owner's self chat uses:

```js
const owner = await window.nostr.peekPublicKey()
const context = await window.nostr.obfuscate(`dm:${owner}`, '1006', '')
const filter = {
  kinds: [1006], authors: [owner], '#k': ['9'],
  '#c': [context], '#v': ['0', '1']
}
const subscription = window.napp.eventStore.subscribe(filter, { initial: true })
for await (const { result: wrapper } of subscription) {
  const base64url = await window.nostr.nip44v3.decrypt(owner, '9', '', wrapper.content)
  // Decode base64url bytes as UTF-8 JSON to obtain the inner event/template.
}
```

`k` identifies the inner kind, `c` holds the obfuscated context, and `v` records
provenance: `0` signed original, `1` direct rumor/self template, `2` hearsay.
For a self template, compute the original event ID using its fields plus the
owner pubkey; replies refer to that ID, never the wrapper ID. Decryption and
obfuscation use normal vault permissions and account lock/read-only constraints.
Neither a self template nor a direct rumor becomes signed proof of its sender.


For local nsec accounts, the companion vault update signs personal copies using
persisted local content keys without relay publication. Remote bunker signers
retain their own connectivity requirements.

### Local event removal

`removeLocal` is available on `window.napp.eventStore` and stores returned by
`getWindowNappEventStoreFor(pubkey)`. `supports()` includes `removeLocal`.
Calls wait for the existing launcher handshake.

```js
await window.napp.eventStore.removeLocal([
  ['e', eventId],
  ['a', `${kind}:${pubkey}:${d}`]
])
// { ok: true, code: 'deleted', message: 'Events were removed locally.', deleted: 2 }
```

Pass 1–100 exact two-element pairs, exclusively `e` or `a`. The entire input is
validated before requesting permissions or deleting anything. IDs and pubkeys
are hexadecimal (case-insensitive); addresses follow NostrDB coordinates,
preserving empty `d` and identifiers containing colons. Regular replaceable
coordinates use empty `d`. An `e` removes exactly that ID; an `a` removes the
version present when the transaction runs, even if it arrived while authorization
was pending. Targets and overlapping matches are deduplicated. Absent events are
ignored. Target personal copies using their wrapper ID/address, not the inner event.

Permissions are exactly those of a kind 5 descriptor with these target tags:
address-only requests use access to the target kinds (including existing transport
exceptions); any ID target requests one-time `delete` with `remember: false`.
No event is signed or persisted. Permission denial and loss of persona access
reject the Promise through the existing bridge. Access is rechecked after
authorization and under the global quota lock before the transaction.

The selected account's complete local records are removed, including records
from other authors, protected records, personal copies and records shared between
apps. This is not limited to the calling app's association. It neither deletes
referrers nor cascades to their targets. Events, references, cache classification,
usage and removed deletion-request contributions update atomically, even above
quota. Losing the last owner reference demotes remaining targets to cache and
schedules cleanup if necessary. No new tombstone or synthetic Nostr event is made.

No matches return `{ ok: true, code: 'noop', message, deleted: 0 }`. Operational
failures return `{ ok: false, code: 'invalid' | 'unavailable' | 'error', message,
deleted: 0 }`. Results do not expose event contents, additional IDs or other accounts.
Success confirms the NostrDB transaction; external chunk/blob reconciliation may
finish later, with shared payloads retaining their existing policies.

Locally removed events may be received again. Existing queues/snapshots are not
revoked, and subscriptions do not receive removal notifications. Normal kind 5
processing, including its ephemeral variant, remains unchanged.
