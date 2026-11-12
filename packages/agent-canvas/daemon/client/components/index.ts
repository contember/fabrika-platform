// agent-canvas's canvas component set: the kernel's components plus the ones
// only this host can back (SecretInput, FileDrop and Download need the daemon's endpoints).
export * from '@fabrika/canvas-kernel/components'
export { Download } from './Download'
export { FileDrop } from './FileDrop'
export { SecretInput } from './SecretInput'
