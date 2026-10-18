// __DSH_REMOTE_PACKAGE__ is replaced with android.package by with-remote-foreground-service.cjs.
package __DSH_REMOTE_PACKAGE__

import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.bridge.ReactContextBaseJavaModule
import com.facebook.react.bridge.ReactMethod

class RemoteForegroundServiceModule(
  private val context: ReactApplicationContext,
) : ReactContextBaseJavaModule(context) {
  override fun getName(): String = "DshRemoteForegroundService"

  @ReactMethod
  fun start() {
    RemoteForegroundService.start(context)
  }

  @ReactMethod
  fun stop() {
    RemoteForegroundService.stop(context)
  }
}

