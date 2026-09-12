# Poll Assistant

Durable group and private polls, editable publication and result messages, named or hidden ballots, and configured workflow outcomes.

Standalone WABS package `official.poll-assistant` version `0.5.0`, requiring WABP core API `^0.3.0`. It preserves the plugin ID, account-owned `polls` database, scoped settings, creation recipes, queue keys and receipt formats. Data version 6 adds frozen mention recipients and durable activation-announcement suppression. Existing queued messages retain their text and recipients. Deploy a compatible reader before enabling new producers; an application downgrade must preserve writes accepted by the newer release.

Scope clocks supply default timezones. Existing UTC deadlines remain fixed. Poll messages use the original cutoff, even when result delivery is delayed. Templates support localized defaults, validation, conditional sections and pagination. Voter names only appear for named ballots; result names do not generate notification mentions.

WABP supplies database connections and migrations, scoped storage, workflow execution, authorization, transport and job persistence. This package contains the portable SDK, exact runtime dependencies, SQL migrations, Portuguese translations and an unmodified DOAS poll contract. Source commits, checksums and licenses are recorded in `provenance.json` and `contracts/`.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, reproduces the archive twice and loads it outside the repository. Tests use local fixture databases and mocked effects. Installation and scope enablement are separate operations; trusted registry signatures identify immutable release bytes.
