#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "${BASH_SOURCE[0]}")"

export JAVA_HOME="${JAVA_HOME:-$HOME/.local/share/wheelsoul/jdk-21}"
export PATH="$JAVA_HOME/bin:$PATH"
export ANDROID_HOME="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/.local/share/wheelsoul/android-sdk}}"
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export WHEELSOUL_DEBUG_KEYSTORE="${WHEELSOUL_DEBUG_KEYSTORE:-$HOME/.local/share/wheelsoul/android-debug.keystore}"

for command in npm node; do
    if ! command -v "$command" >/dev/null; then
        printf 'Missing command: %s. See src_android/README.md.\n' "$command" >&2
        exit 1
    fi
done
if [[ ! -x "$JAVA_HOME/bin/java" || ! -x "$JAVA_HOME/bin/keytool" ]]; then
    printf 'Set JAVA_HOME to a JDK 21 installation. See src_android/README.md.\n' >&2
    exit 1
fi
java_version=$("$JAVA_HOME/bin/java" -version 2>&1)
if [[ "$java_version" != *'version "21.'* ]]; then
    printf 'This build uses JDK 21. JAVA_HOME currently reports:\n%s\n' "$java_version" >&2
    exit 1
fi
if [[ ! -d "$ANDROID_HOME/platforms/android-36" || ! -x "$ANDROID_HOME/build-tools/36.0.0/apksigner" ]]; then
    printf 'Install Android SDK platform 36 and build-tools 36.0.0, and set ANDROID_HOME. See src_android/README.md.\n' >&2
    exit 1
fi
if [[ ! -d node_modules ]]; then
    printf 'JavaScript dependencies are missing. Run npm ci first.\n' >&2
    exit 1
fi

if [[ ! -f "$WHEELSOUL_DEBUG_KEYSTORE" ]]; then
    umask 077
    mkdir -p -- "$(dirname -- "$WHEELSOUL_DEBUG_KEYSTORE")"
    "$JAVA_HOME/bin/keytool" -genkeypair -keystore "$WHEELSOUL_DEBUG_KEYSTORE" \
        -storepass android -keypass android -alias androiddebugkey -keyalg RSA \
        -keysize 2048 -validity 10000 -dname "CN=WheelSoul Debug, O=WheelSoul, C=DE"
    printf 'Created private debug signing key: %s\nBack up this file to preserve APK update compatibility.\n' "$WHEELSOUL_DEBUG_KEYSTORE"
fi

version=$(node -p "require('./package.json').displayVersion")
npm run build
npx cap sync android
(
    cd src_android/android
    "$JAVA_HOME/bin/java" -classpath gradle/wrapper/gradle-wrapper.jar \
        org.gradle.wrapper.GradleWrapperMain --no-daemon "-PwheelSoulVersion=$version" assembleDebug
)

apk="src_android/android/app/build/outputs/apk/debug/app-debug.apk"
"$ANDROID_HOME/build-tools/36.0.0/apksigner" verify --verbose "$apk"
mkdir -p dist_android
output="dist_android/WheelSoul-$version-debug.apk"
cp -- "$apk" "$output"
printf '\nAPK ready: %s/%s\n' "$PWD" "$output"
