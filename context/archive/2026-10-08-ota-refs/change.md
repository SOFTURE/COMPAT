# Change: ota-refs

Source: issue #93. Client refs (`client-usage`, `error-codes`) gain an `optional` flag on object entries and an
`easUpdates` entry for over-the-air updates, resolved through a command.
Out of scope: proposal 3 (keeping a build next to the OTA update that supersedes it for the same runtime version);
a build listed in `refs` is already kept, so nothing is dropped today.
