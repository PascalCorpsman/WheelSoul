import test from 'node:test'
import assert from 'node:assert/strict'
import { RELEASES_URL, checkForUpdate, findUpdate } from '../updates.ts'

function release(version, options = {}) {
  const tag = `v${version}`
  const name = `WheelSoul-${version}-debug.apk`
  return {
    draft: false, prerelease: true, tag_name: tag,
    assets: [{ name, state: 'uploaded', browser_download_url: `${RELEASES_URL}/download/${tag}/${name}` }],
    ...options,
  }
}

test('preview APKs are included and numeric versions are ordered, not lexically or by release date', () => {
  assert.deepEqual(findUpdate([release('0.09'), release('0.10'), release('0.02')], '0.01'), {
    version: '0.10', url: `${RELEASES_URL}/tag/v0.10`,
  })
  assert.equal(findUpdate([release('0.01'), release('0.00')], '0.01'), null)
  assert.equal(findUpdate([release('0.01.0')], '0.01'), null)
  assert.equal(findUpdate([release('0.02', { prerelease: false })], '0.01').version, '0.02')
})

test('drafts, non-version tags and missing or incomplete APK assets do not offer updates', () => {
  assert.equal(findUpdate([
    release('0.02', { draft: true }),
    release('0.03', { assets: [] }),
    release('0.04', { assets: [{ name: 'WheelSoul-0.04-debug.apk', state: 'starter' }] }),
    release('0.05', { tag_name: 'experimental' }),
  ], '0.01'), null)
})

test('invalid metadata and unexpected APK URLs are explicit errors', () => {
  assert.throws(() => findUpdate({}, '0.01'), /invalid release metadata/)
  assert.throws(() => findUpdate([{}], '0.01'), /invalid release metadata/)
  assert.throws(() => findUpdate([], 'broken'), /installed WheelSoul version/)
  const wrong = release('0.02')
  wrong.assets[0].browser_download_url = 'https://example.com/other.apk'
  assert.throws(() => findUpdate([wrong], '0.01'), /unexpected APK download address/)
})

test('manual checks paginate the public releases API and pass cancellation without credentials', async (t) => {
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls++
    assert.equal(url, `https://api.github.com/repos/PascalCorpsman/WheelSoul/releases?per_page=100&page=${calls}`)
    assert.equal(options.signal, controller.signal)
    assert.deepEqual(options.headers, { Accept: 'application/vnd.github+json' })
    return new Response(JSON.stringify(calls === 1 ? Array.from({ length: 100 }, () => release('0.01')) : [release('0.02')]))
  })
  assert.equal((await checkForUpdate('0.01', controller.signal)).version, '0.02')
  assert.equal(calls, 2)
})

test('empty repositories have no update; HTTP errors, rate limits and bad JSON are not success', async (t) => {
  const signal = new AbortController().signal
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('[]'))
  assert.equal(await checkForUpdate('0.01', signal), null)
  fetch.mock.mockImplementation(async () => new Response('', { status: 503 }))
  await assert.rejects(checkForUpdate('0.01', signal), /HTTP 503/)
  fetch.mock.mockImplementation(async () => new Response('', { status: 403, headers: { 'x-ratelimit-remaining': '0' } }))
  await assert.rejects(checkForUpdate('0.01', signal), /rate-limited/)
  fetch.mock.mockImplementation(async () => new Response('{}'))
  await assert.rejects(checkForUpdate('0.01', signal), /invalid release metadata/)
  fetch.mock.mockImplementation(async () => new Response('not json'))
  await assert.rejects(checkForUpdate('0.01', signal), SyntaxError)
})

test('network failures and cancellation propagate to the caller', async (t) => {
  const controller = new AbortController()
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Network unavailable') })
  await assert.rejects(checkForUpdate('0.01', controller.signal), /Network unavailable/)
  controller.abort()
  fetch.mock.mockImplementation(async (_url, { signal }) => { signal.throwIfAborted() })
  await assert.rejects(checkForUpdate('0.01', controller.signal), { name: 'AbortError' })
})
