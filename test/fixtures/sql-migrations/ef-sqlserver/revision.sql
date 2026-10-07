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

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261005073152_AddMissingPetBreeds'
)
BEGIN
    IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [name] IN (N'Id', N'Name') AND [object_id] = OBJECT_ID(N'[Breeds]'))
        SET IDENTITY_INSERT [Breeds] ON;
    EXEC(N'INSERT INTO [Breeds] ([Id], [Name])
    VALUES (418, N''Breed 418''),
(419, N''Breed 419''),
(420, N''Breed 420''),
(421, N''Breed 421''),
(422, N''Breed 422''),
(423, N''Breed 423''),
(424, N''Breed 424''),
(425, N''Breed 425''),
(426, N''Breed 426''),
(427, N''Breed 427''),
(428, N''Breed 428''),
(429, N''Breed 429''),
(430, N''Breed 430''),
(431, N''Breed 431''),
(432, N''Breed 432''),
(433, N''Breed 433''),
(434, N''Breed 434''),
(435, N''Breed 435''),
(436, N''Breed 436''),
(437, N''Breed 437''),
(438, N''Breed 438''),
(439, N''Breed 439''),
(440, N''Breed 440''),
(441, N''Breed 441''),
(442, N''Breed 442''),
(443, N''Breed 443''),
(444, N''Breed 444''),
(445, N''Breed 445''),
(446, N''Breed 446''),
(447, N''Breed 447''),
(448, N''Breed 448''),
(449, N''Breed 449''),
(450, N''Breed 450''),
(451, N''Breed 451''),
(452, N''Breed 452''),
(453, N''Breed 453''),
(454, N''Breed 454''),
(455, N''Breed 455''),
(456, N''Breed 456''),
(457, N''Breed 457''),
(458, N''Breed 458''),
(459, N''Breed 459''),
(460, N''Breed 460''),
(461, N''Breed 461''),
(462, N''Breed 462''),
(463, N''Breed 463''),
(464, N''Breed 464''),
(465, N''Breed 465''),
(466, N''Breed 466''),
(467, N''Breed 467''),
(468, N''Breed 468''),
(469, N''Breed 469''),
(470, N''Breed 470''),
(471, N''Breed 471''),
(472, N''Breed 472''),
(473, N''Breed 473''),
(474, N''Breed 474''),
(475, N''Breed 475''),
(476, N''Breed 476''),
(477, N''Breed 477''),
(478, N''Breed 478''),
(479, N''Breed 479''),
(480, N''Breed 480''),
(481, N''Breed 481''),
(482, N''Breed 482''),
(483, N''Breed 483''),
(484, N''Breed 484''),
(485, N''Breed 485''),
(486, N''Breed 486''),
(487, N''Breed 487''),
(488, N''Breed 488''),
(489, N''Breed 489''),
(490, N''Breed 490''),
(491, N''Breed 491''),
(492, N''Breed 492''),
(493, N''Breed 493''),
(494, N''Breed 494''),
(495, N''Breed 495''),
(496, N''Breed 496'')');
    IF EXISTS (SELECT * FROM [sys].[identity_columns] WHERE [name] IN (N'Id', N'Name') AND [object_id] = OBJECT_ID(N'[Breeds]'))
        SET IDENTITY_INSERT [Breeds] OFF;
END;
GO

IF NOT EXISTS (
    SELECT * FROM [__EFMigrationsHistory]
    WHERE [MigrationId] = N'20261005073152_AddMissingPetBreeds'
)
BEGIN
    INSERT INTO [__EFMigrationsHistory] ([MigrationId], [ProductVersion])
    VALUES (N'20261005073152_AddMissingPetBreeds', N'8.0.10');
END;
GO

COMMIT;
GO
