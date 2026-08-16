The four `test` CI failures are the expected dependency-ordering situation, not a code defect:

`tests/shared/clientTracking.test.js` ("default tracked clients are supported by tokscale or a native adapter") verifies every entry in `DEFAULT_CLIENTS` against the **bundled tokscale** `--help` client list. CI installs the official `tokscale@4.13.0` from npm, which does not know `cherrystudio` yet — that support ships in the companion tokscale PR (junhoyeo/tokscale#1105, currently open). Once it lands and a new tokscale release is published, this PR upgrades the `tokscale` dependency and the check turns green; locally the same test passes against the pre-release binary.

No test is failing on the actual widget code — all other 2893 tests pass (the single remaining failure on this Windows box is the pre-existing symlink-privilege test).
