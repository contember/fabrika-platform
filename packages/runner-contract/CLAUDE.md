# @fabrika/runner-contract

Provider-neutral Worker↔container transport schemas, types and endpoint constants. Types derive from
the zod schemas here. This package has no runtime implementation and does not own provider job semantics.

`RunLogLine` and `runLogLineSchema` are owned by `@fabrika/control-contract`; the type is re-exported here for transport consumers.
