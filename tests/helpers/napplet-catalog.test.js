import assert from 'node:assert/strict'
import { it } from 'node:test'
import { filterNappletCatalog, nappletArchetypes } from '#helpers/napplet-catalog.js'

const entry = (title, roles) => ({
  event: { tags: roles.map(role => ['z', role]) },
  manifest: { title, description: '', dTag: title.toLowerCase() }
})
const feed = entry('Timeline', ['feed'])
const note = entry('Composer', ['note'])
const both = entry('Social tools', ['feed', 'note'])
const other = entry('Clock', [])
const entries = [feed, note, both, other]

it('reads unique current archetype declarations without requiring intent contracts', () => {
  const item = entry('Test', ['feed', 'feed', 'note', 'bad/role', '', undefined])
  item.event.tags.push(['i', 'napplet:profile/open'], ['archetype', 'legacy'], ['z'])
  assert.deepEqual(nappletArchetypes(item), ['feed', 'note'])
})

it('shows all entries by default, including those without an archetype', () => {
  assert.deepEqual(filterNappletCatalog(entries), entries)
})

it('matches any selected archetype and combines that with search', () => {
  assert.deepEqual(filterNappletCatalog(entries, { archetypes: ['feed'] }), [feed, both])
  assert.deepEqual(filterNappletCatalog(entries, { archetypes: ['feed', 'note'] }), [feed, note, both])
  assert.deepEqual(filterNappletCatalog(entries, { archetypes: ['note'], search: ' SOCIAL ' }), [both])
  assert.deepEqual(filterNappletCatalog(entries, { archetypes: ['note'], search: 'Timeline' }), [])
  assert.deepEqual(filterNappletCatalog(entries, { archetypes: ['unknown'] }), [])
})
