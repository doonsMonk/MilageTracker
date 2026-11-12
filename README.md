# MilageTracker

Android app for tracking fuel mileage and running costs of cars and motorcycles.

- Fill-up log with km/l, cost per km, and regular vs 95-octane comparison
- Tolls, EMI and other expenses, with total cost and overall cost per km
- Monthly summary, trip fuel/cost estimate
- Print / save as PDF, CSV export, zip backup and restore
- Bill photos attached to fill-ups and expenses
- Multiple vehicles, light/dark theme
- Optional Google Drive sync (log and bill photos)

## Install

The latest build is in the [release](release/) folder of this repository:

- [MilageTracker-1.4.apk](https://github.com/doonsMonk/MilageTracker/raw/main/release/MilageTracker-1.4.apk)

On the phone (Android 10 or newer), tap the link above to download the file, open it, and allow
installing from this source when Android asks. Later versions install over the existing app and keep its data.
The published APK contains no log data and starts with one empty vehicle.

## How it is built

The UI is plain HTML/CSS/JS in `app/src/main/assets/www`, hosted in a small native shell
(`MainActivity.java`) that provides storage, printing, file pickers, the camera, and Drive sync
(`Drive.java`). Calculations live in `calc.js` and have no DOM dependency.

## Build

Requires JDK 17+ and the Android SDK (compileSdk 35). Create `local.properties` with
`sdk.dir=<path to your Android SDK>`, then:

```
gradlew assembleDebug
```

The APK is written to `app/build/outputs/apk/debug/app-debug.apk`.

## Data

No log data is stored in this repository. On a phone the log lives in the app's private storage.
`assets/www/seed.js` (optional starting data, `var SEED_DATA = {...}`) and `assets/www/car.jpg`
are git-ignored; without them the app starts with one empty vehicle.

## Google Drive sync

Sync needs your own Google Cloud project: enable the Google Drive API, configure the OAuth
consent screen with the `drive.file` scope, and create an **Android** OAuth client for package
`app.mileagelog` with the SHA-1 of the key that signs your build.

## License

[MIT](LICENSE)
