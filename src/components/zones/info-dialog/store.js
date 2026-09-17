// Pure factory for the informational dialog store. Kept free of framework
// imports so it can be unit-tested directly.
//
// Fire and forget: there is no promise to resolve and no action to confirm.
// The copy lives in plain signals (not computed getters) so the card renders
// the current message even when it was created before the first showInfo.
// Closing only clears the open flag and keeps the copy, so the card does not
// blank out during its closing transition.
export function createInfoDialogStore () {
  return {
    current$: null,
    title$: '',
    message$: '',
    isOpen$ () { return Boolean(this.current$()) },
    showInfo ({ title, message }) {
      this.title$(title)
      this.message$(message)
      this.current$({ title, message })
    },
    close () {
      this.current$(null)
    }
  }
}
