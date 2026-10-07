-- Seed data: runs on every deploy after migrations.sql.

INSERT INTO "Breeds" ("Id", "Name", "Species")
VALUES
    (1, 'Labrador Retriever', 'Dog'),
    (2, 'Maine Coon', 'Cat'),
    (3, 'Border Collie', 'Dog')
ON CONFLICT ("Id") DO NOTHING;

INSERT INTO "EmailTemplates" ("Id", "Type", "Language", "Subject", "Body")
VALUES
    (101, 'Welcome', 'en', 'Welcome to PetSeo', 'Hello {{name}}, welcome aboard.'),
    (102, 'Welcome', 'en-GB', 'Welcome to PetSeo (UK)', 'Hi {{name}}, welcome.'),
    (201, 'PasswordReset', 'en', 'Reset your password', 'Use this link: {{link}}')
ON CONFLICT ("Id") DO UPDATE
SET "Subject" = EXCLUDED."Subject",
    "Body" = EXCLUDED."Body";

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM "FeatureSwitches" WHERE "Key" = 'b2b-invoices') THEN
        INSERT INTO "FeatureSwitches" ("Key", "Enabled") VALUES ('b2b-invoices', false);
    END IF;
END $$;
