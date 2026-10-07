namespace Petseo.Api.Settings;

public sealed class ApiSettings
{
    public required string ConnectionString { get; init; }

    public int TimeoutSeconds { get; init; } = 30;
}
