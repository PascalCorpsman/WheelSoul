export const RELEASES_URL = 'https://github.com/PascalCorpsman/WheelSoul/releases'
const API_URL = 'https://api.github.com/repos/PascalCorpsman/WheelSoul/releases'

export interface Update {
  version: string
  url: string
}

function versionParts(version: string): number[] | null {
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(version)) return null
  const parts = version.split('.').map(Number)
  return parts.every(Number.isSafeInteger) ? parts : null
}

function newer(candidate: number[], current: number[]): boolean {
  for (let i = 0; i < Math.max(candidate.length, current.length); i++) {
    const difference = (candidate[i] ?? 0) - (current[i] ?? 0)
    if (difference !== 0) return difference > 0
  }
  return false
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function findUpdate(releases: unknown, currentVersion: string): Update | null {
  const current = versionParts(currentVersion)
  if (!current) throw new Error('The installed WheelSoul version is invalid.')
  if (!Array.isArray(releases)) throw new Error('GitHub returned invalid release metadata.')
  let latest: Update | null = null
  let latestParts = current
  for (const release of releases) {
    if (!record(release) || typeof release.draft !== 'boolean' ||
      typeof release.tag_name !== 'string' || !Array.isArray(release.assets)) {
      throw new Error('GitHub returned invalid release metadata.')
    }
    if (release.draft || !release.tag_name.startsWith('v')) continue
    const version = release.tag_name.slice(1)
    const parts = versionParts(version)
    if (!parts || !newer(parts, latestParts)) continue
    const filename = `WheelSoul-${version}-debug.apk`
    const asset = release.assets.find((value) => record(value) && value.name === filename)
    if (!record(asset) || asset.state !== 'uploaded') continue
    if (asset.browser_download_url !== `${RELEASES_URL}/download/${release.tag_name}/${filename}`) {
      throw new Error('GitHub returned an unexpected APK download address.')
    }
    latest = { version, url: `${RELEASES_URL}/tag/${release.tag_name}` }
    latestParts = parts
  }
  return latest
}

export async function checkForUpdate(currentVersion: string, signal: AbortSignal): Promise<Update | null> {
  const releases: unknown[] = []
  for (let page = 1; ; page++) {
    const response = await fetch(`${API_URL}?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json' }, signal,
    })
    if (!response.ok) {
      if (response.status === 403 && response.headers.get('x-ratelimit-remaining') === '0') {
        throw new Error('GitHub update checks are rate-limited. Try again later or open the releases page.')
      }
      throw new Error(`GitHub update check failed (HTTP ${response.status}).`)
    }
    const batch: unknown = await response.json()
    if (!Array.isArray(batch)) throw new Error('GitHub returned invalid release metadata.')
    releases.push(...batch)
    if (batch.length < 100) return findUpdate(releases, currentVersion)
  }
}
