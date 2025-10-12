import { f, useClosestStore, useComputed } from '#f'

f(function nappAssetsCachingProgressBar () {
  let cachingProgress$
  try {
    ({ cachingProgress$ } = useClosestStore('<napp-assets-caching-progress-bar>'))
  } catch (err) {
    // ancestor initializing the store was garbage collected first
    console.warn('No cachingProgress$ store found', err)
    return
  }

  const progressEntries$ = useComputed(() =>
    Object.entries(cachingProgress$()).filter(([key]) =>
      // Filter out framework-injected fields and only include actual file paths
      !key.startsWith('_') && (key.startsWith('/') || key.includes('.'))
    )
  )
  const hasAnyProgress$ = useComputed(() => progressEntries$().length > 0)
  const progressSummary$ = useComputed(() => {
    const entries = progressEntries$()
    if (entries.length === 0) return { overallProgress: 0, fileList: '', fileCount: 0 }

    const totalProgress = entries.reduce((sum, [_, data]) => sum + data.progress, 0)
    const overallProgress = Math.round(totalProgress / entries.length)

    const fileNames = entries.map(([path]) => {
      const filename = path.split('/').pop() || path
      return filename.length > 20 ? filename.slice(0, 17) + '...' : filename
    })

    const fileList = fileNames.length > 3
      ? fileNames.slice(0, 3).join(', ') + `... (+${fileNames.length - 3} more)`
      : fileNames.join(', ')

    return { overallProgress, fileList, fileCount: entries.length }
  })

  const style$ = useComputed(() => `
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    z-index: 1000;
    background: linear-gradient(90deg,
      oklch(0.62 0.22 297.62 / 0.9) 0%,
      oklch(0.62 0.22 297.1 / 0.9) ${progressSummary$().overallProgress}%,
      rgba(0, 0, 0, 0.7) ${progressSummary$().overallProgress}%,
      rgba(0, 0, 0, 0.7) 100%
    );
    height: 4px;
    transition: all 0.3s ease;
    opacity: ${hasAnyProgress$() ? 1 : 0};
    transform: translateY(${hasAnyProgress$() ? '0' : '-100%'});
  `)

  const textStyle$ = useComputed(() => `
    position: absolute;
    top: 6px;
    left: 8px;
    right: 8px;
    background: rgba(0, 0, 0, 0.8);
    color: white;
    font-size: 12px;
    padding: 4px 8px;
    border-radius: 4px;
    backdrop-filter: blur(4px);
    transition: all 0.3s ease;
    opacity: ${hasAnyProgress$() ? 1 : 0};
    transform: translateY(${hasAnyProgress$() ? '0' : '-100%'});
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  `)

  return this.h`
    <div style=${style$()} />
    <div style=${textStyle$()}>
      Caching ${progressSummary$().fileCount} asset${progressSummary$().fileCount !== 1 ? 's' : ''}
      (${progressSummary$().overallProgress}%): ${progressSummary$().fileList}
    </div>
  `
})
