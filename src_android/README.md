# WheelSoul Android

This Android prototype embeds the shared React UI from `../src/web` using
Capacitor. `native/` implements the legacy XR protocol in TypeScript; the
Capacitor BLE plugin performs GATT operations directly on the phone. No PC,
Python server, official app, account, or Internet connection is needed at runtime.

## Build a debug APK on Linux

Requirements:

- Node.js/npm as specified in the main README; run `npm ci` at the repository root.
- JDK 21.
- Android SDK platform 36 and build-tools 36.0.0.
- Android SDK licenses accepted by the person setting up the SDK.

If installed elsewhere, set these paths before building:

```sh
export JAVA_HOME=/path/to/jdk-21
export ANDROID_HOME=/path/to/android-sdk
./build_android.sh
```

The helper defaults to `~/.local/share/wheelsoul/jdk-21` and
`~/.local/share/wheelsoul/android-sdk`, which are the local development-toolchain
locations. It does not silently download SDKs or accept licenses on another user's
behalf. Android Studio can also provide the SDK.

The helper builds the shared UI, synchronizes it to Android, uses the Gradle wrapper
to build **only `assembleDebug`**, verifies APK signing, and writes
`dist_android/WheelSoul-<version>-debug.apk`.

## Signing and updates

Debug APKs are signed too. The helper creates a dedicated key at
`~/.local/share/wheelsoul/android-debug.keystore` if none exists. Alternatively, set
`WHEELSOUL_DEBUG_KEYSTORE` to your existing WheelSoul key. The alias and debug
password are the standard `androiddebugkey` / `android`.

**Back up the private keystore and keep using it for every distributed update.**
Different keys cannot update an existing installation without uninstalling it,
which loses local app data. Keystores and APKs are Git-ignored. Do not upload the
key alongside the APK.

The dashboard, Android version name, and APK filename use `displayVersion` in the
root `package.json` (currently `0.01`). Its npm `version` remains a valid semantic
version (`0.0.1`). For future downloads, increase `versionCode` in
`android/app/build.gradle` and update both version fields. Upload the debug APK to a GitHub
Release; no app store or release build is required.

## Install and test

Download the APK from the [GitHub Releases page](https://github.com/PascalCorpsman/WheelSoul/releases)
on your phone, open it, and allow installation from that source. Alternatively,
enable USB debugging, connect the phone, confirm its USB authorization prompt, then:

```sh
"$ANDROID_HOME/platform-tools/adb" devices
"$ANDROID_HOME/platform-tools/adb" install -r dist_android/WheelSoul-0.01-debug.apk
```

The app starts in demo mode. Disable Demo, turn on Bluetooth, close other BLE apps,
choose a board, and allow the Nearby devices permission. Android 7-11 also require
location permission/services for BLE scanning; Android 12+ do not require location
permission here. The app never pairs with a PIN or changes riding mode.

For the first hardware test, keep the board stationary and the app in the foreground.
Check the board identity/error messages, current, pack voltage, and all 15 fresh
cell groups. A full cell cycle takes time; missing data displays `-`.

## Checking for updates

Open dashboard settings and select **Check for updates**. WheelSoul checks the
public GitHub Releases API only when requested, includes preview releases, and
offers the highest newer numeric version with an uploaded
`WheelSoul-<version>-debug.apk` asset. Publish tags as `v<displayVersion>`.
There is no GitHub login, automatic background check, or automatic installation.

The download link opens GitHub in the browser. Download the APK and confirm its
installation in Android. Opening the browser leaves WheelSoul and disconnects BLE.
Network errors and GitHub's anonymous rate limit are shown explicitly; the
**All GitHub releases** link remains available if the API cannot be reached.

## First-version limitations

- Hardware-tested protocol reference: XR hardware 4206 / Gemini 4134. The
  TypeScript port has synthetic tests, but Android BLE still requires real-phone
  validation. Do not infer compatibility from the supported handshake range alone.
- **The app disconnects when it leaves the foreground or the screen is locked.**
  This avoids relying on suspended WebView keepalive timers. Continuous ride
  recording with a locked screen needs a future Android foreground service.
- Recorded maxima are only speeds observed by WheelSoul, not a historical maximum
  read from the board. Foreground-only operation will miss background riding peaks.
- Names and readings are local to the Android app; PC browser data is not
  automatically imported. Android cloud backup is disabled.
- Debug builds allow development debugging; treat this as an unofficial prototype.

The same write boundary as the PC version applies: existing firmware/session value,
legacy authentication response, and authentication notification subscription only.
