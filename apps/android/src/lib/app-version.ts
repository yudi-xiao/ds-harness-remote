import * as Application from 'expo-application'

/** Small footer label shown on the first screen and the sign-in screen. */
export function appVersionLabel(): string {
  const version = Application.nativeApplicationVersion ?? '0.7.0'
  const build = Application.nativeBuildVersion
  return build === null ? `v${version}` : `v${version} (${build})`
}
