# Tow Monitor

A single-page web app that watches a winding bobbin through a tablet camera and warns
before the material runs out. All detection runs in the browser — no server, no
dependencies, no build step.

**Live: https://ioarun.github.io/tow-monitor/**

## How it works

The core tube is *warm* and the wound material is not, even where the material is the
brighter of the two — so pixels are classified on `R - B` rather than on luminance. A
rotated rectangle is fitted over the tube; the fraction of it reading warm is the
exposure percentage.

Calibration needs two frames of one run — full bobbin, then bare core. The region that
*gained* warmth between them is the tube, which excludes the cream end caps for free:
they are cream in both frames, so they gain nothing.

## Files

| | |
|---|---|
| `cv.js` | detection: warmth, morphology, connected components, PCA, calibration |
| `index.html` | the app — camera and file sources, calibration, alerting |
| `sw.js` | service worker, so it opens with no connectivity |

`cv.js` has no DOM dependency and runs under Node, which is how it is checked against
the Python implementation it was ported from.

## Notifications

Alerts go to [ntfy](https://ntfy.sh) — enter a topic in the app and subscribe to it in
the ntfy mobile app. This needs internet: iOS will not deliver a notification that
originated on the local network, since anything arriving with the app closed comes
through Apple's push service. The page also alarms locally on every fire, and reports
whether the POST actually got out.
