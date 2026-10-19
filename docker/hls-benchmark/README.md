# Immich HLS benchmark harness

These scripts drive the isolated `immich-hls-test` API and Chromium against a test-only asset. They are not a production load tool. Run them only with the benchmark override and an isolated test database/Valkey. Set `HLS_BENCHMARK_ASSET_ID` to an asset in the isolated fixture before running any script.

## Runtime

Use a Node.js environment with Playwright installed and Chromium available, plus access to the test API and the Immich Web Hls.js bundle. The scripts can run from a checkout mounted into the development Web container. They do not contain credentials; provide a token file outside the repository.

Environment variables:

- `HLS_BENCHMARK_ORIGIN`: API origin (default `http://127.0.0.1:2284`).
- `HLS_BENCHMARK_ASSET_ID`: required UUID of an asset in the isolated test library.
- `HLS_BENCHMARK_TOKEN_FILE`: path to a test-user token file (default `/tmp/hls-benchmark-token`).
- `HLS_BENCHMARK_HLSJS_PATH`: Immich Web Hls.js bundle (default `/workspace/web/node_modules/hls.js/dist/hls.min.js`).
- `HLS_BENCHMARK_RUNS`: repeat count, including 3 warmups (default 23).
- `HLS_BENCHMARK_PROXY_ORIGIN`: shared-rate-limit proxy origin (default `http://127.0.0.1:2285`).

Run `repeat.mjs` for three warmups plus 20 valid first-frame runs, `continuous.mjs` for 60 seconds of playback, and `seek.mjs` for seek and quality-switch observations. Each script attempts HLS session deletion at completion. Review output for errors before using the results.

## Isolated aggregate bandwidth proxy

`rate-limit-proxy.py` implements a shared token bucket across concurrent HTTP connections. Its defaults listen only on `127.0.0.1:2285`, forward to `172.17.0.1:2284`, cap aggregate response traffic at 3,000,000 bytes/s, and permit a 64,000-byte initial burst. Override with `HLS_BENCHMARK_PROXY_HOST`, `HLS_BENCHMARK_PROXY_PORT`, `HLS_BENCHMARK_BACKEND_HOST`, `HLS_BENCHMARK_BACKEND_PORT`, `HLS_BENCHMARK_RATE_BPS`, and `HLS_BENCHMARK_BURST_BYTES` when the isolated container network differs. Do not bind this proxy to a NAS-facing interface or change host-wide traffic control.

`proxy-throughput.mjs` sends 20 concurrent requests for the same segment and reports aggregate throughput. This measures the configured path; it does not simulate RTT, jitter, or loss.

## Interpretation

The browser scripts use a real `<video>` element, Hls.js, and `requestVideoFrameCallback`; this measures Chromium's decoded video frame callback, not the full signed-in Immich UI flow or display photon latency. Keep LAN and rate-limited measurements separate. Record commit, image, sample technical metadata/hash, storage, cache state, and run count alongside output. Never place private media, auth tokens, or identifying media paths in this repository.
