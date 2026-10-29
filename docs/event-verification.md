# Event signature verification

App-owned event verification uses `src/services/event-verification.js` and the
pinned `nostr-wasm@0.1.0` dependency. The package embeds its libsecp256k1 WASM
binary in JavaScript, so startup and offline verification need no external fetch.
Each JavaScript context initializes one shared verifier. Import evaluation waits
for initialization; initialization failure selects the existing JavaScript
verifier from `libp2r2p/event`. `verificationBackend` reports the selected backend
without logging event data.

Both paths retain libp2r2p's structural validation and exact lowercase hex lengths.
WASM verifies the canonical event ID and BIP-340 signature. Results are not cached
on event objects or by event ID, so changing signed fields requires verification
again. Payloads over a conservative 256 Ki UTF-16 code-unit budget (content plus
tag strings and delimiters) use JavaScript to avoid the WASM package's fixed heap.
Signing and key management are unchanged.

The shared verifier covers launcher NostrDB validation, chunk validation,
personal-copy helpers, cached account metadata, relay AUTH validation and napplet
services. The installed libp2r2p 0.11.36 library still uses its own JavaScript
verifier internally, including relay input and private-message processing. This
integration does not replace those internal calls or verification performed by
independent app iframes or the vault. A public library backend hook is needed to
extend coverage without patching installed dependencies.

`tests/services/event-verification.test.js` exercises real WASM verification,
mutation and malformed-input rejection, initialization fallback and large payloads.
Performance and CPU improvement still require measurements in Firefox and Chrome;
this integration does not introduce worker threads or CPU scheduling controls.
