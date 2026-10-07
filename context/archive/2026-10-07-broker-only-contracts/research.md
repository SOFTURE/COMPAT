# Research: broker-only-contracts

- `src/commands/init.ts` `detectMessageContracts` lists `**/*Contract*/**/*.cs` and `**/*Messages/**/*.cs` and
  enables one glob per outermost matching folder. It reads no file content, so HTTP DTO projects named
  `*.Contract.*.Requests` qualify.
- MassTransit names a message type in `IConsumer<T>`, `ConsumeContext<T>`, `IRequestClient<T>`,
  `Publish<T>(...)`, `Send<T>(...)`, and in `Publish(new T ...)` / `Send(new T ...)`. Those are the broker
  references init can read from the committed files at HEAD.
- `src/layers/message-contracts/compare-contracts.ts` `compareType` emits the nullability change with one fixed
  text. The type text is the source spelling (`List<DayOfWeek>?`, `int?`, `Ns.Status?`). Value types are the C#
  numeric/bool/char keywords, BCL structs (`DateTime`, `DateTimeOffset`, `DateOnly`, `TimeOnly`, `TimeSpan`,
  `Guid`), tuples, and the enums, structs and record structs declared in the sources. `string`, `object`,
  arrays, generic collections and classes/records/interfaces of the sources are reference types. Anything else
  (a type from another assembly) is unknown.
