import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const root = process.cwd()
const logosDir = path.join(root, 'public', 'logos')
mkdirSync(logosDir, { recursive: true })
const shouldRefresh = process.argv.includes('--refresh')

const divisionFiles = [
  'nfceast.yml',
  'nfc_north.yml',
  'nfc_south.yml',
  'nfc_west.yml',
  'afc_east.yml',
  'afc_north.yml',
  'afc_south.yml',
  'afc_west.yml'
]

const urls = new Set()

for (const file of divisionFiles) {
  const parsed = yaml.load(readFileSync(path.join(root, file), 'utf8')) || {}
  for (const entries of Object.values(parsed)) {
    for (const team of entries || []) {
      if (team?.logo) urls.add(team.logo)
    }
  }
}

const stations = yaml.load(readFileSync(path.join(root, 'stations.yml'), 'utf8')) || {}
for (const entries of Object.values(stations)) {
  for (const station of entries || []) {
    if (station?.url) urls.add(station.url)
  }
}

let downloaded = 0
let skipped = 0
let failed = 0

for (const url of urls) {
  let name
  try {
    name = decodeURIComponent(path.basename(new URL(url).pathname)).replace(/\s+/g, '-')
  } catch {
    failed++
    continue
  }

  const outPath = path.join(logosDir, name)
  if (!shouldRefresh && existsSync(outPath)) {
    skipped++
    continue
  }

  try {
    const response = await fetch(url)
    if (!response.ok) {
      failed++
      continue
    }
    const body = await response.text()
    if (!body.includes('<svg')) {
      failed++
      continue
    }
    writeFileSync(outPath, body, 'utf8')
    downloaded++
  } catch {
    failed++
  }
}

console.log(`logos: downloaded=${downloaded} skipped=${skipped} failed=${failed}`)
