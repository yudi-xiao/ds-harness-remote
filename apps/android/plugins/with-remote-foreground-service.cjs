const fs = require('node:fs')
const path = require('node:path')
const {
  withAndroidManifest,
  withDangerousMod,
  withMainApplication,
} = require('@expo/config-plugins')

const PACKAGE_TOKEN = '__DSH_REMOTE_PACKAGE__'
const SOURCE_DIR = path.join(__dirname, 'remote-foreground-service')

function projectPackage(config) {
  const packageName = config.android?.package
  if (typeof packageName !== 'string'
    || !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/u.test(packageName)) {
    throw new Error('app.json must define a valid android.package before adding the remote foreground service.')
  }
  return packageName
}

/**
 * Registers the host-only remote foreground service and copies its Kotlin
 * sources into the application package. The package name is read from
 * `app.json`, so personal builds can rename the application without editing
 * the bundled sources.
 */
function withRemoteForegroundService(config) {
  projectPackage(config)

  config = withAndroidManifest(config, config => {
    const manifest = config.modResults.manifest
    manifest['uses-permission'] ??= []
    const permissions = new Set(manifest['uses-permission'].map(item => item.$?.['android:name']))
    for (const name of [
      'android.permission.FOREGROUND_SERVICE',
      'android.permission.FOREGROUND_SERVICE_REMOTE_MESSAGING',
    ]) {
      if (!permissions.has(name)) manifest['uses-permission'].push({ $: { 'android:name': name } })
    }
    const application = manifest.application?.[0]
    if (application === undefined) throw new Error('Android application manifest entry is missing')
    const services = application.service ?? []
    if (!services.some(item => item.$?.['android:name'] === `.${'RemoteForegroundService'}`)) {
      services.push({ $: {
        'android:name': '.RemoteForegroundService',
        'android:exported': 'false',
        'android:foregroundServiceType': 'remoteMessaging',
      } })
    }
    application.service = services
    return config
  })

  config = withMainApplication(config, config => {
    const marker = 'add(RemoteForegroundServicePackage())'
    if (!config.modResults.contents.includes(marker)) {
      const anchor = 'PackageList(this).packages.apply {'
      if (!config.modResults.contents.includes(anchor)) throw new Error('MainApplication package list anchor is missing')
      config.modResults.contents = config.modResults.contents.replace(anchor, `${anchor}\n          ${marker}`)
    }
    return config
  })

  return withDangerousMod(config, ['android', async config => {
    const packageName = projectPackage(config)
    const destination = path.join(
      config.modRequest.platformProjectRoot,
      'app',
      'src',
      'main',
      'java',
      ...packageName.split('.'),
    )
    fs.mkdirSync(destination, { recursive: true })
    for (const file of fs.readdirSync(SOURCE_DIR)) {
      const source = fs.readFileSync(path.join(SOURCE_DIR, file), 'utf8')
      fs.writeFileSync(path.join(destination, file), source.replaceAll(PACKAGE_TOKEN, packageName))
    }
    return config
  }])
}

module.exports = withRemoteForegroundService
