export function nappletArchetypes (entry) {
  return [...new Set(entry.event.tags
    .filter(tag => tag[0] === 'z' && typeof tag[1] === 'string' && /^[a-z0-9][a-z0-9-]*$/.test(tag[1]))
    .map(tag => tag[1]))]
}

export function filterNappletCatalog (entries, { search = '', archetypes = [] } = {}) {
  const query = search.trim().toLocaleLowerCase()
  return entries.filter(entry => {
    const { manifest } = entry
    return (!archetypes.length || nappletArchetypes(entry).some(role => archetypes.includes(role))) &&
      `${manifest.title || ''} ${manifest.description || ''} ${manifest.dTag || ''}`.toLocaleLowerCase().includes(query)
  })
}
