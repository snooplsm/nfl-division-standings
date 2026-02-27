import { readFileSync, writeFileSync, existsSync, watch } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'

const root = process.cwd()
const isWatchMode = process.argv.includes('--watch')

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
const sourceFiles = [...divisionFiles, 'stations.yml']

function toLocalLogoUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl
  try {
    const parsed = new URL(rawUrl)
    const fileName = decodeURIComponent(path.basename(parsed.pathname)).replace(/\s+/g, '-')
    const localPath = path.join(root, 'public', 'logos', fileName)
    if (!existsSync(localPath)) return rawUrl
    return `/logos/${encodeURIComponent(fileName)}`
  } catch {
    return rawUrl
  }
}

function buildData() {
  const teamsByDivision = {}
  for (const file of divisionFiles) {
    const source = readFileSync(path.join(root, file), 'utf8')
    const parsed = yaml.load(source) || {}
    Object.assign(teamsByDivision, parsed)
  }

  const stationsSource = readFileSync(path.join(root, 'stations.yml'), 'utf8')
  const stationsByDivision = yaml.load(stationsSource) || {}

  for (const divisionKey of Object.keys(teamsByDivision)) {
    teamsByDivision[divisionKey] = (teamsByDivision[divisionKey] || []).map((team) => ({
      ...team,
      logo: toLocalLogoUrl(team.logo)
    }))
  }

  for (const divisionKey of Object.keys(stationsByDivision)) {
    stationsByDivision[divisionKey] = (stationsByDivision[divisionKey] || []).map((station) => ({
      ...station,
      url: toLocalLogoUrl(station.url)
    }))
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    teamsByDivision,
    stationsByDivision
  }

  writeFileSync(
    path.join(root, 'public', 'data.json'),
    JSON.stringify(payload),
    'utf8'
  )

  console.log('Wrote public/data.json')
}

buildData()

if (isWatchMode) {
  console.log('Watching YAML files for changes...')
  let timer = null
  const scheduleBuild = (file) => {
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      try {
        console.log(`Detected change: ${file}`)
        buildData()
      } catch (error) {
        console.error('build:data watch error:', error)
      }
    }, 120)
  }

  sourceFiles.forEach((file) => {
    const fullPath = path.join(root, file)
    watch(fullPath, () => scheduleBuild(file))
  })
}
