-- Shape of `dotnet ef migrations script --idempotent` output, EF Core 8 with SqlServer.
IF OBJECT_ID(N'[__EFMigrationsHistory]') IS NULL
BEGIN
    CREATE TABLE [__EFMigrationsHistory] (
        [MigrationId] nvarchar(150) NOT NULL,
        [ProductVersion] nvarchar(32) NOT NULL,
        CONSTRAINT [PK___EFMigrationsHistory] PRIMARY KEY ([MigrationId])
    );
END;
GO

BEGIN TRANSACTION;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260901000000_Init'
)
BEGIN
    CREATE TABLE [Breeds] (
        [Id] int NOT NULL IDENTITY,
        [Name] nvarchar(max) NOT NULL,
        CONSTRAINT [PK_Breeds] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20260901000000_Init'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20260901000000_Init', N'8.0.10');
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261001000000_AddFeatureFlags'
)
BEGIN
    IF SCHEMA_ID(N'system') IS NULL EXEC(N'CREATE SCHEMA [system];');
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261001000000_AddFeatureFlags'
)
BEGIN
    CREATE TABLE [system].[FeatureFlags] (
        [Id] uniqueidentifier NOT NULL,
        [Key] nvarchar(100) NOT NULL,
        [IsEnabled] bit NOT NULL,
        CONSTRAINT [PK_FeatureFlags] PRIMARY KEY ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261001000000_AddFeatureFlags'
)
BEGIN
    CREATE UNIQUE INDEX [IX_FeatureFlags_Key] ON [system].[FeatureFlags] ([Key]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261001000000_AddFeatureFlags'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261001000000_AddFeatureFlags', N'8.0.10');
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261002000000_AddNotificationBroadcasts'
)
BEGIN
    IF SCHEMA_ID(N'notifications') IS NULL EXEC(N'CREATE SCHEMA [notifications];');
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261002000000_AddNotificationBroadcasts'
)
BEGIN
    CREATE TABLE [notifications].[NotificationBroadcasts] (
        [Id] uniqueidentifier NOT NULL,
        [BreedId] int NULL,
        [Title] nvarchar(450) NOT NULL,
        [CreatedAt] datetimeoffset NOT NULL,
        CONSTRAINT [PK_NotificationBroadcasts] PRIMARY KEY ([Id]),
        CONSTRAINT [FK_NotificationBroadcasts_Breeds_BreedId] FOREIGN KEY ([BreedId]) REFERENCES [Breeds] ([Id])
    );
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261002000000_AddNotificationBroadcasts'
)
BEGIN
    CREATE INDEX [IX_NotificationBroadcasts_BreedId] ON [notifications].[NotificationBroadcasts] ([BreedId]);
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261002000000_AddNotificationBroadcasts'
)
BEGIN
    EXEC(N'CREATE UNIQUE INDEX [IX_NotificationBroadcasts_Title] ON [notifications].[NotificationBroadcasts] ([Title]) WHERE [Title] IS NOT NULL');
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261002000000_AddNotificationBroadcasts'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261002000000_AddNotificationBroadcasts', N'8.0.10');
END;
GO

COMMIT;
GO
