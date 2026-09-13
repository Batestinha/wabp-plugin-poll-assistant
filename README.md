# Poll Assistant

Version 0.4.2 is the compatible reader release for the transition to 0.5.0. It reads data version 6, including frozen mention recipients and activation suppression, while new publication and activation announcements retain the previous delivery format. Message editors become available in 0.5.0. Existing message settings written by that release remain loadable and preserved after rollback.

Deploy and rehearse this release before enabling 0.5.0 producers. This initial reader keeps the stored timezone behavior as well as the old publication format. Version 0.4.1 adopted the scope timezone too early for a safe initial rollback; use 0.4.2 for that transition. This package alone is not proof that a complete application, session, queue and database rollback is safe.

Durable group and private polls, named or hidden ballots, and configured workflow outcomes.

Standalone WABS package `official.poll-assistant` version `0.4.2`, requiring WABP core API `^0.3.0`. It preserves the plugin ID, account-owned `polls` database, scoped settings, creation recipes, queue keys and receipt formats. Data version 6 adds frozen mention recipients and durable activation-announcement suppression. Existing queued messages retain their text and recipients. An application downgrade must preserve writes accepted by the newer release.

Version 0.5.0 binds defaults to scope clocks. This transitional reader intentionally keeps its existing stored timezone so an initial rollback can recover announcement retries without a text conflict. Existing UTC deadlines remain fixed. Poll messages use the original cutoff, even when result delivery is delayed. Templates support localized defaults, validation, conditional sections and pagination. Voter names only appear for named ballots; result names do not generate notification mentions.

WABP supplies database connections and migrations, scoped storage, workflow execution, authorization, transport and job persistence. This package contains the portable SDK, exact runtime dependencies, SQL migrations, Portuguese translations and an unmodified DOAS poll contract. Source commits, checksums and licenses are recorded in `provenance.json` and `contracts/`.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, reproduces the archive twice and loads it outside the repository. Tests use local fixture databases and mocked effects. Installation and scope enablement are separate operations; trusted registry signatures identify immutable release bytes.
