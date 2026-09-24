# Shodan in the local app

## Public camera viewer

Open **SHODAN → Public cameras** and search a city, street, or provider.
The viewer uses operator-published Austin, Caltrans and Transport for London
catalogs already integrated into the app. The first 100 matches receive cyan
map pins. Choose **Fly to & view snapshot**, or click a cyan pin, to move to
the published camera coordinates and load its image. Provider attribution is
shown with the image.

Images refresh every 10 seconds while viewing; these are periodically updated
snapshots, not continuous video. The retrieval time is shown separately from
the unknown camera capture time. **Stop viewing**, closing the panel, switching
to Shodan results, or hiding the browser tab stops refresh traffic. Unavailable
operator images are reported as unavailable: Street View and synthetic fallback
images are never shown as camera feeds in this viewer.

Each Shodan result links to its indexed record. **Find public cameras nearby**
looks for separate public cameras within 100 km of the approximate IP location;
it does not identify those cameras as the Shodan device. This operation uses no
additional Shodan credits. Arbitrary Shodan host addresses are not opened as
camera feeds. Additional authorized cameras require specific source configuration;
the public viewer currently includes only the three operator catalogs above.

## Shodan setup and requests

Open **POWER UP → SHODAN**, enter your existing API key and save. The app stores
it in its protected, ignored environment file. Never use a `VITE_` variable.

Open **◎ SHODAN**. Use **IP address** for a host lookup or **Search Shodan** for
a query such as `org:"Google" country:US`. Search is manual and returns the first
100 service observations. Search filters may consume query credits and require
an eligible Shodan plan: https://developer.shodan.io/api

Results show organizations, ports, detected products and observation times.
**Locate approximate position** moves the camera. Click an amber map point to
reopen its result. Toggle markers or clear results from the panel. IP geolocation
is approximate, missing coordinates stay unmapped, and observations are not a
live inventory or evidence of malicious activity.

The server calls only Shodan over HTTPS. Local routes accept same-origin JSON
POSTs, refuse remote/proxied callers, do not expose credentials or raw banners,
and return `Cache-Control: private, no-store`. Upstream requests have a 15-second
timeout and a 4 MiB response limit. Identical in-flight queries are shared;
successful results are cached in memory for 10 minutes (50 entries maximum).
Limits: one new upstream request per 2 seconds and 30 per server-process hour.
These limits reset when the server restarts. Only page 1 is fetched.

This integration is deliberately local-only, including under Vite preview.
Public or multi-instance deployment needs authentication and a shared credit
budget before enabling access. Status reports key presence, not validity.
