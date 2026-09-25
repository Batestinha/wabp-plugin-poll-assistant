# Poll Assistant

Durable group and private polls, editable publication and result messages, named or hidden ballots, and configured workflow outcomes.

Standalone WABS package `official.poll-assistant` version `0.7.4`, requiring WABP core API `^0.3.10`. It preserves the plugin ID, account-owned `polls` database, scoped settings, creation recipes, queue keys and receipt formats. Data version 9 adds durable pin and close-edit lifecycle state. Existing queued messages retain their text and recipients. Deploy a compatible reader before enabling new producers; an application downgrade must preserve writes accepted by the newer release.

Scope clocks supply default timezones. Existing UTC deadlines remain fixed. Poll messages use the original cutoff, even when result delivery is delayed. Templates support localized defaults, validation, conditional sections and pagination. Voter names only appear for named ballots; result names do not generate notification mentions.

WABP supplies database connections and migrations, scoped storage, workflow execution, authorization, transport and job persistence. This package contains the portable SDK, exact runtime dependencies, SQL migrations, Portuguese translations and an unmodified DOAS poll contract. Source commits, checksums and licenses are recorded in `provenance.json` and `contracts/`.

Run `npm ci --ignore-scripts`, `npm test` and `npm run release:archive`. CI tests Node 22.23.2 and 24.15.0, reproduces the archive twice and loads it outside the repository. Tests use local fixture databases and mocked effects. Installation and scope enablement are separate operations; trusted registry signatures identify immutable release bytes.

## Typed templates and WhatsApp mentions

Message editors support exact choice and text comparisons, numeric thresholds,
boolean values, availability checks, nested All/Any rules and Otherwise branches.
Existing bare conditions retain their original presence meaning. Comparisons use
canonical values separately from translated display text; missing values do not
satisfy negative comparisons, while zero and false remain available.

Type `@` in a supported message body or caption to insert a person, a group link,
or a contextual recipient. Group links and native all-members mentions are distinct;
the editor only offers targets supported by that destination. Mentions in hidden
branches do not resolve or notify anyone. Native poll titles/options, group names
and calendar text remain plain text. Durable delivery stores rendered text and
recipient metadata together so retries keep the original notification intent.

Publication notification settings migrate once to an Eligible voters mention chip,
preserving effective scope/identity overrides and custom prose. The host backs up
all original layers in the same transaction. `{{default}}` preserves the localized
default message; the old decorative `@all —` delivery notice prefix is removed.

The `Assistant proposal summary` and `Assistant proposal option row` settings
control the approval preview produced for new polls. The default summary uses
bold labels for each resolved setting, and the default option row begins
`1) - ...`. Existing approval messages retain their saved text and digest.

Poll message lifecycle settings are available in Poll Assistant settings. `Pin active
polls` pins the native group ballot (or the publication for private ballots) and
removes the managed pin on closure or when disabled. The `After closing` section
optionally edits the original publication with the existing variable, condition,
and mention editor. The close template exposes every publication field plus close
time, original publication, and result fields, so a publication template can be
copied and its state wording changed. WhatsApp's 15-minute editing window still applies; an expired
or rejected edit is audited and never interrupts poll results. Both options are
disabled by default, and their durable recovery state survives runtime restarts.
