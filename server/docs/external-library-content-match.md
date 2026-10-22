# External library content matching (experimental)

Only the Immich server fork is modified. This feature lets an unchanged iOS client match byte-identical local photos with preexisting assets in an external library. It does not delete, upload or download photos.

## Flags

- `IMMICH_EXTERNAL_CONTENT_HASH_INDEX=true`: hash external originals during the existing Library Scan jobs. **Default: false**.
- `IMMICH_EXTERNAL_CONTENT_HASH_SYNC=true`: publish verified content SHA1 through the existing mobile asset-sync checksum field. **Default: false**.

Keep both flags off for production until the isolated test passes. There is no automatic bulk scan at container startup.

## Isolated test procedure

1. Build this branch into an isolated server with its own PostgreSQL, Valkey and media paths. Mount a small external photo test directory as **read-only**.
2. Enable `IMMICH_EXTERNAL_CONTENT_HASH_INDEX=true`, keep `IMMICH_EXTERNAL_CONTENT_HASH_SYNC=false`, and restart the isolated server.
3. Create an external library with 10-20 sample photos also in the iPhone photo library. From the Immich admin UI, run **Scan Library**. Wait for the jobs to finish.
4. Confirm logs show `External content hashing:`. Repeat the scan: unchanged files should count as reused and must not be re-read for SHA1.
5. Set `IMMICH_EXTERNAL_CONTENT_HASH_SYNC=true` and restart the isolated server. Run **Scan Library** again to publish cached hashes and refresh `asset.updateId`.
6. Open the official iOS client, wait for server sync and local hashing, and confirm byte-identical files appear as both local and remote, without a duplicate upload.
7. Verify a byte-different edited version does not match, and the same photo in two external paths does not become ambiguously linked. Confirm other users' photos never match.
8. Keep iPhone media and iCloud Photos intact. Do not change production mounts to rw.

## Lifecycle and rollback

- The existing external library scan now computes one hash at a time **within each batch**. Multiple scan jobs or containers may overlap, so reduce library job concurrency before indexing a large HDD library.
- Each checksum cache record stores SHA1, source size, `mtimeMs`, and whether its digest is published. If a file changes, the next scan recalculates it.
- Switching publication on or off requires running **Scan Library** with indexing enabled. That refreshes `asset.updateId` so the unchanged client can receive the revised checksum.
- Sync SQL maps only published content fingerprints that have no same-owner collision with another indexed external asset or an already uploaded asset.
- To roll back, leave indexing enabled, switch publishing off and run Library Scan once. Then disable indexing and restore the previous server image.

## Limitations

- Only byte-identical files match. Edited exports, optimized iCloud files, HEIC conversions, some Live Photos and files absent from the iPhone will not necessarily match.
- Upload preflight duplicate detection is not modified. If a client starts uploading before it receives the mapped checksum, it may still upload a duplicate.
- No production benchmark exists. The conservative SQL duplicate check can be expensive at large photo counts.
- Source-level tests were added, but neither build nor iOS/NAS integration tests have been executed in this chat environment.
