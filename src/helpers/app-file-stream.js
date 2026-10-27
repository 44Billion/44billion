// Streams the chunks currently available from IndexedDB without ending the
// response at a provisional Blossom total. The caller retries after receiving
// the downloader's completion report and `downloadValidated` becomes true.
export async function streamAppFileChunks ({
  startIndex,
  totalChunks,
  downloadValidated,
  loadChunk,
  sendChunk,
  sendTerminal
}) {
  let nextIndex = startIndex
  let hasSentLast = false

  while (!hasSentLast) {
    const chunk = await loadChunk(nextIndex)
    if (!chunk) break

    if (totalChunks === null) {
      const parsedTotal = chunk.total ?? Number(chunk.evt.tags.find(tag => tag[0] === 'mmr')?.[2])
      if (!Number.isNaN(parsedTotal) && parsedTotal > 0) totalChunks = parsedTotal
    }

    const isLast = totalChunks !== null && nextIndex === totalChunks - 1
    if (isLast && !downloadValidated) break

    sendChunk({ chunk, index: nextIndex, isLast })
    nextIndex++
    if (isLast) hasSentLast = true
  }

  if (!hasSentLast && downloadValidated &&
      totalChunks !== null && nextIndex >= totalChunks) {
    sendTerminal()
    hasSentLast = true
  }

  return { hasSentLast, nextIndex, totalChunks }
}
