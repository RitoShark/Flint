# Loadscreen generation metadata

`loadscreen_meta_16.18.json` is a subset of the JSON dump from
[LeagueToolkit release v16.18.8159717](https://github.com/LeagueToolkit/lol-meta-classes/releases/tag/v16.18.8159717).
It retains the properties and primary/secondary bases of the classes used by
animated loadscreen and banner generation, including their inherited classes.
Offsets and other property metadata are copied from the source, not inferred
from existing presets.

Generation prefers the metadata installed by the application's cached refresh.
This subset is the offline fallback when no downloaded metadata is available.
Only fields explicitly supplied by the presets are adapted; field order,
shader values, omitted defaults, paths, and project layout stay in the presets.
Missing fields or conversions that cannot preserve values stop generation with
an error identifying the metadata version, class, and field.

To update the fallback, copy these same classes and all their bases from a new
published dump and update the source/version fields. Run the `meta_schema` tests
in `flint-bin` and the `loadscreen` tests in `flint-core`. Existing loading-screen
projects can use Rebuild to replace their generated BIN; existing banners can
be reapplied to regenerate the material with current types.
