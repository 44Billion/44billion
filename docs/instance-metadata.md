# Instance metadata

Every app document, including widget documents, receives these methods on
`window.napp` before the app's scripts run:

```js
const metadata = await window.napp.getInstanceMetadata()

const unsubscribe = window.napp.onInstanceMetadataChanged(metadata => {
  console.log(metadata.instanceKey, metadata.isVisible)
})

// Safe to call more than once.
unsubscribe()
```

Both methods deliver objects with this shape:

```json
{
  "instanceKey": "current-instance-key",
  "isWidget": true,
  "isPinned": true,
  "isLoaded": true,
  "isVisible": true,
  "otherInstances": [
    {
      "instanceKey": "another-instance-key",
      "isWidget": false,
      "isPinned": false,
      "isLoaded": true,
      "isVisible": false
    }
  ]
}
```

## Identity and peers

`instanceKey` is the existing opaque `appKey` or `widgetKey`, not the app's
`appId` or the shared bridge's ID. It stays the same across navigation, reload,
minimization, closure and reopening of a registered instance. Removing the
instance and creating another produces a new key. An app can use this key in
an instance-specific IndexedDB database name within its own origin. The API
does not create or delete that database.

`otherInstances` includes registered windows and widgets of the same app across
workspaces, even when closed or unloaded. When a persona is selected, peers must
select that same persona ID. Otherwise peers must also have no persona selected
and use the same workspace user public key. A persona containing one user is
still distinct from that user without a persona. Different personas with
overlapping public keys are not equivalent.

A persona is eligible only while it includes the instance's workspace user.
Losing that membership or deleting the persona resets the app/workspace selection
and immediately uses the workspace-user identity for peer matching, even before
persisted cleanup completes. All windows and widgets of that app/workspace share
this selection. Peer changes continue to use `onInstanceMetadataChanged`;
`onPersonaPublicKeysChanged` separately reports effective key-set changes (see
[Injected app API](../APP_API.md)).

The current instance is excluded. Peers are sorted by `instanceKey`, and each
contains only `instanceKey`, `isWidget`, `isPinned`, `isLoaded` and `isVisible`.

Standalone embedded single-napp launchers have temporary runtime keys rather
than registered persistent instances. They expose their existing key for the
lifetime of that launcher; they do not acquire a new persistent registration
through this API.

## Runtime state

The catalog is shared through existing local storage. Runtime flags describe
only this launcher document's execution context in the current tab; they do not
aggregate running instances from other browser tabs or embedded launcher realms.

- `isLoaded` means the current app document completed its bridge handshake. It
  does not promise that the app finished loading all its resources or data.
  Minimized documents remain loaded until actually unloaded.
- `isVisible` means loaded content is displayed by the launcher. It is false
  when the browser tab is hidden, a system route covers the instance, the document
  is unloaded, or its content is behind the launcher's loading/error overlay.
- Windows follow the actual CSS layout, including single/multi-window mode,
  ordering, viewport dimensions, clipping and widget reveal mode. An `open`
  window need not be visible.
- Widgets must be on the active widget page and not covered by a displayed
  window. A loading window also covers widgets. Revealing widgets hides windows
  and removes this obstruction.
- `isPinned` is the widget's persisted visual pin preference, including when
  unloaded or off-page. Regular windows always report `false`; toolbar app
  pinning is unrelated. Pinning preserves the iframe and `instanceKey`.
  Active pinned widgets appear above windows and system screens, below menus
  and dialogs. They still require loaded content, visible geometry and a visible
  browser tab to report `isVisible: true`.
- Editing an obstructed pinned widget temporarily reveals the grid, hiding
  windows and system screens until selection ends. Visibility follows those
  displayed layers without navigating or unloading the covered documents.

These flags describe launcher presentation, not occlusion by operating-system
windows. Changes are batched; the API is not a frame-by-frame visibility trace.

## Subscription semantics

`getInstanceMetadata()` waits for the initial bridge snapshot and returns the
latest snapshot on each call. `onInstanceMetadataChanged(listener)` returns its
unsubscribe function immediately. The listener receives the initial snapshot
asynchronously, then only changed snapshots. Unsubscribing cancels queued future
deliveries, including the initial delivery when called before initialization.

Every delivery is an independent copy. Mutating it cannot affect the cache or
other listeners. A callback's thrown exception or rejected promise is reported
without preventing delivery to the remaining listeners. Repeated registrations
of the same function can be cancelled independently.

Creating/removing instances, changing identity, loading/unloading documents and
changing presentation or a widget's pin can produce updates, including in
related instances. The bridge subscription belongs to
the current document and is removed when it unloads or is replaced. No additional
persistent keys, stores or migrations are introduced.
