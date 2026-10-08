# Change: outbound-calls

Source: issue #111. Report external API hosts and paths the revision starts calling with a credential production
already has (PETSEO 2.2.4 → 2.3.7: `GoogleGeoLocationResolver` calls `geocode/json` with the Places key).

Acceptance:
1. a host or path captured at the revision and not at the base is `outbound-added`, `needs-action`, with the evidence line;
2. one captured only at the base is `outbound-removed`, `safe`;
3. `accept` by target glob with a reason;
4. declarative and git-only, like the `error-codes` sources.
