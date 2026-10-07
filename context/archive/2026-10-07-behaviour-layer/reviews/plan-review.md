# Plan review: behaviour-layer

Verdict: approved.

- Covers both acceptance cases of issue #22: the response-change fixture and `stop` after a `test` timeout.
- `stop` and the background app stop sit in one `finally`, so a timeout, a start failure or a parse error cannot
  leak the stack.
- A test run without result files fails the layer instead of passing silently.
- Touches only a new folder, one registry line and README; low conflict risk with the parallel issue threads.
