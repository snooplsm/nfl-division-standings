import { readFileSync, writeFileSync, existsSync, watch, mkdirSync, copyFileSync } from 'node:fs'
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

  const ffmpegDir = path.join(root, 'public', 'ffmpeg')
  mkdirSync(ffmpegDir, { recursive: true })
  const ffmpegCopies = [
    {
      from: path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.js'),
      to: path.join(ffmpegDir, 'ffmpeg-core.js')
    },
    {
      from: path.join(root, 'node_modules', '@ffmpeg', 'core', 'dist', 'esm', 'ffmpeg-core.wasm'),
      to: path.join(ffmpegDir, 'ffmpeg-core.wasm')
    },
    {
      from: path.join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'worker.js'),
      to: path.join(ffmpegDir, 'ffmpeg-class-worker.js')
    },
    {
      from: path.join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'const.js'),
      to: path.join(ffmpegDir, 'const.js')
    },
    {
      from: path.join(root, 'node_modules', '@ffmpeg', 'ffmpeg', 'dist', 'esm', 'errors.js'),
      to: path.join(ffmpegDir, 'errors.js')
    }
  ]
  for (const { from, to } of ffmpegCopies) {
    if (existsSync(from)) {
      copyFileSync(from, to)
    }
  }
  console.log('Synced public/ffmpeg runtime files')
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
