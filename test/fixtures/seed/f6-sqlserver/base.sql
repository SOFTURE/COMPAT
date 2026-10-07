-- Seed data: runs on every deploy after migrations.sql.
SET NOCOUNT ON;
GO

IF NOT EXISTS (SELECT 1 FROM [dbo].[Breeds] WHERE [Id] = 1)
    INSERT INTO [dbo].[Breeds] ([Id], [Name], [Species]) VALUES (1, N'Labrador Retriever', N'Dog');
GO

MERGE INTO [dbo].[EmailTemplates] WITH (HOLDLOCK) AS [target]
USING (VALUES
    (101, N'Welcome', N'en', N'Welcome to PetSeo', N'Hello {{name}}, welcome aboard.'),
    (102, N'Welcome', N'en-GB', N'Welcome to PetSeo (UK)', N'Hi {{name}}, welcome.'),
    (201, N'PasswordReset', N'en', N'Reset your password', N'Use this link: {{link}}')
) AS [source] ([Id], [Type], [Language], [Subject], [Body])
ON [target].[Id] = [source].[Id]
WHEN MATCHED THEN
    UPDATE SET [Subject] = [source].[Subject], [Body] = [source].[Body]
WHEN NOT MATCHED BY TARGET THEN
    INSERT ([Id], [Type], [Language], [Subject], [Body])
    VALUES ([source].[Id], [source].[Type], [source].[Language], [source].[Subject], [source].[Body]);
GO
