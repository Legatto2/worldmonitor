# Unified World Monitor + God's Eye workspace

Run with Node.js 24:

```powershell
npm ci
npm --prefix vendor/gods-eye-view ci
node scripts/unified/start.mjs --env-file C:\path\to\your\existing\.env
```

Open http://localhost:4480 and choose **3D OPERATIONS**. Ports 4480 and 4481 bind only to loopback. Ctrl+C stops both servers. Do not expose this development launcher publicly.

## Included

- World Monitor dashboard, news, maps and existing analysis panels.
- On-demand God's Eye Cesium renderer with its native layers and controls.
- Validated location exchange in both directions, plus up to 500 observations per supported dataset (earthquakes, news, natural events, military flights, fires, outages).
- Shodan host/search panel, server-side key, approximate location markers and observation timestamps. No automatic paid searches.
- Public operator camera catalog and strict live-image viewer inherited from the local God's Eye integration.
- Direct USGS magnitude 2.5+ past-day earthquake feed for local operation; errors are reported as unavailable rather than invented data.

Close the 3D view to release its renderer. Dataset filters affect shared markers. Shodan and camera catalogs are separate: a nearby public camera is not evidence that it belongs to an IP address.

## Configuration and limits

The optional env-file argument borrows SHODAN_API_KEY, GOOGLE_MAPS_API_KEY and CESIUM_ION_TOKEN from an existing file without copying it. Shodan stays server-side. The parent origin is fixed to localhost:4480 and child origin to localhost:4481; bridge messages must match both origin and source window.

World Monitor's other optional paid APIs, account features and Railway/Redis seeded datasets still require their own configuration. This is a composed local application, not a replacement for those hosted services. Only six geolocated dataset types cross the bridge; all other dashboard features retain their original view. Camera availability depends on its operator. No arbitrary private-camera discovery or stream-path guessing is added.

## Provenance and licensing

World Monitor: https://github.com/koala73/worldmonitor at 9b0d54a8ac048cf6282ded0377e874bcb23ddeff, AGPL-3.0-only (root LICENSE).

God's Eye View: https://github.com/bilawalsidhu/gods-eye-view at 83df873879d4b4a7cdc7b345604ed3903ab80170 plus existing local Shodan/public-camera patches, vendored with its MIT LICENSE. New bridge patches are included in this branch.

Preserve both source notices. Third-party maps, imagery and datasets retain their own terms; the code licenses do not grant unrestricted rights to those services or data.

## Verification

Run `npm run typecheck`, `npm run lint:boundaries`, and `node --test tests/unified-bridge.test.mjs tests/unified-earthquakes.test.mjs`. Build dashboard with `VITE_UNIFIED_GLOBE_ORIGIN=http://localhost:4481` and `vite build --config vite.unified.config.ts`; build the vendor with `GEV_PARENT_ORIGIN=http://localhost:4480` and its normal build command. Both origins must match the serving arrangement. The development launcher is the supported local entry point.

## Local UI and expanded Shodan tools

Local mode suppresses account controls, Pro banners, pricing links and upgrade calls to action. Hosted-only services remain unavailable until configured; no hosted entitlement is bypassed.

Shodan now offers account/credit status, explicit result pages 1–100, count/facet summaries, host history (bounded to 100 service observations), ASN/ISP/OS/domains/tags, HTTP titles, TLS identity/expiry, indexed CVE IDs, host-detail drill-down and JSON export. Each request remains manual, same-origin and server-side; the existing 30/hour local budget and Shodan plan limits apply. Count summaries use Shodan's documented query-credit-free count endpoint. See https://developer.shodan.io/api.

After loading the public camera catalog, camera markers remain on the globe when the panel closes. Clicking a marker reopens the viewer and starts its operator snapshot refresh. Closing the viewer stops refresh requests. This is a periodically refreshed image, not a continuous video stream. Shodan marker clicks show host details; no indexed service is automatically treated as a playable camera stream.
