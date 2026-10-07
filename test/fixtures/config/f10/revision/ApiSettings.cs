namespace Petseo.Api.Settings;

public sealed class ApiSettings
{
    public required string ConnectionString { get; init; }

    public int TimeoutSeconds { get; init; } = 30;

    // public required string LegacyToken { get; init; }
    public required string ShopBaseUrl { get; init; }

    /* public required string Unused { get; init; } */
    public required string ShopApiKey { get; init; }
}
